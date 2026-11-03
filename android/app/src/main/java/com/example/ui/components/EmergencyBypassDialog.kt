package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.window.Dialog
import com.example.data.model.UserSettings
import com.example.ui.theme.*
import kotlinx.coroutines.delay

@Composable
fun EmergencyBypassDialog(
    settings: UserSettings,
    onActivateBypass: () -> Pair<Boolean, String>,
    onDeactivateBypass: () -> Unit,
    onDismiss: () -> Unit
) {
    var activationFeedback by remember { mutableStateOf<String?>(null) }
    var remainingBypassSeconds by remember { mutableLongStateOf(0L) }

    LaunchedEffect(settings.emergencyBypassUntil, settings.emergencyBypassActive) {
        while (settings.emergencyBypassActive && settings.emergencyBypassUntil > System.currentTimeMillis()) {
            remainingBypassSeconds = (settings.emergencyBypassUntil - System.currentTimeMillis()) / 1000L
            delay(1000L)
        }
        remainingBypassSeconds = 0L
    }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.5.dp, DangerRed.copy(alpha = 0.6f)),
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("🚨", fontSize = 22.sp)
                        Text("Emergency Bypass", style = MaterialTheme.typography.titleLarge, color = DangerRed, fontWeight = FontWeight.Bold)
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // Uses & Reset Info Card
                Card(
                    shape = RoundedCornerShape(10.dp),
                    colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text("Uses Remaining This Cycle", style = MaterialTheme.typography.labelSmall, color = TextSecondary)
                            Text("${settings.emergencyBypassUsesRemaining} / 4 uses", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text("Cycle Reset", style = MaterialTheme.typography.labelSmall, color = TextSecondary)
                            Text(settings.emergencyCycleResetDate.ifBlank { "Next Monday" }, style = MaterialTheme.typography.labelMedium, color = CyanAccent)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                if (settings.emergencyBypassActive) {
                    Card(
                        shape = RoundedCornerShape(10.dp),
                        colors = CardDefaults.cardColors(containerColor = DangerRed.copy(alpha = 0.15f)),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DangerRed),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Text("EMERGENCY UNLOCK ACTIVE", color = DangerRed, fontWeight = FontWeight.ExtraBold)
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = "Time remaining: ${remainingBypassSeconds / 60}m ${remainingBypassSeconds % 60}s",
                                style = MaterialTheme.typography.bodyLarge,
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.height(4.dp))
                            Text("All AI locks and deletion shields are temporarily suspended.", fontSize = 11.sp, color = TextSecondary)
                        }
                    }

                    Spacer(modifier = Modifier.height(18.dp))
                    Button(
                        onClick = {
                            onDeactivateBypass()
                            onDismiss()
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = DarkSurfaceElevated),
                        modifier = Modifier.fillMaxWidth().testTag("deactivate_bypass_button")
                    ) {
                        Text("Deactivate Bypass Early", color = TextPrimary)
                    }
                } else {
                    Text(
                        text = "Taskitator locks high-focus tasks to protect your commitments. " +
                                "Emergency Bypass temporarily unlocks all tasks and allows deletion for 15 minutes. " +
                                "Limited to 4 activations per weekly cycle.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = TextSecondary
                    )

                    if (activationFeedback != null) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(activationFeedback!!, style = MaterialTheme.typography.labelSmall, color = PriorityP1)
                    }

                    Spacer(modifier = Modifier.height(18.dp))

                    Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                        TextButton(onClick = onDismiss) { Text("Cancel", color = TextSecondary) }
                        Spacer(modifier = Modifier.width(8.dp))
                        Button(
                            onClick = {
                                val (ok, msg) = onActivateBypass()
                                activationFeedback = msg
                                if (ok) onDismiss()
                            },
                            enabled = settings.emergencyBypassUsesRemaining > 0,
                            colors = ButtonDefaults.buttonColors(containerColor = DangerRed),
                            modifier = Modifier.testTag("confirm_bypass_button")
                        ) {
                            Text("Activate 15m Unlock", color = TextPrimary, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}
