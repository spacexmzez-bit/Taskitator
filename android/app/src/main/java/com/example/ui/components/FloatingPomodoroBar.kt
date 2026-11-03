package com.example.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.PomodoroMode
import com.example.data.model.PomodoroState
import com.example.data.model.Task
import com.example.ui.theme.*

@Composable
fun FloatingPomodoroBar(
    pomodoroState: PomodoroState,
    focusedTask: Task?,
    onPlayPause: () -> Unit,
    onReset: () -> Unit,
    onSkipMode: () -> Unit,
    modifier: Modifier = Modifier
) {
    val minutes = pomodoroState.remainingSeconds / 60
    val seconds = pomodoroState.remainingSeconds % 60
    val formattedTime = String.format("%02d:%02d", minutes, seconds)

    val modeColor = when (pomodoroState.mode) {
        PomodoroMode.WORK -> ElectricBlue
        PomodoroMode.SHORT_BREAK -> SuccessGreen
        PomodoroMode.LONG_BREAK -> WarningAmber
    }

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = DarkSurfaceElevated,
        border = androidx.compose.foundation.BorderStroke(1.5.dp, modeColor.copy(alpha = 0.6f)),
        shadowElevation = 8.dp,
        modifier = modifier
            .fillMaxWidth()
            .testTag("floating_pomodoro_bar")
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            // Timer & Mode Indicator
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.weight(1f)
            ) {
                Surface(
                    shape = CircleShape,
                    color = modeColor.copy(alpha = 0.2f),
                    modifier = Modifier.size(40.dp)
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            text = if (pomodoroState.mode == PomodoroMode.WORK) "🍅" else "☕",
                            fontSize = 20.sp
                        )
                    }
                }

                Column(modifier = Modifier.weight(1f)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Text(
                            text = pomodoroState.mode.displayName,
                            style = MaterialTheme.typography.labelSmall,
                            color = modeColor,
                            fontWeight = FontWeight.Bold
                        )
                        Surface(
                            shape = RoundedCornerShape(4.dp),
                            color = DarkSurfaceVariant
                        ) {
                            Text(
                                text = "Cycle ${pomodoroState.completedSessions + 1}",
                                style = MaterialTheme.typography.labelSmall,
                                color = TextMuted,
                                fontSize = 10.sp,
                                modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp)
                            )
                        }
                    }

                    Text(
                        text = focusedTask?.title ?: "Free Focus Interval",
                        style = MaterialTheme.typography.bodyMedium,
                        color = TextPrimary,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            // Big Timer Display & Play/Pause controls
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = formattedTime,
                    style = MaterialTheme.typography.titleLarge,
                    color = TextPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp
                )

                // Play / Pause Button
                IconButton(
                    onClick = onPlayPause,
                    modifier = Modifier
                        .size(38.dp)
                        .clip(CircleShape)
                        .background(modeColor)
                        .testTag("pomodoro_play_pause_button")
                ) {
                    if (pomodoroState.isRunning) {
                        Text("⏸", fontSize = 16.sp, color = DarkBackground, fontWeight = FontWeight.Bold)
                    } else {
                        Icon(
                            Icons.Default.PlayArrow,
                            contentDescription = "Start Pomodoro",
                            tint = DarkBackground
                        )
                    }
                }

                // Reset Button
                IconButton(
                    onClick = onReset,
                    modifier = Modifier
                        .size(32.dp)
                        .testTag("pomodoro_reset_button")
                ) {
                    Icon(
                        Icons.Default.Refresh,
                        contentDescription = "Reset timer",
                        tint = TextSecondary,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }
    }
}
