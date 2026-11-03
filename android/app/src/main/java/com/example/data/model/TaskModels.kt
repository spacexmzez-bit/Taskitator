package com.example.data.model

import java.util.UUID

data class CustomPriority(
    val id: String,
    val label: String,
    val rank: Int,
    val colorHex: String = "#3B82F6"
)

val DEFAULT_PRIORITIES = listOf(
    CustomPriority(id = "prio_high", label = "High", rank = 1, colorHex = "#EF4444"),
    CustomPriority(id = "prio_med", label = "Medium", rank = 2, colorHex = "#F97316"),
    CustomPriority(id = "prio_low", label = "Low", rank = 3, colorHex = "#3B82F6")
)

val DEFAULT_TAGS = listOf("study", "work", "personal")

enum class TaskStatus {
    ACTIVE,
    COMPLETED,
    TRASH
}

enum class RecurrenceRule(val displayName: String, val wireKind: String) {
    NONE("None", "none"),
    DAILY("Daily", "daily"),
    WEEKDAYS("Weekdays (Mon-Fri)", "weekdays"),
    MONTHLY("Monthly", "monthly"),
    MONTH_DAY("Specific Day of Month", "month_day"),
    HALF_YEARLY("Half-Yearly", "half_yearly"),
    YEARLY("Yearly", "yearly")
}

data class Task(
    val id: String = "task_${System.currentTimeMillis()}_${(1000..9999).random()}",
    val parentId: String? = null,
    val title: String,
    val rawTitle: String = title,
    val resolvedTitle: String = rawTitle,
    val description: String = "",
    val dueDate: String = "", // "" | "today" | "YYYY-MM-DD"
    val priorityId: String = "prio_med",
    val tags: List<String> = emptyList(),
    val status: TaskStatus = TaskStatus.ACTIVE,
    val estimatedMinutes: Int = 25,
    val actualMinutes: Int = 0,
    val aiLocked: Boolean = false,
    val auditApproved: Boolean = false, // Required to complete an AI-locked task
    val proofCriteria: String = "",
    val rawProofCriteria: String = proofCriteria,
    val resolvedCriteria: String = proofCriteria,
    val criteriaValidationScore: Int? = null,
    val criteriaValidationCritique: String? = null,
    val requireAllSubtasksFirst: Boolean = false, // Shield: all non-bonus subtasks must be done
    val isBonus: Boolean = false,
    val isSmartStudyBonus: Boolean = false,
    val smartEarlyDate: String? = null, // Display only as bonus on that date
    val projectId: String? = null, // Preserved, not edited in this update
    val recurrence: RecurrenceRule = RecurrenceRule.NONE,
    val seriesId: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val completedAt: Long? = null,
    val orderIndex: Int = 0,
    val unmappedFields: Map<String, Any?> = emptyMap() // Preserves web/server properties verbatim
)

enum class PomodoroMode(val displayName: String) {
    WORK("Focus Work"),
    SHORT_BREAK("Short Break"),
    LONG_BREAK("Long Break")
}

data class PomodoroState(
    val mode: PomodoroMode = PomodoroMode.WORK,
    val remainingSeconds: Int = 25 * 60,
    val isRunning: Boolean = false,
    val currentTaskId: String? = null,
    val completedSessions: Int = 0
)

enum class EvidenceAuditVerdict {
    APPROVED,
    REJECTED,
    INCOMPLETE
}

data class EvidenceAuditResult(
    val verdict: EvidenceAuditVerdict,
    val feedback: String,
    val timestamp: Long = System.currentTimeMillis()
)

data class CriteriaValidationResult(
    val isValid: Boolean,
    val score: Int, // 1..10, passing >= 7
    val critique: String,
    val suggestedRewrite: String? = null
)

data class CriteriaTemplate(
    val id: String,
    val category: String,
    val label: String,
    val template: String
)

data class SavedCriteria(
    val id: String = "sc_${System.currentTimeMillis()}_${(1000..9999).random()}",
    val title: String = "",
    val criteria: String,
    val score: Int = 9,
    val hasExemplar: Boolean = false,
    val exemplar: String? = null,
    val createdAt: Long = System.currentTimeMillis()
)

data class StudyPlanConfig(
    val title: String = "Exam Preparation Plan",
    val unitName: String = "Chapter",
    val totalUnits: Int = 20,
    val studyDays: Int = 10,
    val startingUnit: Int = 1,
    val startDate: String = "",
    val studyWeekdays: List<Int> = listOf(1, 2, 3, 4, 5),
    val sharedCriteria: String = "Show completed notes and solved exercises for {unit_name} {num}.",
    val enableAiAudits: Boolean = true,
    val smartStudyEnabled: Boolean = false,
    val smartStudyMode: String = "original"
)

data class StudyPlanDayPreview(
    val dayNumber: Int,
    val date: String,
    val unitNumbers: List<Int>,
    val earlyBonusUnits: List<Int> = emptyList()
)

data class DistractionNote(
    val id: String = UUID.randomUUID().toString(),
    val title: String? = null,
    val text: String,
    val timestamp: Long = System.currentTimeMillis(),
    val expiresAt: Long = System.currentTimeMillis() + 48 * 3600 * 1000L, // 48h GC
    val convertedToTaskId: String? = null
)

enum class BreakPlanningStateEnum {
    PLAN,
    BREAKS_LOCKED,
    PLANNING_CLOSED,
    REPAIR_BREAKS
}

data class BreakInterval(
    val id: String = UUID.randomUUID().toString(),
    val startHour: Int,
    val startMinute: Int,
    val endHour: Int,
    val endMinute: Int,
    val label: String
)

data class BreakPlanningState(
    val state: BreakPlanningStateEnum = BreakPlanningStateEnum.PLAN,
    val planningWindowDeadline: Long = 0L, // 10-minute window
    val isLocked: Boolean = false,
    val isRepairState: Boolean = false,
    val intervals: List<BreakInterval> = emptyList(),
    val dayStartHour: Int = 0,
    val cycleTimezone: String = "UTC"
)

enum class BreakType(val displayName: String, val defaultMinutes: Int) {
    SHORT_BREAK("Short Break", 5),
    LONG_BREAK("Long Break", 15),
    MEAL("Meal", 30)
}

data class BreakSession(
    val id: String = UUID.randomUUID().toString(),
    val type: BreakType = BreakType.SHORT_BREAK,
    val durationMinutes: Int = 5,
    val timestamp: Long = System.currentTimeMillis()
)

data class CopilotMessage(
    val id: String = UUID.randomUUID().toString(),
    val sender: String,
    val text: String,
    val timestamp: Long = System.currentTimeMillis()
)

data class PhoneAccessDecision(
    val allowed: Boolean,
    val reason: String,
    val activeBreakLabel: String? = null
)

data class UserSettings(
    val username: String = "Focus Champion",
    val copilotName: String = "Ari",
    val isPro: Boolean = false, // Keyo entitlement status from /pro/status
    val useByok: Boolean = false,
    val dayStartHour: Int = 0, // 0..4 (logical day transition)
    val weekendStart: Int = 5, // 0..6
    val weekendEnd: Int = 6,
    val breakTimezone: String = "UTC",
    val workDurationMinutes: Int = 25,
    val shortBreakMinutes: Int = 5,
    val longBreakMinutes: Int = 15,
    val dailyBreakTarget: Int = 4,
    val dumpDurationSeconds: Int = 90, // 30..300 in 15s steps
    val strictCriteriaValidation: Boolean = true,
    val soundEffectsEnabled: Boolean = true,
    val hapticsEnabled: Boolean = true,
    val emergencyBypassUsesRemaining: Int = 4, // Max 4 per cycle
    val emergencyBypassActive: Boolean = false,
    val emergencyBypassUntil: Long = 0L, // 15-minute countdown
    val emergencyCycleResetDate: String = "",
    val phoneTokens: List<String> = emptyList(),
    val customPriorities: List<CustomPriority> = DEFAULT_PRIORITIES,
    val customTags: List<String> = DEFAULT_TAGS,
    val activeAiModel: String = "gemini-3.5-flash-lite", // "gemini-3.5-flash-lite" or "claude-haiku-5-5"
    val activeProvider: String = "gemini", // "gemini" or "claude"
    val geminiKeyConfigured: Boolean = false,
    val claudeKeyConfigured: Boolean = false,
    val authToken: String = "", // Clerk session JWT
    val clerkUserId: String = "",
    val workerUser: String = "", // e.g. clerk:<sha256(clerkUserId)>
    val needsInitialPull: Boolean = true, // Writes guarded until initial pull completes
    val remoteVersion: Long = 0L,
    val unmappedFields: Map<String, Any?> = emptyMap() // Preserves web/server properties verbatim
)
