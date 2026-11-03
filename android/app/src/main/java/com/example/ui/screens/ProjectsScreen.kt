package com.example.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.TaskStatus
import com.example.ui.components.TaskItemCard
import com.example.ui.theme.*
import com.example.ui.viewmodel.TaskitatorViewModel

@Composable
fun ProjectsScreen(
    viewModel: TaskitatorViewModel,
    modifier: Modifier = Modifier
) {
    val tasks by viewModel.tasks.collectAsState()
    val settings by viewModel.settings.collectAsState()
    val isSelectMode by viewModel.isSelectMode.collectAsState()
    val selectedTaskIds by viewModel.selectedTaskIds.collectAsState()

    val tagsWithTasks = remember(tasks) {
        val nonTrashTasks = tasks.filter { it.status != TaskStatus.TRASH && it.parentId == null }
        val allTags = nonTrashTasks.flatMap { it.tags }.toSet()
        val untagged = nonTrashTasks.filter { it.tags.isEmpty() }

        val map = allTags.associateWith { tag ->
            nonTrashTasks.filter { tag in it.tags }
        }.toMutableMap()

        if (untagged.isNotEmpty()) {
            map["General Backlog"] = untagged
        }
        map
    }

    var expandedProjects by remember { mutableStateOf(setOf<String>()) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp)
    ) {
        Spacer(modifier = Modifier.height(12.dp))

        Text(
            text = "Projects & Tags",
            style = MaterialTheme.typography.headlineMedium,
            color = TextPrimary,
            fontWeight = FontWeight.ExtraBold
        )

        Spacer(modifier = Modifier.height(14.dp))

        if (tagsWithTasks.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "No projects yet. Add tags like #Work or #Study to your tasks!",
                    style = MaterialTheme.typography.bodyMedium,
                    color = TextMuted
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(bottom = 90.dp)
            ) {
                items(tagsWithTasks.keys.toList()) { projectTag ->
                    val projectTasks = tagsWithTasks[projectTag] ?: emptyList()
                    val completed = projectTasks.count { it.status == TaskStatus.COMPLETED }
                    val total = projectTasks.size
                    val progress = if (total > 0) completed.toFloat() / total.toFloat() else 0f
                    val isExpanded = projectTag in expandedProjects

                    Card(
                        shape = RoundedCornerShape(14.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        expandedProjects = if (isExpanded) {
                                            expandedProjects - projectTag
                                        } else {
                                            expandedProjects + projectTag
                                        }
                                    },
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(
                                    imageVector = if (isExpanded) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                    contentDescription = null,
                                    tint = CyanAccent
                                )
                                Spacer(modifier = Modifier.width(6.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = if (projectTag.startsWith("General")) projectTag else "#$projectTag",
                                        style = MaterialTheme.typography.titleMedium,
                                        color = TextPrimary,
                                        fontWeight = FontWeight.Bold
                                    )
                                    Text(
                                        text = "$completed / $total completed",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = TextSecondary
                                    )
                                }
                                Text(
                                    text = "${(progress * 100).toInt()}%",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = if (progress == 1f) SuccessGreen else ElectricBlue,
                                    fontWeight = FontWeight.Bold
                                )
                            }

                            Spacer(modifier = Modifier.height(8.dp))
                            LinearProgressIndicator(
                                progress = { progress },
                                modifier = Modifier.fillMaxWidth(),
                                color = if (progress == 1f) SuccessGreen else ElectricBlue,
                                trackColor = DarkSurfaceVariant
                            )

                            if (isExpanded) {
                                Spacer(modifier = Modifier.height(10.dp))
                                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    projectTasks.forEach { task ->
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
                }
            }
        }
    }
}
