package com.example.data.util

import com.example.data.model.*
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

object StudyPlanGenerator {

    fun generatePreview(config: StudyPlanConfig): List<StudyPlanDayPreview> {
        val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
        val cal = Calendar.getInstance()
        if (config.startDate.isNotBlank()) {
            try {
                val parsed = sdf.parse(config.startDate)
                if (parsed != null) cal.time = parsed
            } catch (_: Exception) {}
        }

        val totalUnits = config.totalUnits.coerceIn(1, 1000)
        val studyDays = config.studyDays.coerceIn(1, 365)
        val startingUnit = config.startingUnit.coerceAtLeast(1)

        val days = mutableListOf<StudyPlanDayPreview>()
        val baseUnitsPerDay = totalUnits / studyDays
        val remainder = totalUnits % studyDays

        var currentUnit = startingUnit
        var dayIndex = 1

        val weekdays = if (config.studyWeekdays.isEmpty()) (1..7).toList() else config.studyWeekdays

        while (dayIndex <= studyDays) {
            // Calendar DAY_OF_WEEK: 1=Sun, 2=Mon... convert to ISO 1=Mon..7=Sun
            val dayOfWeek = when (cal.get(Calendar.DAY_OF_WEEK)) {
                Calendar.MONDAY -> 1
                Calendar.TUESDAY -> 2
                Calendar.WEDNESDAY -> 3
                Calendar.THURSDAY -> 4
                Calendar.FRIDAY -> 5
                Calendar.SATURDAY -> 6
                Calendar.SUNDAY -> 7
                else -> 1
            }

            if (dayOfWeek in weekdays) {
                val countForThisDay = baseUnitsPerDay + if (dayIndex <= remainder) 1 else 0
                val unitNumbers = mutableListOf<Int>()
                for (u in 0 until countForThisDay) {
                    unitNumbers.add(currentUnit)
                    currentUnit++
                }

                // If Smart Study is enabled, peek at a future unit as an early bonus opportunity
                val earlyBonusUnits = mutableListOf<Int>()
                if (config.smartStudyEnabled && dayIndex < studyDays && currentUnit <= startingUnit + totalUnits - 1) {
                    earlyBonusUnits.add(currentUnit) // peek next unit early
                }

                days.add(
                    StudyPlanDayPreview(
                        dayNumber = dayIndex,
                        date = sdf.format(cal.time),
                        unitNumbers = unitNumbers,
                        earlyBonusUnits = earlyBonusUnits
                    )
                )
                dayIndex++
            }
            cal.add(Calendar.DAY_OF_YEAR, 1)
        }

        return days
    }

    fun buildTasksFromPreview(
        config: StudyPlanConfig,
        preview: List<StudyPlanDayPreview>
    ): List<Task> {
        val createdTasks = mutableListOf<Task>()

        for (day in preview) {
            // Root Day Task
            val dayTask = Task(
                title = "${config.title} - Day ${day.dayNumber}",
                description = "Complete scheduled ${config.unitName} tasks for ${day.date}.",
                dueDate = day.date,
                priorityId = "prio_high",
                tags = listOf("Study", "StudyPlan"),
                requireAllSubtasksFirst = true // Strict prerequisite shield
            )
            createdTasks.add(dayTask)

            // Required Unit Subtasks
            for (unitNum in day.unitNumbers) {
                val rawTitle = "${config.unitName} {num==$unitNum}"
                val resolvedTitle = "${config.unitName} $unitNum"
                val resolvedCriteria = config.sharedCriteria.replace("{num}", unitNum.toString())
                    .replace("{unit_name}", config.unitName)

                createdTasks.add(
                    Task(
                        parentId = dayTask.id,
                        title = rawTitle,
                        rawTitle = rawTitle,
                        description = "Study material and exercises for $resolvedTitle.",
                        dueDate = day.date,
                        priorityId = "prio_med",
                        tags = listOf("Study"),
                        aiLocked = config.enableAiAudits,
                        proofCriteria = config.sharedCriteria,
                        rawProofCriteria = config.sharedCriteria,
                        isBonus = false
                    )
                )
            }

            // Early Bonus Opportunities (Smart Study)
            for (bonusUnitNum in day.earlyBonusUnits) {
                val rawTitle = "${config.unitName} {num==$bonusUnitNum} [Early Bonus]"
                val resolvedTitle = "${config.unitName} $bonusUnitNum [Early Bonus]"
                val resolvedCriteria = config.sharedCriteria.replace("{num}", bonusUnitNum.toString())
                    .replace("{unit_name}", config.unitName)

                createdTasks.add(
                    Task(
                        parentId = dayTask.id,
                        title = rawTitle,
                        rawTitle = rawTitle,
                        description = "Early bonus opportunity. Unfinished work remains required on its original date.",
                        dueDate = day.date,
                        priorityId = "prio_low",
                        tags = listOf("Study", "SmartStudy"),
                        aiLocked = config.enableAiAudits,
                        proofCriteria = config.sharedCriteria,
                        rawProofCriteria = config.sharedCriteria,
                        isBonus = true,
                        isSmartStudyBonus = true
                    )
                )
            }
        }

        return createdTasks
    }
}
