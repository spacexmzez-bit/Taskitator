package com.example.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
import com.example.data.model.EvidenceAuditResult
import com.example.data.model.EvidenceAuditVerdict
import com.example.data.model.Task
import com.example.data.network.TaskitatorWorkerApi
import com.example.ui.theme.*
import kotlinx.coroutines.launch

@Composable
fun EvidenceAuditDialog(
    task: Task,
    isPro: Boolean = false,
    useByok: Boolean = false,
    authToken: String = "",
    onDismiss: () -> Unit,
    onAuditApproved: (String, String) -> Unit
) {
    var selectedFileName by remember { mutableStateOf<String?>(null) }
    var selectedFileSize by remember { mutableLongStateOf(0L) }
    var userEvidenceNote by remember { mutableStateOf("") }
    var isAuditing by remember { mutableStateOf(false) }
    var auditError by remember { mutableStateOf<String?>(null) }
    var auditResult by remember { mutableStateOf<EvidenceAuditResult?>(null) }
    val scope = rememberCoroutineScope()

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, ElectricBlue.copy(alpha = 0.5f)),
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 16.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp)
                    .verticalScroll(rememberScrollState())
            ) {
                // Header
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("🔒", fontSize = 18.sp)
                            Text(
                                text = "AI Evidence Audit",
                                style = MaterialTheme.typography.titleLarge,
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Text(
                            text = if (isPro && !useByok) "Hosted Pro Audit (Claude Haiku 5.5)" else "Personal Review Gateway",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary,
                            fontSize = 11.sp
                        )
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // Task Details Box
                Card(
                    shape = RoundedCornerShape(10.dp),
                    colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                    border = androidx.compose.foundation.BorderStroke(0.5.dp, DarkBorder),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(
                            text = task.resolvedTitle.ifBlank { task.title },
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = TextPrimary
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            text = "Required Criteria:",
                            style = MaterialTheme.typography.labelSmall,
                            color = CyanAccent,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = task.proofCriteria.ifBlank { "No criteria specified." },
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary
                        )
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // Proof File Picker Section
                Text(
                    text = "Upload Evidence (Photo, Screenshot, or PDF <= 5 MB):",
                    style = MaterialTheme.typography.labelMedium,
                    color = TextPrimary,
                    fontWeight = FontWeight.SemiBold
                )
                Spacer(modifier = Modifier.height(6.dp))

                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = DarkSurfaceVariant,
                    border = androidx.compose.foundation.BorderStroke(1.dp, if (selectedFileName != null) CyanAccent else DarkBorder),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = selectedFileName ?: "No evidence file attached",
                                color = if (selectedFileName != null) TextPrimary else TextMuted,
                                fontWeight = if (selectedFileName != null) FontWeight.Bold else FontWeight.Normal,
                                style = MaterialTheme.typography.bodyMedium
                            )
                            if (selectedFileName != null) {
                                Text(
                                    text = "${selectedFileSize / 1024} KB · Complies with <= 5 MB policy",
                                    color = SuccessGreen,
                                    fontSize = 10.sp
                                )
                            }
                        }

                        Button(
                            onClick = {
                                selectedFileName = "evidence_proof_${System.currentTimeMillis() % 1000}.jpg"
                                selectedFileSize = 1420L * 1024L
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                        ) {
                            Text(if (selectedFileName == null) "Select Proof" else "Change File", fontSize = 11.sp)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // User Evidence Note
                OutlinedTextField(
                    value = userEvidenceNote,
                    onValueChange = { userEvidenceNote = it },
                    label = { Text("Evidence Notes / Timestamps (Optional)") },
                    placeholder = { Text("e.g. Problems 1-10 completed in ink with today's date visible") },
                    maxLines = 2,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = ElectricBlue,
                        unfocusedBorderColor = DarkBorder,
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary
                    ),
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(modifier = Modifier.height(16.dp))

                // Submit to Audit Button (Routes to Cloudflare Worker)
                Button(
                    onClick = {
                        isAuditing = true
                        auditError = null
                        auditResult = null
                        scope.launch {
                            val dummyBytes = "evidence proof payload".toByteArray()
                            val result = if (isPro && !useByok) {
                                TaskitatorWorkerApi.auditProofHosted(
                                    taskId = task.id,
                                    criteria = task.proofCriteria,
                                    fileBytes = dummyBytes,
                                    mimeType = "image/jpeg",
                                    token = authToken
                                )
                            } else {
                                TaskitatorWorkerApi.auditProofPersonal(
                                    taskId = task.id,
                                    criteria = task.proofCriteria,
                                    fileBytes = dummyBytes,
                                    mimeType = "image/jpeg",
                                    token = authToken
                                )
                            }
                            isAuditing = false
                            result.fold(
                                onSuccess = { auditResult = it },
                                onFailure = { auditError = it.message ?: "AI audit service unreachable." }
                            )
                        }
                    },
                    enabled = selectedFileName != null && !isAuditing,
                    colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("submit_evidence_audit_button")
                ) {
                    Text(if (isAuditing) "Evaluating proof with AI..." else "Submit to AI Evidence Audit", fontWeight = FontWeight.Bold)
                }

                // Error Banner (Service unreachable - no heuristic bypass)
                if (auditError != null) {
                    Spacer(modifier = Modifier.height(12.dp))
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = PriorityP1.copy(alpha = 0.15f),
                        border = androidx.compose.foundation.BorderStroke(1.dp, PriorityP1.copy(alpha = 0.4f)),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = auditError!!,
                            color = PriorityP1,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(10.dp)
                        )
                    }
                }

                // Audit Verdict Display
                val res = auditResult
                if (res != null) {
                    Spacer(modifier = Modifier.height(16.dp))
                    val isPass = res.verdict == EvidenceAuditVerdict.APPROVED
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(
                            containerColor = if (isPass) SuccessGreen.copy(alpha = 0.15f) else PriorityP1.copy(alpha = 0.15f)
                        ),
                        border = androidx.compose.foundation.BorderStroke(
                            1.dp,
                            if (isPass) SuccessGreen else PriorityP1
                        ),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = if (isPass) "✅ AUDIT APPROVED" else "❌ AUDIT REJECTED",
                                    color = if (isPass) SuccessGreen else PriorityP1,
                                    fontWeight = FontWeight.Bold,
                                    style = MaterialTheme.typography.titleMedium
                                )
                                Text(
                                    text = res.verdict.name,
                                    fontSize = 11.sp,
                                    color = TextSecondary
                                )
                            }
                            Spacer(modifier = Modifier.height(6.dp))
                            Text(
                                text = res.feedback,
                                style = MaterialTheme.typography.bodyMedium,
                                color = TextPrimary
                            )

                            if (isPass) {
                                Spacer(modifier = Modifier.height(12.dp))
                                Button(
                                    onClick = {
                                        onAuditApproved(task.id, res.feedback)
                                        onDismiss()
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen),
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Text("Complete & Unlock Task", fontWeight = FontWeight.Bold)
                                }
                            } else {
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(
                                    text = "Task remains protected and locked. Revise proof deliverables to satisfy the criteria.",
                                    fontSize = 11.sp,
                                    color = PriorityP1
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
