package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.model.PhoneAccessDecision
import com.example.ui.theme.*

@Composable
fun PhoneAccessDialog(
    decision: PhoneAccessDecision,
    phoneToken: String,
    onDismiss: () -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, if (decision.allowed) SuccessGreen else PriorityP1),
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(if (decision.allowed) "📱" else "📵", fontSize = 20.sp)
                        Text("Phone Access & MacroDroid", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // Current Eligibility Status Card
                Card(
                    shape = RoundedCornerShape(10.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = if (decision.allowed) SuccessGreen.copy(alpha = 0.15f) else PriorityP1.copy(alpha = 0.15f)
                    ),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        Text(
                            text = if (decision.allowed) "ACCESS ALLOWED" else "PHONE ACCESS RESTRICTED",
                            color = if (decision.allowed) SuccessGreen else PriorityP1,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 13.sp
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(text = decision.reason, style = MaterialTheme.typography.bodyMedium, color = TextPrimary)
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                Text("MacroDroid Integration Endpoint:", style = MaterialTheme.typography.labelSmall, color = CyanAccent)
                Spacer(modifier = Modifier.height(4.dp))
                Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = DarkSurfaceVariant,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = "GET /api/phone-access?token=$phoneToken",
                        style = MaterialTheme.typography.bodyMedium,
                        color = LightBlue,
                        modifier = Modifier.padding(10.dp)
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Rule logic: Allowed if an Emergency Bypass is active, or user is inside a scheduled break, or all tasks due today are completed.",
                    style = MaterialTheme.typography.labelSmall,
                    color = TextMuted
                )

                Spacer(modifier = Modifier.height(16.dp))
                Button(
                    onClick = onDismiss,
                    colors = ButtonDefaults.buttonColors(containerColor = DarkSurfaceElevated),
                    modifier = Modifier.align(Alignment.End)
                ) {
                    Text("Close", color = TextPrimary)
                }
            }
        }
    }
}
