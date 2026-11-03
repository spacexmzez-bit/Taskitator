package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
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

@Composable
fun TrashScreen(
    viewModel: TaskitatorViewModel,
    modifier: Modifier = Modifier
) {
    val tasks by viewModel.tasks.collectAsState()
    val trashTasks = remember(tasks) { tasks.filter { it.status == TaskStatus.TRASH } }

    var showConfirmEmpty by remember { mutableStateOf(false) }

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
                text = "Trash (${trashTasks.size})",
                style = MaterialTheme.typography.headlineMedium,
                color = TextPrimary,
                fontWeight = FontWeight.ExtraBold
            )

            if (trashTasks.isNotEmpty()) {
                TextButton(onClick = { showConfirmEmpty = true }) {
                    Text("Empty Trash", color = DangerRed, fontWeight = FontWeight.Bold)
                }
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        if (trashTasks.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("🗑️", fontSize = 48.sp)
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(
                        text = "Trash is empty",
                        style = MaterialTheme.typography.titleLarge,
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Deleted tasks appear here and can be restored anytime.",
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
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(bottom = 90.dp)
            ) {
                items(trashTasks, key = { it.id }) { task ->
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = task.title,
                                    style = MaterialTheme.typography.titleMedium,
                                    color = TextPrimary
                                )
                                if (task.description.isNotBlank()) {
                                    Spacer(modifier = Modifier.height(2.dp))
                                    Text(
                                        text = task.description,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = TextSecondary,
                                        maxLines = 1
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.width(8.dp))

                            // Restore Button
                            IconButton(
                                onClick = { viewModel.repository.restoreTask(task.id) }
                            ) {
                                Icon(
                                    Icons.Default.Refresh,
                                    contentDescription = "Restore task",
                                    tint = SuccessGreen
                                )
                            }

                            // Permanently Delete Button
                            IconButton(
                                onClick = { viewModel.repository.permanentlyDeleteTask(task.id) }
                            ) {
                                Icon(
                                    Icons.Default.Delete,
                                    contentDescription = "Permanently delete",
                                    tint = DangerRed
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showConfirmEmpty) {
        AlertDialog(
            onDismissRequest = { showConfirmEmpty = false },
            title = { Text("Empty Trash?") },
            text = { Text("Are you sure you want to permanently delete all ${trashTasks.size} tasks? This cannot be undone.") },
            confirmButton = {
                Button(
                    onClick = {
                        viewModel.repository.emptyTrash()
                        showConfirmEmpty = false
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = DangerRed)
                ) {
                    Text("Delete All")
                }
            },
            dismissButton = {
                TextButton(onClick = { showConfirmEmpty = false }) {
                    Text("Cancel")
                }
            }
        )
    }
}
