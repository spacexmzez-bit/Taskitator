package com.example.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.TaskStatus
import com.example.ui.theme.*
import com.example.ui.viewmodel.TaskitatorViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun StatsScreen(
    viewModel: TaskitatorViewModel,
    modifier: Modifier = Modifier
) {
    val tasks by viewModel.tasks.collectAsState()
    val breaks by viewModel.breaks.collectAsState()
    val settings by viewModel.settings.collectAsState()

    val todayStr = remember { com.example.data.util.DateUtils.getLogicalDate(0) }
    val completedTasks = remember(tasks) { tasks.filter { it.status == TaskStatus.COMPLETED } }
    val completedToday = remember(tasks, todayStr) {
        val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
        completedTasks.count {
            it.completedAt != null && sdf.format(Date(it.completedAt)) == todayStr
        }
    }
    val activeTasks = remember(tasks) { tasks.filter { it.status == TaskStatus.ACTIVE } }
    val totalEstimatedMinutes = remember(tasks) { tasks.sumOf { it.estimatedMinutes } }

    val p1Count = remember(tasks) { tasks.count { it.priorityId == "prio_high" && it.status == TaskStatus.ACTIVE } }
    val p2Count = remember(tasks) { tasks.count { it.priorityId == "prio_med" && it.status == TaskStatus.ACTIVE } }
    val p3Count = remember(tasks) { tasks.count { it.priorityId == "prio_low" && it.status == TaskStatus.ACTIVE } }
    val p4Count = 0

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp)
    ) {
        Spacer(modifier = Modifier.height(12.dp))

        Text(
            text = "Productivity Stats",
            style = MaterialTheme.typography.headlineMedium,
            color = TextPrimary,
            fontWeight = FontWeight.ExtraBold
        )

        Spacer(modifier = Modifier.height(14.dp))

        LazyColumn(
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(bottom = 90.dp)
        ) {
            // Stat Cards Grid Row 1
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    StatMetricCard(
                        title = "Completed Today",
                        value = "$completedToday",
                        subtitle = "${completedTasks.size} all-time",
                        badge = "🎯",
                        accentColor = SuccessGreen,
                        modifier = Modifier.weight(1f)
                    )
                    StatMetricCard(
                        title = "Focus Streak",
                        value = "5 Days",
                        subtitle = "Consistency winner",
                        badge = "🔥",
                        accentColor = WarningAmber,
                        modifier = Modifier.weight(1f)
                    )
                }
            }

            // Stat Cards Grid Row 2
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    StatMetricCard(
                        title = "Daily Breaks",
                        value = "${breaks.size} / ${settings.dailyBreakTarget}",
                        subtitle = if (breaks.size >= settings.dailyBreakTarget) "Goal achieved!" else "Take a breather",
                        badge = "☕",
                        accentColor = CyanAccent,
                        modifier = Modifier.weight(1f)
                    )
                    StatMetricCard(
                        title = "Estimated Effort",
                        value = "${totalEstimatedMinutes}m",
                        subtitle = "${activeTasks.size} active tasks",
                        badge = "⏱️",
                        accentColor = ElectricBlue,
                        modifier = Modifier.weight(1f)
                    )
                }
            }

            // Priority Distribution Bar
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = DarkSurface),
                    border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(
                            text = "Active Priority Distribution",
                            style = MaterialTheme.typography.titleMedium,
                            color = TextPrimary,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(modifier = Modifier.height(12.dp))

                        val totalActive = (p1Count + p2Count + p3Count + p4Count).coerceAtLeast(1)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(12.dp)
                                .background(DarkSurfaceVariant, RoundedCornerShape(6.dp))
                        ) {
                            if (p1Count > 0) Box(modifier = Modifier.weight(p1Count.toFloat()).fillMaxHeight().background(PriorityP1))
                            if (p2Count > 0) Box(modifier = Modifier.weight(p2Count.toFloat()).fillMaxHeight().background(PriorityP2))
                            if (p3Count > 0) Box(modifier = Modifier.weight(p3Count.toFloat()).fillMaxHeight().background(PriorityP3))
                            if (p4Count > 0) Box(modifier = Modifier.weight(p4Count.toFloat()).fillMaxHeight().background(PriorityP4))
                        }

                        Spacer(modifier = Modifier.height(10.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            PriorityStatLabel("P1 Urgent", p1Count, PriorityP1)
                            PriorityStatLabel("P2 High", p2Count, PriorityP2)
                            PriorityStatLabel("P3 Medium", p3Count, PriorityP3)
                            PriorityStatLabel("P4 Low", p4Count, PriorityP4)
                        }
                    }
                }
            }

            // Breaks Session Log
            item {
                Card(
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = DarkSurface),
                    border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(
                            text = "Today's Break Sessions",
                            style = MaterialTheme.typography.titleMedium,
                            color = TextPrimary,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(modifier = Modifier.height(8.dp))

                        if (breaks.isEmpty()) {
                            Text(
                                text = "No breaks logged yet today. Remember to rest after deep work intervals!",
                                style = MaterialTheme.typography.bodyMedium,
                                color = TextMuted
                            )
                        } else {
                            breaks.take(5).forEach { session ->
                                val timeFormat = SimpleDateFormat("h:mm a", Locale.getDefault())
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 4.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "☕ ${session.type.displayName} (${session.durationMinutes}m)",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = TextPrimary
                                    )
                                    Text(
                                        text = timeFormat.format(Date(session.timestamp)),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = TextSecondary
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun StatMetricCard(
    title: String,
    value: String,
    subtitle: String,
    badge: String,
    accentColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier
) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = DarkSurface),
        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
        modifier = modifier
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(title, style = MaterialTheme.typography.labelMedium, color = TextSecondary)
                Text(badge, fontSize = 16.sp)
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.headlineMedium,
                color = accentColor,
                fontWeight = FontWeight.ExtraBold
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = TextMuted, fontSize = 11.sp)
        }
    }
}

@Composable
fun PriorityStatLabel(name: String, count: Int, color: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Surface(shape = RoundedCornerShape(3.dp), color = color, modifier = Modifier.size(8.dp)) {}
        Text("$name: $count", style = MaterialTheme.typography.labelSmall, color = TextSecondary, fontSize = 10.sp)
    }
}
