package com.example.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.RecurrenceRule
import com.example.data.model.Task
import com.example.data.model.TaskStatus
import com.example.ui.theme.*

@Composable
fun TaskItemCard(
    task: Task,
    allTasks: List<Task>,
    indentLevel: Int = 0,
    isSelectMode: Boolean = false,
    isSelected: Boolean = false,
    isOverdue: Boolean = false,
    emergencyBypassActive: Boolean = false,
    onToggleCompletion: (String) -> Unit,
    onToggleSelection: (String) -> Unit,
    onEditTask: (Task) -> Unit,
    onAddSubtask: (String) -> Unit,
    onTrashTask: (String) -> Unit,
    onOpenAudit: (Task) -> Unit,
    modifier: Modifier = Modifier
) {
    var expandedSubtasks by remember { mutableStateOf(true) }
    var showMenu by remember { mutableStateOf(false) }

    val directChildren = remember(allTasks, task.id) {
        allTasks.filter { it.parentId == task.id && it.status != TaskStatus.TRASH }
    }

    val priorityColor = when (task.priorityId) {
        "prio_high" -> PriorityP1
        "prio_med" -> PriorityP2
        "prio_low" -> PriorityP3
        else -> PriorityP4
    }
    val priorityLabel = when (task.priorityId) {
        "prio_high" -> "High"
        "prio_med" -> "Med"
        "prio_low" -> "Low"
        else -> task.priorityId
    }

    val isCompleted = task.status == TaskStatus.COMPLETED

    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("task_item_${task.id}")
            .padding(vertical = 3.dp, horizontal = (indentLevel * 12).coerceAtMost(36).dp),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isSelected) DarkSurfaceElevated else DarkSurface
        ),
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (isSelected) ElectricBlue else if (isOverdue && !isCompleted) PriorityP1.copy(alpha = 0.5f) else DarkBorder
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp)
        ) {
            Row(
                verticalAlignment = Alignment.Top,
                modifier = Modifier.fillMaxWidth()
            ) {
                // Selection or Completion Checkbox
                if (isSelectMode) {
                    Checkbox(
                        checked = isSelected,
                        onCheckedChange = { onToggleSelection(task.id) },
                        colors = CheckboxDefaults.colors(checkedColor = ElectricBlue, uncheckedColor = TextMuted),
                        modifier = Modifier.testTag("select_checkbox_${task.id}")
                    )
                } else {
                    Checkbox(
                        checked = isCompleted,
                        onCheckedChange = {
                            if (task.aiLocked && !isCompleted && !emergencyBypassActive) {
                                // Direct to AI evidence audit flow!
                                onOpenAudit(task)
                            } else {
                                onToggleCompletion(task.id)
                            }
                        },
                        colors = CheckboxDefaults.colors(checkedColor = SuccessGreen, uncheckedColor = TextMuted),
                        modifier = Modifier.testTag("complete_checkbox_${task.id}")
                    )
                }

                Spacer(modifier = Modifier.width(6.dp))

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clickable {
                            if (isSelectMode) onToggleSelection(task.id) else onEditTask(task)
                        }
                ) {
                    // Task Title
                    Text(
                        text = task.resolvedTitle.ifBlank { task.title },
                        style = MaterialTheme.typography.titleMedium,
                        color = if (isCompleted) TextMuted else TextPrimary,
                        textDecoration = if (isCompleted) TextDecoration.LineThrough else TextDecoration.None,
                        fontWeight = FontWeight.SemiBold
                    )

                    // Optional Description
                    if (task.description.isNotBlank()) {
                        Spacer(modifier = Modifier.height(2.dp))
                        Text(
                            text = task.description,
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary,
                            maxLines = 2
                        )
                    }

                    Spacer(modifier = Modifier.height(6.dp))

                    // Meta Chips Row: Priority, Shield, Bonus, Due Date, AI-Lock, Recurrence
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        // Priority Badge
                        Surface(
                            shape = RoundedCornerShape(6.dp),
                            color = priorityColor.copy(alpha = 0.15f),
                            border = androidx.compose.foundation.BorderStroke(1.dp, priorityColor.copy(alpha = 0.4f))
                        ) {
                            Text(
                                text = priorityLabel,
                                style = MaterialTheme.typography.labelSmall,
                                color = priorityColor,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                            )
                        }

                        // Shield Badge: "Require all subtasks first"
                        if (task.requireAllSubtasksFirst) {
                            Surface(
                                shape = RoundedCornerShape(6.dp),
                                color = CyanAccent.copy(alpha = 0.2f),
                                border = androidx.compose.foundation.BorderStroke(1.dp, CyanAccent.copy(alpha = 0.5f))
                            ) {
                                Text(
                                    text = "🛡️ Shielded",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = CyanAccent,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }

                        // Bonus Work Badge
                        if (task.isBonus) {
                            Surface(
                                shape = RoundedCornerShape(6.dp),
                                color = WarningAmber.copy(alpha = 0.2f)
                            ) {
                                Text(
                                    text = if (task.isSmartStudyBonus) "⭐ Early Bonus" else "⭐ Bonus",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = WarningAmber,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }

                        // Due Date Chip
                        if (task.dueDate.isNotBlank()) {
                            Surface(
                                shape = RoundedCornerShape(6.dp),
                                color = if (isOverdue && !isCompleted) PriorityP1.copy(alpha = 0.15f) else DarkSurfaceVariant,
                                border = if (isOverdue && !isCompleted) androidx.compose.foundation.BorderStroke(1.dp, PriorityP1.copy(alpha = 0.4f)) else null
                            ) {
                                Text(
                                    text = "📅 ${task.dueDate}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (isOverdue && !isCompleted) PriorityP1 else TextSecondary,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }

                        // AI-Locked Guardrail Badge
                        if (task.aiLocked) {
                            Surface(
                                shape = RoundedCornerShape(6.dp),
                                color = ElectricBlue.copy(alpha = 0.2f),
                                border = androidx.compose.foundation.BorderStroke(1.dp, ElectricBlue.copy(alpha = 0.5f)),
                                modifier = Modifier.clickable { onOpenAudit(task) }
                            ) {
                                Text(
                                    text = "🔒 AI-Proof",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = LightBlue,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }

                        // Recurrence Badge
                        if (task.recurrence != RecurrenceRule.NONE) {
                            Surface(shape = RoundedCornerShape(6.dp), color = DarkSurfaceVariant) {
                                Text(
                                    text = "🔁 ${task.recurrence.displayName.split(" ").first()}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = CyanAccent,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }
                    }

                    // Tags Row
                    if (task.tags.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(4.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            task.tags.forEach { tag ->
                                Surface(shape = RoundedCornerShape(4.dp), color = DarkSurfaceVariant) {
                                    Text("#$tag", style = MaterialTheme.typography.labelSmall, color = TextSecondary, modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp))
                                }
                            }
                        }
                    }
                }

                // Options Menu
                Box {
                    IconButton(onClick = { showMenu = true }, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Default.MoreVert, contentDescription = "Menu", tint = TextSecondary, modifier = Modifier.size(18.dp))
                    }
                    DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                        DropdownMenuItem(
                            text = { Text("Edit Task") },
                            onClick = {
                                showMenu = false
                                onEditTask(task)
                            },
                            leadingIcon = { Icon(Icons.Default.Edit, contentDescription = null) }
                        )
                        DropdownMenuItem(
                            text = { Text("Add Subtask") },
                            onClick = {
                                showMenu = false
                                onAddSubtask(task.id)
                            },
                            leadingIcon = { Icon(Icons.Default.Add, contentDescription = null) }
                        )
                        if (task.aiLocked) {
                            DropdownMenuItem(
                                text = { Text("Submit AI Proof") },
                                onClick = {
                                    showMenu = false
                                    onOpenAudit(task)
                                },
                                leadingIcon = { Icon(Icons.Default.Lock, contentDescription = null, tint = CyanAccent) }
                            )
                        }
                        DropdownMenuItem(
                            text = { Text("Move to Trash") },
                            onClick = {
                                showMenu = false
                                onTrashTask(task.id)
                            },
                            leadingIcon = { Icon(Icons.Default.Delete, contentDescription = null, tint = PriorityP1) }
                        )
                    }
                }
            }

            // Recursive Multi-Level Subtasks Section (Children, Grandchildren, etc.)
            if (directChildren.isNotEmpty()) {
                Spacer(modifier = Modifier.height(8.dp))
                HorizontalDivider(color = DarkBorder.copy(alpha = 0.5f), thickness = 0.5.dp)
                Spacer(modifier = Modifier.height(6.dp))

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { expandedSubtasks = !expandedSubtasks },
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        imageVector = if (expandedSubtasks) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = "Toggle",
                        tint = TextSecondary,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        text = "Subtasks (${directChildren.count { it.status == TaskStatus.COMPLETED }}/${directChildren.size})",
                        style = MaterialTheme.typography.labelSmall,
                        color = TextSecondary,
                        fontWeight = FontWeight.Bold
                    )
                }

                AnimatedVisibility(visible = expandedSubtasks) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        directChildren.forEach { child ->
                            TaskItemCard(
                                task = child,
                                allTasks = allTasks,
                                indentLevel = indentLevel + 1,
                                isSelectMode = isSelectMode,
                                isSelected = isSelected,
                                isOverdue = isOverdue,
                                emergencyBypassActive = emergencyBypassActive,
                                onToggleCompletion = onToggleCompletion,
                                onToggleSelection = onToggleSelection,
                                onEditTask = onEditTask,
                                onAddSubtask = onAddSubtask,
                                onTrashTask = onTrashTask,
                                onOpenAudit = onOpenAudit
                            )
                        }
                    }
                }
            }
        }
    }
}
