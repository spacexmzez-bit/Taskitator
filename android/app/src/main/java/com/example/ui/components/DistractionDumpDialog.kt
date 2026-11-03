package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.model.DistractionNote
import com.example.ui.theme.*
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun DistractionDumpDialog(
    timerDurationSeconds: Int = 90,
    hasPendingAiLockedTasksToday: Boolean,
    notes: List<DistractionNote>,
    onDismiss: () -> Unit,
    onSaveNote: (String, String?) -> Unit,
    onDeleteNote: (String) -> Unit,
    onClearAll: () -> Unit
) {
    var rawInput by remember { mutableStateOf("") }
    var noteTitle by remember { mutableStateOf("") }
    var viewNotesTab by remember { mutableStateOf(false) }

    // Scratchpad countdown timer
    var remainingSeconds by remember { mutableIntStateOf(timerDurationSeconds) }
    var isTimerActive by remember { mutableStateOf(!viewNotesTab) }

    LaunchedEffect(isTimerActive, remainingSeconds) {
        if (isTimerActive && remainingSeconds > 0) {
            delay(1000L)
            remainingSeconds -= 1
            if (remainingSeconds == 0) {
                // Auto-save nonempty text on expiry and close
                val text = rawInput.trim()
                if (text.isNotEmpty()) {
                    onSaveNote(text, noteTitle.trim().ifBlank { null })
                }
                onDismiss()
            }
        }
    }

    val progress = if (timerDurationSeconds > 0) remainingSeconds.toFloat() / timerDurationSeconds.toFloat() else 0f

    Dialog(onDismissRequest = {
        // Safe draft preservation: if closing early with non-empty text, save draft
        val text = rawInput.trim()
        if (text.isNotEmpty()) {
            onSaveNote(text, noteTitle.trim().ifBlank { null })
        }
        onDismiss()
    }) {
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, CyanAccent.copy(alpha = 0.5f)),
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.85f)
                .padding(vertical = 12.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(20.dp)
            ) {
                // Header
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("💡", fontSize = 22.sp)
                        Column {
                            Text(
                                text = "Distraction Dump",
                                style = MaterialTheme.typography.titleLarge,
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = "Capture thoughts; auto-expires in 48 hours",
                                style = MaterialTheme.typography.bodyMedium,
                                color = TextSecondary,
                                fontSize = 11.sp
                            )
                        }
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                    }
                }

                // Status Banner: Check for pending AI-locked tasks due today
                if (hasPendingAiLockedTasksToday) {
                    Spacer(modifier = Modifier.height(10.dp))
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = PriorityP1.copy(alpha = 0.15f),
                        border = androidx.compose.foundation.BorderStroke(1.dp, PriorityP1.copy(alpha = 0.4f)),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(modifier = Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("⚠️ Pending AI-locked tasks due today. Complete deep work before wandering.", fontSize = 11.sp, color = PriorityP1)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(10.dp))

                // Toggle View: Quick Dump vs Saved Notes
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = if (!viewNotesTab) CyanAccent else DarkSurfaceVariant,
                        modifier = Modifier
                            .weight(1f)
                            .clickable {
                                viewNotesTab = false
                                isTimerActive = true
                            }
                    ) {
                        Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 6.dp)) {
                            Text("Capture Scratchpad", color = if (!viewNotesTab) DarkBackground else TextSecondary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = if (viewNotesTab) CyanAccent else DarkSurfaceVariant,
                        modifier = Modifier
                            .weight(1f)
                            .clickable {
                                viewNotesTab = true
                                isTimerActive = false
                            }
                    ) {
                        Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 6.dp)) {
                            Text("Saved Notes (${notes.size})", color = if (viewNotesTab) DarkBackground else TextSecondary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                if (!viewNotesTab) {
                    // Quick Capture Scratchpad Mode
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "Auto-saving in ${remainingSeconds}s",
                            style = MaterialTheme.typography.labelSmall,
                            color = CyanAccent,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = if (isTimerActive) "⏳ Running" else "⏸️ Paused",
                            style = MaterialTheme.typography.labelSmall,
                            color = TextSecondary
                        )
                    }

                    Spacer(modifier = Modifier.height(4.dp))
                    LinearProgressIndicator(
                        progress = { progress },
                        modifier = Modifier.fillMaxWidth(),
                        color = CyanAccent,
                        trackColor = DarkSurfaceVariant
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    OutlinedTextField(
                        value = noteTitle,
                        onValueChange = { noteTitle = it },
                        placeholder = { Text("Optional title...") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = CyanAccent,
                            unfocusedBorderColor = DarkBorder,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary
                        )
                    )

                    Spacer(modifier = Modifier.height(8.dp))

                    OutlinedTextField(
                        value = rawInput,
                        onValueChange = { rawInput = it },
                        placeholder = { Text("Type distracting thought or idea now...\nSaves and closes automatically when timer ends.") },
                        maxLines = 8,
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f)
                            .testTag("distraction_scratchpad_input"),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = CyanAccent,
                            unfocusedBorderColor = DarkBorder,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary
                        )
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        Button(
                            onClick = {
                                val text = rawInput.trim()
                                if (text.isNotEmpty()) {
                                    onSaveNote(text, noteTitle.trim().ifBlank { null })
                                }
                                onDismiss()
                            },
                            enabled = rawInput.isNotBlank(),
                            colors = ButtonDefaults.buttonColors(containerColor = CyanAccent),
                            modifier = Modifier.testTag("save_and_close_scratchpad_button")
                        ) {
                            Text("Save & Return to Flow", color = DarkBackground, fontWeight = FontWeight.Bold)
                        }
                    }
                } else {
                    // Saved Notes Archive (48-hour auto-expiry)
                    if (notes.isEmpty()) {
                        Box(modifier = Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                            Text("No distraction notes logged. Mind is clear! 🧘", color = TextMuted)
                        }
                    } else {
                        val sdf = remember { SimpleDateFormat("MMM d, h:mm a", Locale.getDefault()) }
                        LazyColumn(
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            items(notes, key = { it.id }) { note ->
                                val hoursRemaining = ((note.expiresAt - System.currentTimeMillis()) / (3600 * 1000L)).coerceAtLeast(0)
                                Card(
                                    shape = RoundedCornerShape(10.dp),
                                    colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                                    border = androidx.compose.foundation.BorderStroke(0.5.dp, DarkBorder),
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth().padding(12.dp),
                                        verticalAlignment = Alignment.Top
                                    ) {
                                        Column(modifier = Modifier.weight(1f)) {
                                            if (!note.title.isNullOrBlank()) {
                                                Text(note.title, fontWeight = FontWeight.Bold, color = TextPrimary)
                                                Spacer(modifier = Modifier.height(2.dp))
                                            }
                                            Text(note.text, style = MaterialTheme.typography.bodyMedium, color = TextPrimary)
                                            Spacer(modifier = Modifier.height(6.dp))
                                            Text(
                                                text = "Created ${sdf.format(Date(note.timestamp))} · Expires in ${hoursRemaining}h",
                                                style = MaterialTheme.typography.labelSmall,
                                                color = TextMuted
                                            )
                                        }
                                        IconButton(onClick = { onDeleteNote(note.id) }, modifier = Modifier.size(28.dp)) {
                                            Icon(Icons.Default.Delete, contentDescription = "Delete", tint = TextMuted, modifier = Modifier.size(16.dp))
                                        }
                                    }
                                }
                            }
                        }

                        Spacer(modifier = Modifier.height(8.dp))
                        TextButton(onClick = onClearAll, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                            Text("Clear All Notes", color = PriorityP1, fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}
