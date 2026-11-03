package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Done
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.model.CustomPriority
import com.example.data.model.DEFAULT_PRIORITIES
import com.example.ui.theme.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun BatchActionBar(
    selectedCount: Int,
    onSelectAll: () -> Unit,
    onOpenTags: () -> Unit,
    onOpenPriority: () -> Unit,
    onOpenReschedule: () -> Unit,
    onBatchComplete: () -> Unit,
    onBatchTrash: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = DarkSurfaceElevated,
        border = androidx.compose.foundation.BorderStroke(1.5.dp, ElectricBlue),
        tonalElevation = 8.dp,
        modifier = modifier
            .fillMaxWidth()
            .padding(12.dp)
            .testTag("batch_action_bar")
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Text(
                    text = "$selectedCount Selected",
                    style = MaterialTheme.typography.labelLarge,
                    color = LightBlue,
                    fontWeight = FontWeight.Bold
                )
                TextButton(
                    onClick = onSelectAll,
                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text("All", color = CyanAccent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                }
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                OutlinedButton(
                    onClick = onOpenTags,
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = TextPrimary),
                    border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                ) {
                    Text("🏷️ Tags", fontSize = 11.sp)
                }

                OutlinedButton(
                    onClick = onOpenPriority,
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = TextPrimary),
                    border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                ) {
                    Text("🎯 Priority", fontSize = 11.sp)
                }

                OutlinedButton(
                    onClick = onOpenReschedule,
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = TextPrimary),
                    border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder)
                ) {
                    Text("📅 Date", fontSize = 11.sp)
                }

                IconButton(
                    onClick = onBatchComplete,
                    modifier = Modifier.size(32.dp).testTag("batch_complete_button")
                ) {
                    Icon(Icons.Default.Done, contentDescription = "Complete selected", tint = SuccessGreen)
                }

                IconButton(
                    onClick = onBatchTrash,
                    modifier = Modifier.size(32.dp).testTag("batch_trash_button")
                ) {
                    Icon(Icons.Default.Delete, contentDescription = "Trash selected", tint = DangerRed)
                }

                IconButton(
                    onClick = onCancel,
                    modifier = Modifier.size(32.dp)
                ) {
                    Icon(Icons.Default.Close, contentDescription = "Cancel selection", tint = TextMuted)
                }
            }
        }
    }
}

@Composable
fun BatchTagsDialog(
    onDismiss: () -> Unit,
    onApply: (List<String>) -> Unit
) {
    var tagsInput by remember { mutableStateOf("") }
    val commonTags = listOf("Work", "Study", "Health", "Personal", "Urgent", "Finance")

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text("🏷️ Batch Edit Tags", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(6.dp))
                Text("Applies tags to all selected tasks", style = MaterialTheme.typography.bodyMedium, color = TextSecondary, fontSize = 12.sp)

                Spacer(modifier = Modifier.height(14.dp))
                OutlinedTextField(
                    value = tagsInput,
                    onValueChange = { tagsInput = it },
                    label = { Text("Tags (comma separated)") },
                    placeholder = { Text("Work, Sprint") },
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = ElectricBlue,
                        unfocusedBorderColor = DarkBorder,
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(modifier = Modifier.height(10.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    commonTags.take(4).forEach { tag ->
                        Surface(
                            shape = RoundedCornerShape(4.dp),
                            color = DarkSurfaceVariant,
                            modifier = Modifier.clickable {
                                tagsInput = if (tagsInput.isBlank()) tag else "$tagsInput, $tag"
                            }
                        ) {
                            Text("+$tag", color = TextSecondary, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                        }
                    }
                }

                Spacer(modifier = Modifier.height(20.dp))
                Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                    TextButton(onClick = onDismiss) { Text("Cancel", color = TextSecondary) }
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            val parsed = tagsInput.split(",").map { it.trim().removePrefix("#") }.filter { it.isNotEmpty() }
                            onApply(parsed)
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue)
                    ) {
                        Text("Apply", color = TextPrimary)
                    }
                }
            }
        }
    }
}

@Composable
fun BatchPriorityDialog(
    customPriorities: List<CustomPriority> = DEFAULT_PRIORITIES,
    onDismiss: () -> Unit,
    onSelectPriority: (String) -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text("🎯 Batch Set Priority", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(6.dp))
                Text("Select priority to assign to all selected tasks:", style = MaterialTheme.typography.bodyMedium, color = TextSecondary, fontSize = 12.sp)

                Spacer(modifier = Modifier.height(14.dp))
                customPriorities.forEach { p ->
                    val color = when (p.id) {
                        "prio_high" -> PriorityP1
                        "prio_med" -> PriorityP2
                        "prio_low" -> PriorityP3
                        else -> PriorityP4
                    }
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = DarkSurfaceVariant,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp)
                            .clickable { onSelectPriority(p.id) }
                    ) {
                        Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Surface(shape = RoundedCornerShape(4.dp), color = color, modifier = Modifier.size(10.dp)) {}
                            Spacer(modifier = Modifier.width(10.dp))
                            Text(p.label, color = TextPrimary, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(10.dp))
                TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) {
                    Text("Cancel", color = TextSecondary)
                }
            }
        }
    }
}

@Composable
fun BatchRescheduleDialog(
    title: String = "📅 Bulk Reschedule",
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit
) {
    val today = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())
    var dateInput by remember { mutableStateOf(today) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(6.dp))
                Text("Select new due date for selected tasks (YYYY-MM-DD):", style = MaterialTheme.typography.bodyMedium, color = TextSecondary, fontSize = 12.sp)

                Spacer(modifier = Modifier.height(14.dp))
                OutlinedTextField(
                    value = dateInput,
                    onValueChange = { dateInput = it },
                    label = { Text("Due Date") },
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = ElectricBlue,
                        unfocusedBorderColor = DarkBorder,
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(modifier = Modifier.height(20.dp))
                Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                    TextButton(onClick = onDismiss) { Text("Cancel", color = TextSecondary) }
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = { onConfirm(dateInput) },
                        colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue)
                    ) {
                        Text("Reschedule", color = TextPrimary)
                    }
                }
            }
        }
    }
}
