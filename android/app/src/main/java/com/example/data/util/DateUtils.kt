package com.example.data.util

import com.example.data.model.Task
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

object DateUtils {

    /**
     * Calculates the logical date string (YYYY-MM-DD) based on dayStartHour (0..4).
     * If current time is before dayStartHour, counts as the previous day.
     */
    fun getLogicalDate(dayStartHour: Int = 0): String {
        val cal = Calendar.getInstance()
        val currentHour = cal.get(Calendar.HOUR_OF_DAY)
        if (currentHour < dayStartHour.coerceIn(0, 4)) {
            cal.add(Calendar.DAY_OF_YEAR, -1)
        }
        val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
        return sdf.format(cal.time)
    }

    /**
     * Resolves effective due date for a task:
     * If task has no dueDate, walks up ancestor tree until a due date is found.
     */
    fun getEffectiveDueDate(task: Task, allTasksById: Map<String, Task>): String {
        if (task.dueDate.isNotBlank()) return task.dueDate
        var current: Task? = task
        val visited = mutableSetOf<String>()
        while (current != null && current.id !in visited) {
            visited.add(current.id)
            val parentId = current.parentId ?: break
            val parent = allTasksById[parentId]
            if (parent != null && parent.dueDate.isNotBlank()) {
                return parent.dueDate
            }
            current = parent
        }
        return ""
    }

    /**
     * Calculates the next Emergency Bypass cycle reset date (Monday morning following the weekend).
     */
    fun getNextEmergencyResetDate(): String {
        val cal = Calendar.getInstance()
        val dayOfWeek = cal.get(Calendar.DAY_OF_WEEK)
        // Days until next Monday
        val daysUntilMonday = when (dayOfWeek) {
            Calendar.MONDAY -> 7
            Calendar.TUESDAY -> 6
            Calendar.WEDNESDAY -> 5
            Calendar.THURSDAY -> 4
            Calendar.FRIDAY -> 3
            Calendar.SATURDAY -> 2
            Calendar.SUNDAY -> 1
            else -> 7
        }
        cal.add(Calendar.DAY_OF_YEAR, daysUntilMonday)
        val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
        return sdf.format(cal.time)
    }

    fun getIsoTimestamp(): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = java.util.TimeZone.getTimeZone("UTC")
        }
        return sdf.format(Date())
    }
}
