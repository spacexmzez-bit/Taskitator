package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.model.BreakSession
import com.example.data.model.BreakType
import com.example.data.model.UserSettings
import com.example.ui.theme.*

@Composable
fun PomodoroTimerDialog(
    settings: UserSettings,
    breaks: List<BreakSession>,
    isTimerRunning: Boolean,
    isBreakMode: Boolean,
    remainingSeconds: Int,
    totalSeconds: Int,
    onStartTimer: () -> Unit,
    onPauseTimer: () -> Unit,
    onResetTimer: () -> Unit,
    onSwitchMode: (Boolean) -> Unit,
    onDismiss: () -> Unit
) {
    val minutes = remainingSeconds / 60
    val seconds = remainingSeconds % 60
    val timeFormatted = String.format("%02d:%02d", minutes, seconds)
    val progress = if (totalSeconds > 0) remainingSeconds.toFloat() / totalSeconds.toFloat() else 1f

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 16.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Header
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = if (isBreakMode) "☕ Break Time" else "🎯 Focus Session",
                        style = MaterialTheme.typography.titleLarge,
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Mode Selector Toggle (Focus vs Break)
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(12.dp))
                        .background(DarkSurfaceVariant)
                        .padding(4.dp),
                    horizontalArrangement = Arrangement.Center
                ) {
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = if (!isBreakMode) ElectricBlue else Color.Transparent,
                        modifier = Modifier
                            .clickable { onSwitchMode(false) }
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    ) {
                        Text(
                            text = "Focus (${settings.workDurationMinutes}m)",
                            style = MaterialTheme.typography.labelLarge,
                            color = if (!isBreakMode) TextPrimary else TextSecondary
                        )
                    }

                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = if (isBreakMode) SuccessGreen else Color.Transparent,
                        modifier = Modifier
                            .clickable { onSwitchMode(true) }
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    ) {
                        Text(
                            text = "Break (${settings.shortBreakMinutes}m)",
                            style = MaterialTheme.typography.labelLarge,
                            color = if (isBreakMode) TextPrimary else TextSecondary
                        )
                    }
                }

                Spacer(modifier = Modifier.height(28.dp))

                // Circular Progress & Timer Display
                Box(
                    modifier = Modifier.size(190.dp),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator(
                        progress = { progress },
                        modifier = Modifier.fillMaxSize(),
                        color = if (isBreakMode) SuccessGreen else ElectricBlue,
                        trackColor = DarkSurfaceVariant,
                        strokeWidth = 10.dp
                    )
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = timeFormatted,
                            style = MaterialTheme.typography.headlineLarge,
                            color = TextPrimary,
                            fontSize = 38.sp,
                            fontWeight = FontWeight.ExtraBold
                        )
                        Text(
                            text = if (isBreakMode) "Recharge" else "Deep Flow",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (isBreakMode) SuccessGreen else CyanAccent
                        )
                    }
                }

                Spacer(modifier = Modifier.height(28.dp))

                // Controls: Play / Pause / Reset
                Row(
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    IconButton(
                        onClick = onResetTimer,
                        modifier = Modifier
                            .size(48.dp)
                            .clip(CircleShape)
                            .background(DarkSurfaceVariant)
                            .testTag("reset_timer_button")
                    ) {
                        Icon(Icons.Default.Refresh, contentDescription = "Reset timer", tint = TextSecondary)
                    }

                    Button(
                        onClick = { if (isTimerRunning) onPauseTimer() else onStartTimer() },
                        shape = CircleShape,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (isBreakMode) SuccessGreen else ElectricBlue
                        ),
                        modifier = Modifier
                            .size(64.dp)
                            .testTag("toggle_timer_button"),
                        contentPadding = PaddingValues(0.dp)
                    ) {
                        if (isTimerRunning) {
                            Text("⏸️", fontSize = 24.sp)
                        } else {
                            Icon(
                                Icons.Default.PlayArrow,
                                contentDescription = "Start timer",
                                tint = TextPrimary,
                                modifier = Modifier.size(32.dp)
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(20.dp))

                // Today's Break Tracker Pill
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = DarkSurfaceVariant,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "Daily Breaks Progress",
                            style = MaterialTheme.typography.labelLarge,
                            color = TextSecondary
                        )
                        Text(
                            text = "${breaks.size} / ${settings.dailyBreakTarget} completed",
                            style = MaterialTheme.typography.labelLarge,
                            color = if (breaks.size >= settings.dailyBreakTarget) SuccessGreen else TextPrimary,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }
    }
}
