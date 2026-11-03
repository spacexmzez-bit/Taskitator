package com.example.ui.viewmodel

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.data.model.*
import com.example.data.repository.TaskRepository
import com.example.data.util.DateUtils
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.Locale

enum class AppScreen(val title: String, val icon: String) {
    TODAY("Today's Focus", "📅"),
    GENERAL("General Tasks", "📋"),
    SETTINGS("Settings", "⚙️")
}

class TaskitatorViewModel(application: Application) : AndroidViewModel(application) {
    val repository = TaskRepository(application.applicationContext)

    val tasks = repository.tasks
    val notes = repository.notes
    val breaks = repository.breaks
    val settings = repository.settings
    val savedCriteria = repository.savedCriteria
    val breakPlanning = repository.breakPlanning
    val pomodoroState = repository.pomodoro

    init {
        // Continuous Pomodoro ticker
        viewModelScope.launch {
            while (true) {
                delay(1000L)
                repository.tickPomodoro()
            }
        }
    }

    private val _currentScreen = MutableStateFlow(AppScreen.TODAY)
    val currentScreen: StateFlow<AppScreen> = _currentScreen.asStateFlow()

    // Multi-selection
    private val _isSelectMode = MutableStateFlow(false)
    val isSelectMode: StateFlow<Boolean> = _isSelectMode.asStateFlow()

    private val _selectedTaskIds = MutableStateFlow<Set<String>>(emptySet())
    val selectedTaskIds: StateFlow<Set<String>> = _selectedTaskIds.asStateFlow()

    // Filters
    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    private val _priorityFilter = MutableStateFlow<String?>(null)
    val priorityFilter: StateFlow<String?> = _priorityFilter.asStateFlow()

    private val _tagFilter = MutableStateFlow<String?>(null)
    val tagFilter: StateFlow<String?> = _tagFilter.asStateFlow()

    // Status / Snack Message
    private val _statusBannerMessage = MutableStateFlow<String?>(null)
    val statusBannerMessage: StateFlow<String?> = _statusBannerMessage.asStateFlow()

    // Modals
    private val _editingTask = MutableStateFlow<Task?>(null)
    val editingTask: StateFlow<Task?> = _editingTask.asStateFlow()

    private val _parentTaskIdForNewSubtask = MutableStateFlow<String?>(null)
    val parentTaskIdForNewSubtask: StateFlow<String?> = _parentTaskIdForNewSubtask.asStateFlow()

    private val _showCreateEditDialog = MutableStateFlow(false)
    val showCreateEditDialog: StateFlow<Boolean> = _showCreateEditDialog.asStateFlow()

    private val _showDistractionDumpDialog = MutableStateFlow(false)
    val showDistractionDumpDialog: StateFlow<Boolean> = _showDistractionDumpDialog.asStateFlow()

    private val _showPomodoroDialog = MutableStateFlow(false)
    val showPomodoroDialog: StateFlow<Boolean> = _showPomodoroDialog.asStateFlow()

    private val _showEmergencyDialog = MutableStateFlow(false)
    val showEmergencyDialog: StateFlow<Boolean> = _showEmergencyDialog.asStateFlow()

    private val _showCopilotDrawer = MutableStateFlow(false)
    val showCopilotDrawer: StateFlow<Boolean> = _showCopilotDrawer.asStateFlow()

    private val _showBatchTagsModal = MutableStateFlow(false)
    val showBatchTagsModal: StateFlow<Boolean> = _showBatchTagsModal.asStateFlow()

    private val _showBatchPriorityModal = MutableStateFlow(false)
    val showBatchPriorityModal: StateFlow<Boolean> = _showBatchPriorityModal.asStateFlow()

    private val _showBatchRescheduleModal = MutableStateFlow(false)
    val showBatchRescheduleModal: StateFlow<Boolean> = _showBatchRescheduleModal.asStateFlow()

    private val _showFilterModal = MutableStateFlow(false)
    val showFilterModal: StateFlow<Boolean> = _showFilterModal.asStateFlow()

    // New Modals for Full Feature Parity
    private val _showStudyPlanDialog = MutableStateFlow(false)
    val showStudyPlanDialog: StateFlow<Boolean> = _showStudyPlanDialog.asStateFlow()

    private val _showBreakPlanningDialog = MutableStateFlow(false)
    val showBreakPlanningDialog: StateFlow<Boolean> = _showBreakPlanningDialog.asStateFlow()

    private val _showPhoneAccessDialog = MutableStateFlow(false)
    val showPhoneAccessDialog: StateFlow<Boolean> = _showPhoneAccessDialog.asStateFlow()

    private val _auditingTask = MutableStateFlow<Task?>(null)
    val auditingTask: StateFlow<Task?> = _auditingTask.asStateFlow()

    private val _showEvidenceAuditDialog = MutableStateFlow(false)
    val showEvidenceAuditDialog: StateFlow<Boolean> = _showEvidenceAuditDialog.asStateFlow()

    // Timer state
    private val _isTimerRunning = MutableStateFlow(false)
    val isTimerRunning: StateFlow<Boolean> = _isTimerRunning.asStateFlow()

    private val _isBreakMode = MutableStateFlow(false)
    val isBreakMode: StateFlow<Boolean> = _isBreakMode.asStateFlow()

    private val _remainingSeconds = MutableStateFlow(25 * 60)
    val remainingSeconds: StateFlow<Int> = _remainingSeconds.asStateFlow()

    private val _totalSeconds = MutableStateFlow(25 * 60)
    val totalSeconds: StateFlow<Int> = _totalSeconds.asStateFlow()

    private var timerJob: Job? = null

    // Copilot messages
    private val _copilotMessages = MutableStateFlow<List<CopilotMessage>>(
        listOf(
            CopilotMessage(
                sender = "copilot",
                text = "Hello! I'm Ari, your Taskitator Focus Copilot. I can help organize tasks, break down complex study plans, or review focus metrics. (Note: AI audit approvals and Emergency Bypass require their dedicated workflows)."
            )
        )
    )
    val copilotMessages: StateFlow<List<CopilotMessage>> = _copilotMessages.asStateFlow()

    // Overdue tasks count
    val overdueTasksCount: StateFlow<Int> = tasks.combine(settings) { allTasks, s ->
        val today = DateUtils.getLogicalDate(s.dayStartHour)
        val tasksById = allTasks.associateBy { it.id }
        allTasks.count {
            it.status == TaskStatus.ACTIVE && DateUtils.getEffectiveDueDate(it, tasksById).isNotBlank() && DateUtils.getEffectiveDueDate(it, tasksById) < today
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    // Check if pending AI-locked tasks exist due today
    val hasPendingAiLockedTasksToday: StateFlow<Boolean> = tasks.combine(settings) { allTasks, s ->
        val today = DateUtils.getLogicalDate(s.dayStartHour)
        val tasksById = allTasks.associateBy { it.id }
        allTasks.any {
            it.status == TaskStatus.ACTIVE && it.aiLocked && DateUtils.getEffectiveDueDate(it, tasksById) <= today && DateUtils.getEffectiveDueDate(it, tasksById).isNotBlank()
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)

    fun navigateTo(screen: AppScreen) {
        _currentScreen.value = screen
    }

    fun setStatusMessage(msg: String?) {
        _statusBannerMessage.value = msg
    }

    fun clearStatusMessage() {
        _statusBannerMessage.value = null
    }

    // Selection Mode
    fun toggleSelectMode() {
        _isSelectMode.value = !_isSelectMode.value
        if (!_isSelectMode.value) {
            _selectedTaskIds.value = emptySet()
        }
    }

    fun toggleTaskSelection(taskId: String) {
        val current = _selectedTaskIds.value.toMutableSet()
        if (taskId in current) current.remove(taskId) else current.add(taskId)
        _selectedTaskIds.value = current
    }

    fun selectAllVisible(taskIds: List<String>) {
        _selectedTaskIds.value = taskIds.toSet()
    }

    fun clearSelection() {
        _selectedTaskIds.value = emptySet()
        _isSelectMode.value = false
    }

    // Filters
    fun setSearchQuery(query: String) {
        _searchQuery.value = query
    }

    fun setPriorityFilter(priority: String?) {
        _priorityFilter.value = priority
    }

    fun setTagFilter(tag: String?) {
        _tagFilter.value = tag
    }

    fun clearFilters() {
        _searchQuery.value = ""
        _priorityFilter.value = null
        _tagFilter.value = null
    }

    // Dialogs
    fun openCreateTaskDialog(parentId: String? = null) {
        _editingTask.value = null
        _parentTaskIdForNewSubtask.value = parentId
        _showCreateEditDialog.value = true
    }

    fun openEditTaskDialog(task: Task) {
        _editingTask.value = task
        _parentTaskIdForNewSubtask.value = null
        _showCreateEditDialog.value = true
    }

    fun closeCreateEditDialog() {
        _showCreateEditDialog.value = false
        _editingTask.value = null
        _parentTaskIdForNewSubtask.value = null
    }

    fun openEvidenceAuditDialog(task: Task) {
        _auditingTask.value = task
        _showEvidenceAuditDialog.value = true
    }

    fun closeEvidenceAuditDialog() {
        _showEvidenceAuditDialog.value = false
        _auditingTask.value = null
    }

    fun setDistractionDumpDialogVisible(visible: Boolean) {
        _showDistractionDumpDialog.value = visible
    }

    fun setPomodoroDialogVisible(visible: Boolean) {
        _showPomodoroDialog.value = visible
    }

    fun setEmergencyDialogVisible(visible: Boolean) {
        _showEmergencyDialog.value = visible
    }

    fun setCopilotDrawerVisible(visible: Boolean) {
        _showCopilotDrawer.value = visible
    }

    fun setStudyPlanDialogVisible(visible: Boolean) {
        _showStudyPlanDialog.value = visible
    }

    fun setBreakPlanningDialogVisible(visible: Boolean) {
        _showBreakPlanningDialog.value = visible
    }

    fun setPhoneAccessDialogVisible(visible: Boolean) {
        _showPhoneAccessDialog.value = visible
    }

    fun setBatchTagsModalVisible(visible: Boolean) {
        _showBatchTagsModal.value = visible
    }

    fun setBatchPriorityModalVisible(visible: Boolean) {
        _showBatchPriorityModal.value = visible
    }

    fun setBatchRescheduleModalVisible(visible: Boolean) {
        _showBatchRescheduleModal.value = visible
    }

    fun setFilterModalVisible(visible: Boolean) {
        _showFilterModal.value = visible
    }

    // Pomodoro Timer Logic
    fun startTimer() {
        if (_isTimerRunning.value) return
        _isTimerRunning.value = true
        timerJob = viewModelScope.launch {
            while (_isTimerRunning.value && _remainingSeconds.value > 0) {
                delay(1000)
                _remainingSeconds.value -= 1
            }
            if (_remainingSeconds.value <= 0) {
                completeTimerSession()
            }
        }
    }

    fun pauseTimer() {
        _isTimerRunning.value = false
        timerJob?.cancel()
    }

    fun resetTimer() {
        pauseTimer()
        val duration = if (_isBreakMode.value) {
            settings.value.shortBreakMinutes * 60
        } else {
            settings.value.workDurationMinutes * 60
        }
        _remainingSeconds.value = duration
        _totalSeconds.value = duration
    }

    fun switchTimerMode(isBreak: Boolean) {
        pauseTimer()
        _isBreakMode.value = isBreak
        val duration = if (isBreak) {
            settings.value.shortBreakMinutes * 60
        } else {
            settings.value.workDurationMinutes * 60
        }
        _remainingSeconds.value = duration
        _totalSeconds.value = duration
    }

    private fun completeTimerSession() {
        _isTimerRunning.value = false
        if (_isBreakMode.value) {
            repository.addBreak(BreakType.SHORT_BREAK, settings.value.shortBreakMinutes)
            switchTimerMode(false)
        } else {
            switchTimerMode(true)
        }
    }

    // Copilot Chat (Strictly separate from Audit/Emergency bypass authorization)
    fun sendCopilotMessage(userText: String) {
        if (userText.isBlank()) return
        val userMsg = CopilotMessage(sender = "user", text = userText)
        _copilotMessages.value = _copilotMessages.value + userMsg

        viewModelScope.launch {
            delay(500)
            val reply = generateCopilotResponse(userText)
            _copilotMessages.value = _copilotMessages.value + CopilotMessage(sender = "copilot", text = reply)
        }
    }

    private fun generateCopilotResponse(input: String): String {
        val lower = input.lowercase(Locale.ROOT)
        val activeTasks = tasks.value.filter { it.status == TaskStatus.ACTIVE }
        val p1Count = activeTasks.count { it.priorityId == "prio_high" }
        val today = DateUtils.getLogicalDate(settings.value.dayStartHour)
        val dueTodayCount = activeTasks.count { it.dueDate == today }

        return when {
            "approve" in lower || "complete" in lower && "audit" in lower -> {
                "⚠️ Safety Note: As your focus assistant, I cannot approve audits or complete AI-locked tasks through chat. Please tap on the task and select 'Submit AI Proof' to run the official verification."
            }
            "bypass" in lower || "emergency" in lower -> {
                "⚠️ Safety Note: Emergency Bypass cannot be activated or extended via chat commands. Please tap the 🚨 button in the top bar to review your remaining uses (up to 4 per cycle) and activate the 15-minute window."
            }
            "study" in lower || "recurrence" in lower || "plan" in lower -> {
                "You can generate a structured study plan with unit milestones! Tap the navigation menu and select 'Study Recurrence · Pro' to configure unit distribution and Smart Study early bonus options."
            }
            "subtask" in lower || "break" in lower || "split" in lower -> {
                "Here is an effective 3-tier breakdown technique:\n1. 🎯 Define the immediate next physical milestone.\n2. 🛡️ Set 'Require all subtasks first' on the parent to safeguard completion.\n3. 📝 Dump stray thoughts in the 💡 scratchpad."
            }
            "today" in lower || "priority" in lower || "focus" in lower -> {
                "You have $dueTodayCount task(s) scheduled for today ($today) and $p1Count urgent (P1) tasks. Start with your highest priority deliverable!"
            }
            else -> {
                "I'm here to help maintain your flow state. You can ask for assistance organizing tasks, reviewing study strategies, or structuring your focus blocks."
            }
        }
    }
}
