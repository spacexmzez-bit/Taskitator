package com.example.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.TaskStatus
import com.example.data.util.DateUtils
import com.example.ui.components.TaskItemCard
import com.example.ui.theme.*
import com.example.ui.viewmodel.TaskitatorViewModel
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

@Composable
fun CalendarScreen(
    viewModel: TaskitatorViewModel,
    modifier: Modifier = Modifier
) {
    val tasks by viewModel.tasks.collectAsState()
    val settings by viewModel.settings.collectAsState()
    val isSelectMode by viewModel.isSelectMode.collectAsState()
    val selectedTaskIds by viewModel.selectedTaskIds.collectAsState()

    val sdf = remember { SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()) }
    val dayFormat = remember { SimpleDateFormat("EEE", Locale.getDefault()) }
    val numFormat = remember { SimpleDateFormat("d", Locale.getDefault()) }

    var selectedDateStr by remember { mutableStateOf(DateUtils.getLogicalDate(settings.dayStartHour)) }

    val upcomingDays = remember {
        val list = mutableListOf<Triple<String, String, String>>()
        val cal = Calendar.getInstance()
        for (i in 0 until 14) {
            val d = cal.time
            list.add(Triple(sdf.format(d), dayFormat.format(d), numFormat.format(d)))
            cal.add(Calendar.DAY_OF_YEAR, 1)
        }
        list
    }

    val tasksById = remember(tasks) { tasks.associateBy { it.id } }

    val tasksOnSelectedDate = remember(tasks, selectedDateStr) {
        tasks.filter {
            it.status == TaskStatus.ACTIVE &&
            it.parentId == null &&
            DateUtils.getEffectiveDueDate(it, tasksById) == selectedDateStr
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp)
    ) {
        Spacer(modifier = Modifier.height(12.dp))

        Text(
            text = "Calendar Schedule",
            style = MaterialTheme.typography.headlineMedium,
            color = TextPrimary,
            fontWeight = FontWeight.ExtraBold
        )

        Spacer(modifier = Modifier.height(14.dp))

        // Horizontal Date Strip
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            items(upcomingDays) { (dateStr, dayOfWeek, dayNum) ->
                val isSelected = dateStr == selectedDateStr
                val taskCountOnDay = tasks.count {
                    it.status == TaskStatus.ACTIVE && DateUtils.getEffectiveDueDate(it, tasksById) == dateStr
                }

                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = if (isSelected) ElectricBlue else DarkSurfaceVariant,
                    border = if (isSelected) null else androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                    modifier = Modifier
                        .width(62.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .clickable { selectedDateStr = dateStr }
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.padding(vertical = 10.dp)
                    ) {
                        Text(
                            text = dayOfWeek,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (isSelected) TextPrimary else TextSecondary
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = dayNum,
                            style = MaterialTheme.typography.titleMedium,
                            color = TextPrimary,
                            fontWeight = FontWeight.Bold
                        )
                        if (taskCountOnDay > 0) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Surface(
                                shape = RoundedCornerShape(4.dp),
                                color = if (isSelected) CyanAccent else ElectricBlue.copy(alpha = 0.4f),
                                modifier = Modifier.size(6.dp)
                            ) {}
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Tasks for $selectedDateStr (${tasksOnSelectedDate.size})",
            style = MaterialTheme.typography.labelLarge,
            color = TextSecondary
        )

        Spacer(modifier = Modifier.height(8.dp))

        if (tasksOnSelectedDate.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "No tasks scheduled for this day.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextMuted
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                contentPadding = PaddingValues(bottom = 90.dp)
            ) {
                items(tasksOnSelectedDate, key = { it.id }) { task ->
                    TaskItemCard(
                        task = task,
                        allTasks = tasks,
                        indentLevel = 0,
                        isSelectMode = isSelectMode,
                        isSelected = task.id in selectedTaskIds,
                        emergencyBypassActive = settings.emergencyBypassActive,
                        onToggleCompletion = { id ->
                            val (ok, error) = viewModel.repository.toggleTaskCompletion(id)
                            if (!ok && error != null) viewModel.setStatusMessage(error)
                        },
                        onToggleSelection = { viewModel.toggleTaskSelection(it) },
                        onEditTask = { viewModel.openEditTaskDialog(it) },
                        onAddSubtask = { viewModel.openCreateTaskDialog(parentId = it) },
                        onTrashTask = { viewModel.repository.trashBranch(it) },
                        onOpenAudit = { viewModel.openEvidenceAuditDialog(it) }
                    )
                }
            }
        }
    }
}
