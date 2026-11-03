package com.example.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.BreakPlanningStateEnum
import com.example.data.model.PomodoroMode
import com.example.data.model.Task
import com.example.data.model.TaskStatus
import com.example.data.util.DateUtils
import com.example.ui.components.BatchRescheduleDialog
import com.example.ui.components.FloatingPomodoroBar
import com.example.ui.components.TaskItemCard
import com.example.ui.theme.*
import com.example.ui.viewmodel.TaskitatorViewModel
import kotlinx.coroutines.delay
import java.util.Calendar

@Composable
fun TodayScreen(
    viewModel: TaskitatorViewModel,
    onOpenCreateTask: () -> Unit,
    modifier: Modifier = Modifier
) {
    val tasks by viewModel.tasks.collectAsState()
    val settings by viewModel.settings.collectAsState()
    val isSelectMode by viewModel.isSelectMode.collectAsState()
    val selectedTaskIds by viewModel.selectedTaskIds.collectAsState()
    val overdueCount by viewModel.overdueTasksCount.collectAsState()
    val priorityFilter by viewModel.priorityFilter.collectAsState()
    val tagFilter by viewModel.tagFilter.collectAsState()
    val statusBanner by viewModel.statusBannerMessage.collectAsState()
    val pomodoroState by viewModel.pomodoroState.collectAsState()
    val breakPlanning by viewModel.breakPlanning.collectAsState()
    val lastCompletedTask by viewModel.repository.lastCompletedTask.collectAsState()

    val todayDate = remember(settings.dayStartHour) { DateUtils.getLogicalDate(settings.dayStartHour) }
    val tasksById = remember(tasks) { tasks.associateBy { it.id } }

    // Helper: belongsToCurrentView for Today (8.3)
    fun taskBelongsToToday(t: Task): Boolean {
        if (t.status == TaskStatus.TRASH) return false
        val effDate = DateUtils.getEffectiveDueDate(t, tasksById)
        if (effDate.isBlank() || effDate == "today" || effDate <= todayDate) return true
        // Check if any non-trash descendant belongs
        val children = tasks.filter { it.parentId == t.id && it.status != TaskStatus.TRASH }
        return children.any { taskBelongsToToday(it) }
    }

    val todayRootTasks = remember(tasks, priorityFilter, tagFilter, todayDate) {
        tasks.filter { task ->
            task.status != TaskStatus.TRASH &&
            task.parentId == null &&
            taskBelongsToToday(task) &&
            (priorityFilter == null || task.priorityId == priorityFilter) &&
            (tagFilter == null || tagFilter in task.tags)
        }
    }

    var showRescheduleModal by remember { mutableStateOf(false) }

    // 10-second undo countdown
    var undoRemainingSeconds by remember { mutableIntStateOf(0) }
    LaunchedEffect(lastCompletedTask) {
        if (lastCompletedTask != null) {
            undoRemainingSeconds = 10
            while (undoRemainingSeconds > 0) {
                delay(1000L)
                undoRemainingSeconds -= 1
            }
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp)
    ) {
        Spacer(modifier = Modifier.height(12.dp))

        // Header: Title, logical date, and action icons (No search bar per Rule 4)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = "Today's Focus",
                    style = MaterialTheme.typography.headlineMedium,
                    color = TextPrimary,
                    fontWeight = FontWeight.ExtraBold
                )
                Text(
                    text = "$todayDate (Day starts at ${String.format("%02d:00", settings.dayStartHour)})",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextSecondary
                )
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                // Multi-select toggle
                IconButton(
                    onClick = { viewModel.toggleSelectMode() },
                    modifier = Modifier.testTag("toggle_select_mode_button")
                ) {
                    Text(if (isSelectMode) "☑" else "☐", fontSize = 20.sp, color = if (isSelectMode) ElectricBlue else TextSecondary)
                }

                // Filter toggle
                IconButton(
                    onClick = { viewModel.setFilterModalVisible(true) },
                    modifier = Modifier.testTag("filter_button")
                ) {
                    Text("🔍", fontSize = 18.sp)
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Status or Error Feedback Banner (e.g. Shield protection alert)
        if (statusBanner != null) {
            Surface(
                shape = RoundedCornerShape(8.dp),
                color = PriorityP1.copy(alpha = 0.15f),
                border = androidx.compose.foundation.BorderStroke(1.dp, PriorityP1.copy(alpha = 0.4f)),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp)
            ) {
                Row(
                    modifier = Modifier.padding(10.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(statusBanner!!, style = MaterialTheme.typography.bodyMedium, color = TextPrimary, modifier = Modifier.weight(1f))
                    IconButton(onClick = { viewModel.clearStatusMessage() }, modifier = Modifier.size(24.dp)) {
                        Icon(Icons.Default.Close, contentDescription = "Dismiss", tint = TextSecondary, modifier = Modifier.size(16.dp))
                    }
                }
            }
        }

        // 10-second Undo Grace Period Snackbar (VERIFIED 8.6)
        if (lastCompletedTask != null && undoRemainingSeconds > 0) {
            Surface(
                shape = RoundedCornerShape(8.dp),
                color = DarkSurfaceElevated,
                border = androidx.compose.foundation.BorderStroke(1.dp, SuccessGreen),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp)
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Completed '${lastCompletedTask!!.title}' (${undoRemainingSeconds}s)",
                        style = MaterialTheme.typography.bodyMedium,
                        color = TextPrimary,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(
                        onClick = { viewModel.repository.undoCompletion(lastCompletedTask!!.id) },
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)
                    ) {
                        Text("Undo", color = CyanAccent, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        // Distinct Scheduled Break Window Banner (Separate from Pomodoro)
        val breakLabel = when (breakPlanning.state) {
            BreakPlanningStateEnum.PLAN -> "Plan Scheduled Breaks"
            BreakPlanningStateEnum.BREAKS_LOCKED -> "Breaks Locked for Today"
            BreakPlanningStateEnum.PLANNING_CLOSED -> "Planning Window Closed"
            BreakPlanningStateEnum.REPAIR_BREAKS -> "Repair Invalid Breaks"
        }

        Surface(
            shape = RoundedCornerShape(10.dp),
            color = if (breakPlanning.isLocked) SuccessGreen.copy(alpha = 0.15f) else CyanAccent.copy(alpha = 0.1f),
            border = androidx.compose.foundation.BorderStroke(
                1.dp,
                if (breakPlanning.isLocked) SuccessGreen.copy(alpha = 0.5f) else CyanAccent.copy(alpha = 0.3f)
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp)
                .clickable { viewModel.setBreakPlanningDialogVisible(true) }
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.weight(1f)
                ) {
                    Text(if (breakPlanning.isLocked) "☕" else "⚡", fontSize = 16.sp)
                    Column {
                        Text(
                            text = breakLabel,
                            style = MaterialTheme.typography.labelMedium,
                            color = if (breakPlanning.isLocked) SuccessGreen else CyanAccent,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "Daily pre-planned schedule (10m window) · Tap to view",
                            style = MaterialTheme.typography.labelSmall,
                            color = TextMuted,
                            fontSize = 10.sp
                        )
                    }
                }
                Text("Manage ›", color = CyanAccent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        }

        // Overdue Reschedule Warning Bar (AI-locked can only roll over to today per 8.3)
        if (overdueCount > 0) {
            Surface(
                shape = RoundedCornerShape(8.dp),
                color = PriorityP1.copy(alpha = 0.12f),
                border = androidx.compose.foundation.BorderStroke(1.dp, PriorityP1.copy(alpha = 0.4f)),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "⚠️ $overdueCount overdue tasks",
                        style = MaterialTheme.typography.labelMedium,
                        color = PriorityP1,
                        fontWeight = FontWeight.Bold
                    )
                    OutlinedButton(
                        onClick = { showRescheduleModal = true },
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = PriorityP1),
                        border = androidx.compose.foundation.BorderStroke(1.dp, PriorityP1.copy(alpha = 0.5f))
                    ) {
                        Text("📅 Reschedule all", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        // Active Emergency Banner (12.3)
        if (settings.emergencyBypassActive) {
            Surface(
                shape = RoundedCornerShape(8.dp),
                color = PriorityP1.copy(alpha = 0.2f),
                border = androidx.compose.foundation.BorderStroke(1.dp, PriorityP1),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("🚨 Emergency Mode Active: Device guardrails bypassed (${settings.emergencyBypassUsesRemaining}/4 uses remaining)", style = MaterialTheme.typography.labelMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                }
            }
        }

        // Recursive Multi-Level Tasks Tree List
        if (todayRootTasks.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("🎯", fontSize = 48.sp)
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(
                        text = "All clear for today!",
                        style = MaterialTheme.typography.titleLarge,
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Tap '+ New task' below to start your focus session.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = TextMuted
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                contentPadding = PaddingValues(bottom = 8.dp)
            ) {
                items(todayRootTasks, key = { it.id }) { rootTask ->
                    val effectiveDate = DateUtils.getEffectiveDueDate(rootTask, tasksById)
                    val isOverdue = effectiveDate.isNotBlank() && effectiveDate < todayDate

                    TaskItemCard(
                        task = rootTask,
                        allTasks = tasks,
                        indentLevel = 0,
                        isSelectMode = isSelectMode,
                        isSelected = rootTask.id in selectedTaskIds,
                        isOverdue = isOverdue,
                        emergencyBypassActive = settings.emergencyBypassActive,
                        onToggleCompletion = { id ->
                            val (ok, error) = viewModel.repository.toggleTaskCompletion(id)
                            if (!ok && error != null) {
                                viewModel.setStatusMessage(error)
                            } else {
                                viewModel.clearStatusMessage()
                            }
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

        // Floating Pomodoro Focus Bar (Docked above bottom edge)
        val focusedTask = remember(tasks, pomodoroState.currentTaskId) {
            tasks.find { it.id == pomodoroState.currentTaskId }
        }

        Spacer(modifier = Modifier.height(4.dp))
        FloatingPomodoroBar(
            pomodoroState = pomodoroState,
            focusedTask = focusedTask,
            onPlayPause = {
                if (pomodoroState.isRunning) {
                    viewModel.repository.pausePomodoro()
                } else {
                    viewModel.repository.startPomodoro()
                }
            },
            onReset = { viewModel.repository.resetPomodoro() },
            onSkipMode = {
                val nextMode = when (pomodoroState.mode) {
                    PomodoroMode.WORK -> PomodoroMode.SHORT_BREAK
                    PomodoroMode.SHORT_BREAK -> PomodoroMode.WORK
                    PomodoroMode.LONG_BREAK -> PomodoroMode.WORK
                }
                viewModel.repository.switchPomodoroMode(nextMode)
            },
            modifier = Modifier.padding(bottom = 8.dp)
        )
    }

    if (showRescheduleModal) {
        BatchRescheduleDialog(
            title = "Reschedule Overdue Tasks",
            onDismiss = { showRescheduleModal = false },
            onConfirm = { newDate ->
                viewModel.repository.rescheduleAllOverdue(newDate)
                showRescheduleModal = false
            }
        )
    }
}
