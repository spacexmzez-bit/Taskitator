package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.model.BreakInterval
import com.example.data.model.BreakPlanningState
import com.example.ui.theme.*
import kotlinx.coroutines.delay

@Composable
fun BreakPlanningDialog(
    state: BreakPlanningState,
    onStartPlanningWindow: () -> Pair<Boolean, String>,
    onLockSchedule: (List<BreakInterval>) -> Unit,
    onDismiss: () -> Unit
) {
    val intervals = remember(state.intervals) { mutableStateListOf(*state.intervals.toTypedArray()) }
    var newLabel by remember { mutableStateOf("Midday Rest") }
    var startHour by remember { mutableStateOf("12") }
    var startMinute by remember { mutableStateOf("00") }
    var endHour by remember { mutableStateOf("12") }
    var endMinute by remember { mutableStateOf("30") }
    var statusMessage by remember { mutableStateOf<String?>(null) }

    // Live countdown timer for 10-minute planning window
    var remainingSeconds by remember { mutableLongStateOf(0L) }

    LaunchedEffect(state.planningWindowDeadline) {
        while (state.planningWindowDeadline > System.currentTimeMillis()) {
            remainingSeconds = (state.planningWindowDeadline - System.currentTimeMillis()) / 1000L
            delay(1000L)
        }
        remainingSeconds = 0L
    }

    val isWindowActive = state.planningWindowDeadline > System.currentTimeMillis()

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
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
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("⏳", fontSize = 18.sp)
                            Text(
                                text = "Daily Break Planning",
                                style = MaterialTheme.typography.titleLarge,
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Text(
                            text = "10-minute schedule planning window",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary,
                            fontSize = 11.sp
                        )
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                // Planning Window Status Bar
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = when {
                        isWindowActive -> CyanAccent.copy(alpha = 0.15f)
                        state.isLocked -> SuccessGreen.copy(alpha = 0.15f)
                        state.isRepairState -> WarningAmber.copy(alpha = 0.15f)
                        else -> DarkSurfaceVariant
                    },
                    border = androidx.compose.foundation.BorderStroke(
                        1.dp,
                        when {
                            isWindowActive -> CyanAccent
                            state.isLocked -> SuccessGreen
                            state.isRepairState -> WarningAmber
                            else -> DarkBorder
                        }
                    ),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(
                                text = when {
                                    isWindowActive -> "Planning Window Active"
                                    state.isLocked -> "Schedule Locked & Pinned"
                                    state.isRepairState -> "Repair State: Single Entry"
                                    else -> "Planning Idle"
                                },
                                fontWeight = FontWeight.Bold,
                                color = when {
                                    isWindowActive -> CyanAccent
                                    state.isLocked -> SuccessGreen
                                    state.isRepairState -> WarningAmber
                                    else -> TextSecondary
                                }
                            )
                            if (isWindowActive) {
                                Text(
                                    text = "Auto-locks in ${remainingSeconds / 60}m ${remainingSeconds % 60}s",
                                    fontSize = 11.sp,
                                    color = TextPrimary
                                )
                            }
                        }

                        if (!isWindowActive && !state.isLocked) {
                            Button(
                                onClick = {
                                    val (success, msg) = onStartPlanningWindow()
                                    statusMessage = msg
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = CyanAccent),
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)
                            ) {
                                Text("Start 10m Window", color = DarkBackground, fontWeight = FontWeight.Bold, fontSize = 11.sp)
                            }
                        }
                    }
                }

                if (statusMessage != null) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(statusMessage!!, style = MaterialTheme.typography.labelSmall, color = WarningAmber)
                }

                Spacer(modifier = Modifier.height(14.dp))

                // Intervals List
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                ) {
                    Text(
                        text = "Scheduled Break Intervals (${intervals.size}):",
                        style = MaterialTheme.typography.labelMedium,
                        color = TextSecondary
                    )
                    Spacer(modifier = Modifier.height(6.dp))

                    if (intervals.isEmpty()) {
                        Text(
                            text = "No intervals scheduled yet. Add scheduled rests during deep work cycles.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextMuted
                        )
                    } else {
                        intervals.forEachIndexed { idx, iv ->
                            Card(
                                shape = RoundedCornerShape(8.dp),
                                colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp)
                            ) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(10.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Column {
                                        Text(iv.label, fontWeight = FontWeight.Bold, color = TextPrimary)
                                        Text(
                                            String.format("%02d:%02d - %02d:%02d", iv.startHour, iv.startMinute, iv.endHour, iv.endMinute),
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = CyanAccent
                                        )
                                    }
                                    if (isWindowActive || state.isRepairState) {
                                        IconButton(onClick = { intervals.removeAt(idx) }, modifier = Modifier.size(28.dp)) {
                                            Icon(Icons.Default.Delete, contentDescription = "Delete", tint = TextMuted, modifier = Modifier.size(16.dp))
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Add Interval Section (only when window is active or repair)
                    if (isWindowActive || state.isRepairState) {
                        Spacer(modifier = Modifier.height(14.dp))
                        Text("Add New Interval:", style = MaterialTheme.typography.labelSmall, color = CyanAccent)
                        Spacer(modifier = Modifier.height(6.dp))

                        OutlinedTextField(
                            value = newLabel,
                            onValueChange = { newLabel = it },
                            label = { Text("Label") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )

                        Spacer(modifier = Modifier.height(6.dp))

                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedTextField(value = startHour, onValueChange = { startHour = it }, label = { Text("Start H") }, modifier = Modifier.weight(1f))
                            OutlinedTextField(value = startMinute, onValueChange = { startMinute = it }, label = { Text("Start M") }, modifier = Modifier.weight(1f))
                            OutlinedTextField(value = endHour, onValueChange = { endHour = it }, label = { Text("End H") }, modifier = Modifier.weight(1f))
                            OutlinedTextField(value = endMinute, onValueChange = { endMinute = it }, label = { Text("End M") }, modifier = Modifier.weight(1f))
                        }

                        Spacer(modifier = Modifier.height(8.dp))

                        Button(
                            onClick = {
                                val sH = startHour.toIntOrNull()?.coerceIn(0, 23) ?: 12
                                val sM = startMinute.toIntOrNull()?.coerceIn(0, 59) ?: 0
                                val eH = endHour.toIntOrNull()?.coerceIn(0, 23) ?: 12
                                val eM = endMinute.toIntOrNull()?.coerceIn(0, 59) ?: 30
                                intervals.add(
                                    BreakInterval(
                                        startHour = sH,
                                        startMinute = sM,
                                        endHour = eH,
                                        endMinute = eM,
                                        label = newLabel.trim().ifBlank { "Break" }
                                    )
                                )
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = DarkSurfaceElevated),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Add Interval", color = TextPrimary)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // Lock Early Button
                if (isWindowActive || state.isRepairState) {
                    Button(
                        onClick = {
                            onLockSchedule(intervals.toList())
                            onDismiss()
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen),
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("lock_break_schedule_button")
                    ) {
                        Text("Lock & Pin Schedule Early", color = DarkBackground, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}
