package com.example.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.CustomPriority
import com.example.data.model.Task
import com.example.data.model.TaskStatus
import com.example.data.util.DateUtils
import com.example.ui.components.TaskItemCard
import com.example.ui.theme.*
import com.example.ui.viewmodel.TaskitatorViewModel

@Composable
fun GeneralScreen(
    viewModel: TaskitatorViewModel,
    modifier: Modifier = Modifier
) {
    val tasks by viewModel.tasks.collectAsState()
    val settings by viewModel.settings.collectAsState()
    val isSelectMode by viewModel.isSelectMode.collectAsState()
    val selectedTaskIds by viewModel.selectedTaskIds.collectAsState()
    val priorityFilter by viewModel.priorityFilter.collectAsState()
    val tagFilter by viewModel.tagFilter.collectAsState()

    val todayDate = remember(settings.dayStartHour) { DateUtils.getLogicalDate(settings.dayStartHour) }
    val tasksById = remember(tasks) { tasks.associateBy { it.id } }

    val filteredRootTasks = remember(tasks, priorityFilter, tagFilter) {
        tasks.filter { task ->
            task.status != TaskStatus.TRASH &&
            task.parentId == null &&
            (priorityFilter == null || task.priorityId == priorityFilter) &&
            (tagFilter == null || tagFilter in task.tags)
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp)
    ) {
        Spacer(modifier = Modifier.height(12.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "General Tasks",
                style = MaterialTheme.typography.headlineMedium,
                color = TextPrimary,
                fontWeight = FontWeight.ExtraBold
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                // Multi-select toggle
                IconButton(
                    onClick = { viewModel.toggleSelectMode() },
                    modifier = Modifier.testTag("general_toggle_select_mode_button")
                ) {
                    Text(if (isSelectMode) "☑" else "☐", fontSize = 20.sp, color = if (isSelectMode) ElectricBlue else TextSecondary)
                }

                // Filter toggle
                IconButton(
                    onClick = { viewModel.setFilterModalVisible(true) },
                    modifier = Modifier.testTag("general_filter_button")
                ) {
                    Text("🔍", fontSize = 18.sp)
                }
            }
        }

        Spacer(modifier = Modifier.height(10.dp))

        // Priority Quick Filter Chips from settings.customPriorities
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Surface(
                shape = RoundedCornerShape(8.dp),
                color = if (priorityFilter == null) ElectricBlue else DarkSurfaceVariant,
                modifier = Modifier
                    .weight(1f)
                    .clickable { viewModel.setPriorityFilter(null) }
            ) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 6.dp)) {
                    Text("All", color = TextPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
            settings.customPriorities.forEach { p ->
                val isSel = priorityFilter == p.id
                val color = when (p.id) {
                    "prio_high" -> PriorityP1
                    "prio_med" -> PriorityP2
                    "prio_low" -> PriorityP3
                    else -> PriorityP4
                }
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = if (isSel) color else DarkSurfaceVariant,
                    modifier = Modifier
                        .weight(1f)
                        .clickable { viewModel.setPriorityFilter(if (isSel) null else p.id) }
                ) {
                    Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 6.dp)) {
                        Text(p.label, color = TextPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Multi-level Tasks List
        if (filteredRootTasks.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "No active tasks in backlog.",
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
                items(filteredRootTasks, key = { it.id }) { rootTask ->
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
