package com.example.data.repository

import android.content.Context
import com.example.data.model.*
import com.example.data.network.TaskitatorWorkerApi
import com.example.data.util.CriteriaValidator
import com.example.data.util.DateUtils
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Calendar
import java.util.UUID

class TaskRepository(private val context: Context) {
    private val scope = CoroutineScope(Dispatchers.IO)

    private val snapshotFile = File(context.filesDir, "taskitator_snapshot_raw.json")
    private val baseSnapshotFile = File(context.filesDir, "taskitator_base_snapshot.json")
    private val notesFile = File(context.filesDir, "taskitator_distractions_v2.json")
    private val backupFile = File(context.filesDir, "taskitator_conflict_backup.json")

    private val _tasks = MutableStateFlow<List<Task>>(emptyList())
    val tasks: StateFlow<List<Task>> = _tasks.asStateFlow()

    private val _settings = MutableStateFlow(UserSettings())
    val settings: StateFlow<UserSettings> = _settings.asStateFlow()

    private val _savedCriteria = MutableStateFlow<List<SavedCriteria>>(emptyList())
    val savedCriteria: StateFlow<List<SavedCriteria>> = _savedCriteria.asStateFlow()

    private val _breakPlanning = MutableStateFlow(BreakPlanningState())
    val breakPlanning: StateFlow<BreakPlanningState> = _breakPlanning.asStateFlow()

    private val _breaks = MutableStateFlow<List<BreakSession>>(emptyList())
    val breaks: StateFlow<List<BreakSession>> = _breaks.asStateFlow()

    private val _notes = MutableStateFlow<List<DistractionNote>>(emptyList())
    val notes: StateFlow<List<DistractionNote>> = _notes.asStateFlow()

    private val _pomodoro = MutableStateFlow(PomodoroState())
    val pomodoro: StateFlow<PomodoroState> = _pomodoro.asStateFlow()

    // 10-second undo grace period state
    private val _lastCompletedTask = MutableStateFlow<Task?>(null)
    val lastCompletedTask: StateFlow<Task?> = _lastCompletedTask.asStateFlow()

    // Conflict state on 409
    private val _syncConflict = MutableStateFlow<Pair<List<Task>, JSONObject>?>(null)
    val syncConflict: StateFlow<Pair<List<Task>, JSONObject>?> = _syncConflict.asStateFlow()

    private var rawSnapshot: JSONObject = JSONObject()
    private var baseVersion: Long = 0L

    init {
        loadData()
    }

    private fun loadData() {
        if (snapshotFile.exists()) {
            try {
                val jsonStr = snapshotFile.readText()
                rawSnapshot = JSONObject(jsonStr)
                baseVersion = rawSnapshot.optLong("version", rawSnapshot.optLong("base_version", 0L))
                parseSnapshot(rawSnapshot)
                // If existing local file has version > 0, initial pull already completed
                _settings.value = _settings.value.copy(needsInitialPull = baseVersion == 0L)
            } catch (e: Exception) {
                initDefaultSnapshot()
            }
        } else {
            initDefaultSnapshot()
        }

        _notes.value = readNotesAndCleanup()
        checkEmergencyBypassCycleReset()
    }

    private fun initDefaultSnapshot() {
        rawSnapshot = JSONObject().apply {
            put("app", "taskitator")
            put("username", "Focus Champion")
            put("updated_at", System.currentTimeMillis())
            put("force", false)
            put("recurrence_state", JSONObject())
            put("recurrence_schema", 1)
            put("tasks", JSONArray())
            put("projects", JSONArray())
            put("settings", JSONObject())
            put("today_breaks", JSONObject())
            put("completed_audit_ledger", JSONArray())
            put("saved_criteria", JSONArray())
            put("last_login", System.currentTimeMillis())
        }

        // Strict invariant: NO DEMO TASKS.
        _tasks.value = emptyList()
        _settings.value = UserSettings(needsInitialPull = true)
        saveLocalSnapshot()
    }

    private fun parseSnapshot(json: JSONObject) {
        // 1. Settings
        val settingsObj = json.optJSONObject("settings") ?: JSONObject()
        val customPrioList = mutableListOf<CustomPriority>()
        val customPrioArr = settingsObj.optJSONArray("custom_priorities")
        if (customPrioArr != null && customPrioArr.length() > 0) {
            for (i in 0 until customPrioArr.length()) {
                val p = customPrioArr.getJSONObject(i)
                customPrioList.add(
                    CustomPriority(
                        id = p.getString("id"),
                        label = p.getString("label"),
                        rank = p.getInt("rank"),
                        colorHex = p.optString("color", "#3B82F6")
                    )
                )
            }
        } else {
            customPrioList.addAll(DEFAULT_PRIORITIES)
        }

        val customTagsList = mutableListOf<String>()
        val tagsArr = settingsObj.optJSONArray("custom_tags")
        if (tagsArr != null && tagsArr.length() > 0) {
            for (i in 0 until tagsArr.length()) {
                customTagsList.add(tagsArr.getString(i))
            }
        } else {
            customTagsList.addAll(DEFAULT_TAGS)
        }

        _settings.value = UserSettings(
            username = json.optString("username", "Focus Champion"),
            copilotName = settingsObj.optString("copilot_name", "Ari"),
            isPro = settingsObj.optBoolean("is_pro", false),
            useByok = settingsObj.optBoolean("use_byok", false),
            dayStartHour = settingsObj.optInt("day_start_hour", 0).coerceIn(0, 4),
            weekendStart = settingsObj.optInt("weekend_start", 5),
            weekendEnd = settingsObj.optInt("weekend_end", 6),
            breakTimezone = settingsObj.optString("break_timezone", "UTC"),
            dumpDurationSeconds = settingsObj.optInt("dump_duration", 90).coerceIn(30, 300),
            strictCriteriaValidation = settingsObj.optBoolean("strict_criteria_validation", true),
            soundEffectsEnabled = settingsObj.optBoolean("sound_effects_enabled", true),
            hapticsEnabled = settingsObj.optBoolean("haptics_enabled", true),
            emergencyBypassUsesRemaining = settingsObj.optInt("emergency_bypass_uses", 4),
            emergencyBypassActive = settingsObj.optBoolean("emergency_bypass_active", false),
            emergencyBypassUntil = settingsObj.optLong("emergency_bypass_until", 0L),
            customPriorities = customPrioList,
            customTags = customTagsList,
            remoteVersion = baseVersion
        )

        // 2. Tasks
        val tasksArr = json.optJSONArray("tasks") ?: JSONArray()
        val loadedTasks = mutableListOf<Task>()
        for (i in 0 until tasksArr.length()) {
            val t = tasksArr.getJSONObject(i)
            val tags = mutableListOf<String>()
            val tArr = t.optJSONArray("tags")
            if (tArr != null) {
                for (j in 0 until tArr.length()) tags.add(tArr.getString(j))
            }

            val unmapped = mutableMapOf<String, Any?>()
            val iter = t.keys()
            val known = setOf("id", "parent_id", "title", "raw_title", "description", "due_date", "priority_id", "tags", "status", "ai_locked", "proof_criteria", "raw_proof_criteria", "strict_prerequisites", "is_bonus", "created_at", "completed_at", "order_index")
            while (iter.hasNext()) {
                val k = iter.next()
                if (k !in known) unmapped[k] = t.opt(k)
            }

            val statusStr = t.optString("status", "active").lowercase()
            val status = when (statusStr) {
                "completed" -> TaskStatus.COMPLETED
                "trash" -> TaskStatus.TRASH
                else -> TaskStatus.ACTIVE
            }

            loadedTasks.add(
                Task(
                    id = t.optString("id", UUID.randomUUID().toString()),
                    parentId = t.optString("parent_id").takeIf { it.isNotBlank() },
                    title = t.optString("title", ""),
                    rawTitle = t.optString("raw_title", t.optString("title", "")),
                    description = t.optString("description", ""),
                    dueDate = t.optString("due_date", ""),
                    priorityId = t.optString("priority_id", "prio_med"),
                    tags = tags,
                    status = status,
                    aiLocked = t.optBoolean("ai_locked", false),
                    auditApproved = t.optBoolean("audit_approved", false),
                    proofCriteria = t.optString("proof_criteria", ""),
                    rawProofCriteria = t.optString("raw_proof_criteria", ""),
                    requireAllSubtasksFirst = t.optBoolean("strict_prerequisites", false),
                    isBonus = t.optBoolean("is_bonus", false),
                    smartEarlyDate = t.optString("smart_early_date").takeIf { it.isNotBlank() },
                    projectId = t.optString("project_id").takeIf { it.isNotBlank() },
                    createdAt = t.optLong("created_at", System.currentTimeMillis()),
                    completedAt = t.optLong("completed_at").takeIf { it > 0 },
                    orderIndex = t.optInt("order_index", i),
                    unmappedFields = unmapped
                )
            )
        }
        _tasks.value = loadedTasks

        // 3. Saved Criteria
        val scArr = json.optJSONArray("saved_criteria") ?: JSONArray()
        val scList = mutableListOf<SavedCriteria>()
        for (i in 0 until scArr.length()) {
            val sc = scArr.getJSONObject(i)
            scList.add(
                SavedCriteria(
                    id = sc.optString("id", UUID.randomUUID().toString()),
                    title = sc.optString("title", ""),
                    criteria = sc.optString("criteria", ""),
                    score = sc.optInt("score", 9),
                    hasExemplar = sc.optBoolean("has_exemplar", false),
                    exemplar = sc.optString("exemplar").takeIf { it.isNotBlank() },
                    createdAt = sc.optLong("created_at", System.currentTimeMillis())
                )
            )
        }
        _savedCriteria.value = scList
    }

    /**
     * Serializes current state into the raw snapshot tree, preserving all unknown top-level and nested fields.
     */
    private fun saveLocalSnapshot() {
        val s = _settings.value

        // Update settings in rawSnapshot
        val settingsObj = rawSnapshot.optJSONObject("settings") ?: JSONObject()
        settingsObj.put("copilot_name", s.copilotName)
        settingsObj.put("is_pro", s.isPro)
        settingsObj.put("use_byok", s.useByok)
        settingsObj.put("day_start_hour", s.dayStartHour)
        settingsObj.put("weekend_start", s.weekendStart)
        settingsObj.put("weekend_end", s.weekendEnd)
        settingsObj.put("break_timezone", s.breakTimezone)
        settingsObj.put("dump_duration", s.dumpDurationSeconds)
        settingsObj.put("strict_criteria_validation", s.strictCriteriaValidation)
        settingsObj.put("sound_effects_enabled", s.soundEffectsEnabled)
        settingsObj.put("haptics_enabled", s.hapticsEnabled)
        settingsObj.put("emergency_bypass_uses", s.emergencyBypassUsesRemaining)
        settingsObj.put("emergency_bypass_active", s.emergencyBypassActive)
        settingsObj.put("emergency_bypass_until", s.emergencyBypassUntil)

        val cpArr = JSONArray()
        s.customPriorities.forEach { p ->
            cpArr.put(JSONObject().apply {
                put("id", p.id)
                put("label", p.label)
                put("rank", p.rank)
                put("color", p.colorHex)
            })
        }
        settingsObj.put("custom_priorities", cpArr)

        val ctArr = JSONArray()
        s.customTags.forEach { ctArr.put(it) }
        settingsObj.put("custom_tags", ctArr)

        rawSnapshot.put("settings", settingsObj)
        rawSnapshot.put("username", s.username)
        rawSnapshot.put("updated_at", System.currentTimeMillis())

        // Update tasks in rawSnapshot
        val tasksArr = JSONArray()
        _tasks.value.forEach { t ->
            val obj = JSONObject()
            // restore unmapped fields first
            t.unmappedFields.forEach { (k, v) -> obj.put(k, v) }

            obj.put("id", t.id)
            if (t.parentId != null) obj.put("parent_id", t.parentId) else obj.remove("parent_id")
            obj.put("title", t.title)
            obj.put("raw_title", t.rawTitle)
            obj.put("description", t.description)
            obj.put("due_date", t.dueDate)
            obj.put("priority_id", t.priorityId)
            obj.put("tags", JSONArray(t.tags))
            obj.put("status", t.status.name.lowercase())
            obj.put("ai_locked", t.aiLocked)
            obj.put("audit_approved", t.auditApproved)
            obj.put("proof_criteria", t.proofCriteria)
            obj.put("raw_proof_criteria", t.rawProofCriteria)
            obj.put("strict_prerequisites", t.requireAllSubtasksFirst)
            obj.put("is_bonus", t.isBonus)
            if (t.smartEarlyDate != null) obj.put("smart_early_date", t.smartEarlyDate)
            if (t.projectId != null) obj.put("project_id", t.projectId)
            obj.put("created_at", t.createdAt)
            if (t.completedAt != null) obj.put("completed_at", t.completedAt)
            obj.put("order_index", t.orderIndex)

            tasksArr.put(obj)
        }
        rawSnapshot.put("tasks", tasksArr)

        // Update saved_criteria in rawSnapshot
        val scArr = JSONArray()
        _savedCriteria.value.forEach { sc ->
            scArr.put(JSONObject().apply {
                put("id", sc.id)
                put("title", sc.title)
                put("criteria", sc.criteria)
                put("score", sc.score)
                put("has_exemplar", sc.hasExemplar)
                if (sc.exemplar != null) put("exemplar", sc.exemplar)
                put("created_at", sc.createdAt)
            })
        }
        rawSnapshot.put("saved_criteria", scArr)

        snapshotFile.writeText(rawSnapshot.toString(2))
    }

    // --- Task Engine & Tree Hierarchy ---

    fun isDescendant(potentialChildId: String, ancestorId: String): Boolean {
        if (potentialChildId == ancestorId) return true
        val tasksById = _tasks.value.associateBy { it.id }
        var current = tasksById[potentialChildId]
        while (current?.parentId != null) {
            if (current.parentId == ancestorId) return true
            current = tasksById[current.parentId]
        }
        return false
    }

    fun hasNestedRecurrence(taskId: String, newParentId: String?): Boolean {
        val tasksById = _tasks.value.associateBy { it.id }
        val target = tasksById[taskId] ?: return false
        if (target.recurrence == RecurrenceRule.NONE) return false

        // Check if any ancestor is recurring
        var curParent = newParentId?.let { tasksById[it] }
        while (curParent != null) {
            if (curParent.recurrence != RecurrenceRule.NONE) return true
            curParent = curParent.parentId?.let { tasksById[it] }
        }

        // Check if any descendant is recurring
        val descendants = getDescendants(taskId)
        return descendants.any { it.recurrence != RecurrenceRule.NONE }
    }

    private fun getDescendants(parentId: String): List<Task> {
        val list = mutableListOf<Task>()
        val children = _tasks.value.filter { it.parentId == parentId && it.status != TaskStatus.TRASH }
        for (child in children) {
            list.add(child)
            list.addAll(getDescendants(child.id))
        }
        return list
    }

    fun upsertTask(task: Task): Pair<Boolean, String?> {
        // Cycle detection
        if (task.parentId != null && isDescendant(task.parentId, task.id)) {
            return Pair(false, "Invalid hierarchy: A task cannot be a subtask of itself or its descendants.")
        }

        // Nested recurrence check
        if (hasNestedRecurrence(task.id, task.parentId)) {
            return Pair(false, "Nested recurrence is not permitted: A recurring task cannot have a recurring ancestor or descendant.")
        }

        val current = _tasks.value.toMutableList()
        val index = current.indexOfFirst { it.id == task.id }
        if (index >= 0) {
            current[index] = task
        } else {
            current.add(task)
        }
        _tasks.value = current
        saveLocalSnapshot()
        return Pair(true, null)
    }

    fun toggleTaskCompletion(taskId: String): Pair<Boolean, String?> {
        val current = _tasks.value.toMutableList()
        val index = current.indexOfFirst { it.id == taskId }
        if (index < 0) return Pair(false, "Task not found.")

        val task = current[index]
        if (task.status == TaskStatus.COMPLETED) {
            // Un-complete
            current[index] = task.copy(status = TaskStatus.ACTIVE, completedAt = null, auditApproved = false)
            _tasks.value = current
            saveLocalSnapshot()
            return Pair(true, null)
        }

        // Rule 8.6: AI-locked tasks cannot be completed locally without approved audit
        if (task.aiLocked && !task.auditApproved) {
            return Pair(false, "AI-locked task cannot be completed without an approved evidence audit.")
        }

        // Shield check: all non-bonus subtasks must be completed
        val isBypass = _settings.value.emergencyBypassActive
        if (task.requireAllSubtasksFirst && !isBypass) {
            val descendants = getDescendants(task.id)
            val uncompletedNonBonus = descendants.filter { !it.isBonus && it.status != TaskStatus.COMPLETED }
            if (uncompletedNonBonus.isNotEmpty()) {
                return Pair(false, "Shield active: All subtasks must be completed before completing '${task.title}'.")
            }
        }

        // Mark completed and cascade
        val now = System.currentTimeMillis()
        val updated = task.copy(status = TaskStatus.COMPLETED, completedAt = now)
        current[index] = updated

        // Cascade completion to branch (VERIFIED 8.6)
        val descendants = getDescendants(task.id)
        for (d in descendants) {
            val dIndex = current.indexOfFirst { it.id == d.id }
            if (dIndex >= 0 && current[dIndex].status != TaskStatus.COMPLETED) {
                current[dIndex] = current[dIndex].copy(status = TaskStatus.COMPLETED, completedAt = now)
            }
        }

        _tasks.value = current
        _lastCompletedTask.value = updated
        saveLocalSnapshot()
        return Pair(true, null)
    }

    fun undoCompletion(taskId: String) {
        val current = _tasks.value.toMutableList()
        val index = current.indexOfFirst { it.id == taskId }
        if (index >= 0) {
            current[index] = current[index].copy(status = TaskStatus.ACTIVE, completedAt = null)
            _tasks.value = current
            _lastCompletedTask.value = null
            saveLocalSnapshot()
        }
    }

    fun trashBranch(taskId: String): Pair<Boolean, String?> {
        val current = _tasks.value.toMutableList()
        val index = current.indexOfFirst { it.id == taskId }
        if (index < 0) return Pair(false, "Task not found.")

        val task = current[index]
        val isBypass = _settings.value.emergencyBypassActive
        // Rule 8.7: Deleting an AI-locked task or shielded task with pending subtree is blocked unless bypass
        if (!isBypass) {
            if (task.aiLocked && task.status == TaskStatus.ACTIVE) {
                return Pair(false, "Deleting an active AI-locked task is blocked unless Emergency Bypass is active.")
            }
            if (task.requireAllSubtasksFirst) {
                val descendants = getDescendants(task.id)
                if (descendants.any { it.status == TaskStatus.ACTIVE }) {
                    return Pair(false, "Deleting a shielded task with active subtasks is blocked unless Emergency Bypass is active.")
                }
            }
        }

        val allToTrash = listOf(task.id) + getDescendants(task.id).map { it.id }
        for (i in current.indices) {
            if (current[i].id in allToTrash) {
                current[i] = current[i].copy(status = TaskStatus.TRASH)
            }
        }
        _tasks.value = current
        saveLocalSnapshot()
        return Pair(true, null)
    }

    fun confirmAuditApproval(taskId: String, feedback: String) {
        val current = _tasks.value.toMutableList()
        val index = current.indexOfFirst { it.id == taskId }
        if (index >= 0) {
            current[index] = current[index].copy(
                auditApproved = true,
                status = TaskStatus.COMPLETED,
                completedAt = System.currentTimeMillis()
            )
            _tasks.value = current
            saveLocalSnapshot()
        }
    }

    fun restoreTask(taskId: String) {
        val current = _tasks.value.toMutableList()
        val index = current.indexOfFirst { it.id == taskId }
        if (index >= 0) {
            current[index] = current[index].copy(status = TaskStatus.ACTIVE)
            _tasks.value = current
            saveLocalSnapshot()
        }
    }

    fun permanentlyDeleteTask(taskId: String) {
        _tasks.value = _tasks.value.filter { it.id != taskId }
        saveLocalSnapshot()
    }

    fun emptyTrash() {
        _tasks.value = _tasks.value.filter { it.status != TaskStatus.TRASH }
        saveLocalSnapshot()
    }

    // --- Emergency Bypass (12.3) ---

    fun activateEmergencyBypassLocally(): Pair<Boolean, String> {
        val s = _settings.value
        if (s.emergencyBypassUsesRemaining > 0) {
            val until = System.currentTimeMillis() + 15 * 60 * 1000L
            _settings.value = s.copy(
                emergencyBypassActive = true,
                emergencyBypassUntil = until,
                emergencyBypassUsesRemaining = s.emergencyBypassUsesRemaining - 1
            )
            saveLocalSnapshot()
            return Pair(true, "Emergency Bypass active for 15 minutes.")
        } else {
            return Pair(false, "Emergency Bypass uses exhausted for this weekly cycle.")
        }
    }

    fun addBreak(type: BreakType, duration: Int) {
        val current = _breaks.value.toMutableList()
        current.add(0, BreakSession(type = type, durationMinutes = duration))
        _breaks.value = current
    }

    fun evaluatePhoneAccess(): PhoneAccessDecision {
        val isBypass = _settings.value.emergencyBypassActive
        if (isBypass) return PhoneAccessDecision(allowed = true, reason = "Emergency Bypass active.")
        val todayStr = DateUtils.getLogicalDate(_settings.value.dayStartHour)
        val tasksById = _tasks.value.associateBy { it.id }
        val pendingActive = _tasks.value.any {
            it.status == TaskStatus.ACTIVE && DateUtils.getEffectiveDueDate(it, tasksById).let { d -> d.isBlank() || d <= todayStr }
        }
        return if (!pendingActive) {
            PhoneAccessDecision(allowed = true, reason = "All scheduled focus tasks completed for today.")
        } else {
            PhoneAccessDecision(allowed = false, reason = "Active tasks pending in today's queue.")
        }
    }

    private fun checkEmergencyBypassCycleReset() {
        val s = _settings.value
        if (s.emergencyBypassUntil > 0 && System.currentTimeMillis() > s.emergencyBypassUntil) {
            _settings.value = s.copy(emergencyBypassActive = false, emergencyBypassUntil = 0L)
            saveLocalSnapshot()
        }
    }

    // --- Pomodoro (12.2) Local Only ---

    fun startPomodoro() {
        _pomodoro.value = _pomodoro.value.copy(isRunning = true)
    }

    fun pausePomodoro() {
        _pomodoro.value = _pomodoro.value.copy(isRunning = false)
    }

    fun resetPomodoro() {
        val s = _settings.value
        val sec = when (_pomodoro.value.mode) {
            PomodoroMode.WORK -> s.workDurationMinutes * 60
            PomodoroMode.SHORT_BREAK -> s.shortBreakMinutes * 60
            PomodoroMode.LONG_BREAK -> s.longBreakMinutes * 60
        }
        _pomodoro.value = _pomodoro.value.copy(remainingSeconds = sec, isRunning = false)
    }

    fun tickPomodoro() {
        val current = _pomodoro.value
        if (!current.isRunning) return
        if (current.remainingSeconds > 0) {
            _pomodoro.value = current.copy(remainingSeconds = current.remainingSeconds - 1)
        } else {
            if (current.mode == PomodoroMode.WORK) {
                val newSessions = current.completedSessions + 1
                val nextMode = if (newSessions % 4 == 0) PomodoroMode.LONG_BREAK else PomodoroMode.SHORT_BREAK
                val sec = if (nextMode == PomodoroMode.LONG_BREAK) _settings.value.longBreakMinutes * 60 else _settings.value.shortBreakMinutes * 60
                _pomodoro.value = current.copy(
                    mode = nextMode,
                    remainingSeconds = sec,
                    isRunning = false,
                    completedSessions = newSessions
                )
            } else {
                _pomodoro.value = current.copy(
                    mode = PomodoroMode.WORK,
                    remainingSeconds = _settings.value.workDurationMinutes * 60,
                    isRunning = false
                )
            }
        }
    }

    fun switchPomodoroMode(mode: PomodoroMode) {
        val sec = when (mode) {
            PomodoroMode.WORK -> _settings.value.workDurationMinutes * 60
            PomodoroMode.SHORT_BREAK -> _settings.value.shortBreakMinutes * 60
            PomodoroMode.LONG_BREAK -> _settings.value.longBreakMinutes * 60
        }
        _pomodoro.value = _pomodoro.value.copy(mode = mode, remainingSeconds = sec, isRunning = false)
    }

    fun setPomodoroFocusedTask(taskId: String?) {
        _pomodoro.value = _pomodoro.value.copy(currentTaskId = taskId)
    }

    // --- Scheduled Breaks (12.1) ---

    fun startPlanningWindow(): Pair<Boolean, String> {
        val current = _breakPlanning.value
        if (current.isLocked) return Pair(false, "Breaks are already locked for today.")
        val deadline = System.currentTimeMillis() + 600000L // 10 minutes
        _breakPlanning.value = current.copy(
            state = BreakPlanningStateEnum.PLAN,
            planningWindowDeadline = deadline
        )
        return Pair(true, "10-minute planning window started.")
    }

    fun lockSchedule(intervals: List<BreakInterval>): Pair<Boolean, String> {
        if (intervals.size > 3) return Pair(false, "Maximum 3 breaks allowed per day.")
        var totalMinutes = 0
        for (i in intervals) {
            val dur = (i.endHour * 60 + i.endMinute) - (i.startHour * 60 + i.startMinute)
            if (dur <= 0) return Pair(false, "End time must be after start time.")
            totalMinutes += dur
        }
        if (totalMinutes > 180) return Pair(false, "Total breaks cannot exceed 180 minutes.")

        _breakPlanning.value = _breakPlanning.value.copy(
            state = BreakPlanningStateEnum.BREAKS_LOCKED,
            isLocked = true,
            intervals = intervals
        )
        return Pair(true, "Breaks locked for today.")
    }

    // --- Distraction Dump / Scratchpad (12.4) Local Only ---

    private fun readNotesAndCleanup(): List<DistractionNote> {
        if (!notesFile.exists()) return emptyList()
        val list = mutableListOf<DistractionNote>()
        try {
            val arr = JSONArray(notesFile.readText())
            val now = System.currentTimeMillis()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val exp = obj.optLong("expires_at", now + 1)
                if (exp > now) {
                    list.add(
                        DistractionNote(
                            id = obj.getString("id"),
                            title = obj.optString("title").takeIf { it.isNotBlank() },
                            text = obj.getString("text"),
                            timestamp = obj.getLong("timestamp"),
                            expiresAt = exp
                        )
                    )
                }
            }
        } catch (e: Exception) {
            // ignore
        }
        return list
    }

    fun saveDistractionNote(text: String, title: String? = null) {
        val current = _notes.value.toMutableList()
        val note = DistractionNote(text = text, title = title)
        current.add(0, note)
        _notes.value = current

        val arr = JSONArray()
        current.forEach { n ->
            arr.put(JSONObject().apply {
                put("id", n.id)
                put("text", n.text)
                if (n.title != null) put("title", n.title)
                put("timestamp", n.timestamp)
                put("expires_at", n.expiresAt)
            })
        }
        notesFile.writeText(arr.toString())
    }

    fun deleteDistractionNote(id: String) {
        val current = _notes.value.filter { it.id != id }
        _notes.value = current
        val arr = JSONArray()
        current.forEach { n ->
            arr.put(JSONObject().apply {
                put("id", n.id)
                put("text", n.text)
                if (n.title != null) put("title", n.title)
                put("timestamp", n.timestamp)
                put("expires_at", n.expiresAt)
            })
        }
        notesFile.writeText(arr.toString())
    }

    // --- Settings Updates ---

    fun updateSettings(newSettings: UserSettings) {
        _settings.value = newSettings
        saveLocalSnapshot()
    }

    fun rescheduleAllOverdue(newDate: String) {
        val todayStr = DateUtils.getLogicalDate(_settings.value.dayStartHour)
        val current = _tasks.value.toMutableList()
        for (i in current.indices) {
            val t = current[i]
            if (t.status == TaskStatus.ACTIVE && t.dueDate.isNotBlank() && t.dueDate < todayStr) {
                // Rule 8.3: AI-locked overdue tasks can only roll over to today
                val targetDate = if (t.aiLocked) todayStr else newDate
                current[i] = t.copy(dueDate = targetDate)
            }
        }
        _tasks.value = current
        saveLocalSnapshot()
    }

    fun saveCriteriaPreset(saved: SavedCriteria): Pair<Boolean, String?> {
        val check = CriteriaValidator.validateSavedCriteriaRules(_savedCriteria.value, saved)
        if (!check.first) return check

        val current = _savedCriteria.value.toMutableList()
        current.add(saved)
        _savedCriteria.value = current
        saveLocalSnapshot()
        return Pair(true, null)
    }

    // --- Sync Engine (7.3, 7.4) ---

    suspend fun initialPull(): Pair<Boolean, String> {
        val token = _settings.value.authToken
        if (token.isBlank()) {
            return Pair(false, "Not signed in. Token required to sync with Cloudflare Worker.")
        }
        val pullResult = TaskitatorWorkerApi.pullSync(token, _settings.value.username)
        if (pullResult.isSuccess) {
            val remoteSnapshot = pullResult.getOrThrow()
            rawSnapshot = remoteSnapshot
            baseVersion = remoteSnapshot.optLong("version", 0L)
            baseSnapshotFile.writeText(rawSnapshot.toString())
            parseSnapshot(rawSnapshot)
            _settings.value = _settings.value.copy(needsInitialPull = false, remoteVersion = baseVersion)
            saveLocalSnapshot()
            return Pair(true, "Initial sync successful (v$baseVersion).")
        } else {
            val err = pullResult.exceptionOrNull()?.message ?: "Unknown error"
            return Pair(false, "Initial pull failed: $err")
        }
    }

    suspend fun performSync(): Pair<Boolean, String> {
        val token = _settings.value.authToken
        if (token.isBlank()) {
            return Pair(false, "Not signed in. Token required to sync with Cloudflare Worker.")
        }

        // Rule: First pull mandatory before writes can be pushed
        if (_settings.value.needsInitialPull) {
            return initialPull()
        }

        saveLocalSnapshot()
        val mutationId = UUID.randomUUID().toString()
        val pushResult = TaskitatorWorkerApi.pushSync(rawSnapshot, baseVersion, mutationId, token, _settings.value.username)

        if (pushResult.isSuccess) {
            // Push succeeded: pull immediately to fetch server-reconciled state (7.3)
            val pullResult = TaskitatorWorkerApi.pullSync(token, _settings.value.username)
            if (pullResult.isSuccess) {
                val remoteSnapshot = pullResult.getOrThrow()
                rawSnapshot = remoteSnapshot
                baseVersion = remoteSnapshot.optLong("version", baseVersion + 1)
                baseSnapshotFile.writeText(rawSnapshot.toString())
                parseSnapshot(rawSnapshot)
                return Pair(true, "Sync successful (v$baseVersion).")
            }
            return Pair(true, "Pushed successfully.")
        } else {
            val ex = pushResult.exceptionOrNull()
            if (ex is com.example.data.network.SyncConflictException || ex?.message?.contains("409") == true) {
                return handle409Conflict(token)
            }
            return Pair(false, ex?.message ?: "Unknown sync error")
        }
    }

    private suspend fun handle409Conflict(token: String): Pair<Boolean, String> {
        val pullResult = TaskitatorWorkerApi.pullSync(token, _settings.value.username)
        if (pullResult.isFailure) {
            return Pair(false, "Conflict detected (409) and unable to pull remote snapshot.")
        }

        val remoteObj = pullResult.getOrThrow()
        // Save local backup immediately on conflict before anything else (7.4)
        val backupContent = JSONObject().apply {
            put("export_date", DateUtils.getIsoTimestamp())
            put("local_snapshot", rawSnapshot)
            put("remote_snapshot", remoteObj)
        }
        backupFile.writeText(backupContent.toString(2))

        // Compare tasks between local and remote
        val localTasks = _tasks.value.associateBy { it.id }
        val remoteTasksArr = remoteObj.optJSONArray("tasks") ?: JSONArray()
        val conflictingTasks = mutableListOf<Task>()

        for (i in 0 until remoteTasksArr.length()) {
            val rTask = remoteTasksArr.getJSONObject(i)
            val id = rTask.getString("id")
            val lTask = localTasks[id]
            if (lTask != null) {
                val rTitle = rTask.optString("title")
                val rStatus = rTask.optString("status")
                if (lTask.title != rTitle || lTask.status.name.lowercase() != rStatus) {
                    conflictingTasks.add(lTask)
                }
            }
        }

        // Invariant: Never automatically merge on 409 without explicit user choice
        _syncConflict.value = Pair(conflictingTasks, remoteObj)
        return Pair(false, "Sync conflict detected (409). Choose which copy to keep.")
    }

    fun resolveConflict(useCloud: Boolean) {
        val conflict = _syncConflict.value ?: return
        if (useCloud) {
            // Adopt cloud copy
            rawSnapshot = conflict.second
            baseVersion = rawSnapshot.optLong("version", baseVersion + 1)
            parseSnapshot(rawSnapshot)
            saveLocalSnapshot()
        } else {
            // Keep device copy and update baseVersion to remote's version so next push can succeed
            val remoteVersion = conflict.second.optLong("version", baseVersion)
            baseVersion = remoteVersion
            saveLocalSnapshot()
        }
        _syncConflict.value = null
    }

    fun exportConflictBackup(): String {
        return if (backupFile.exists()) backupFile.readText() else "{}"
    }
}
