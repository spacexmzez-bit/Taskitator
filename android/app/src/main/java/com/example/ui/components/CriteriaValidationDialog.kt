package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.model.CriteriaTemplate
import com.example.data.model.CriteriaValidationResult
import com.example.data.model.SavedCriteria
import com.example.data.network.TaskitatorWorkerApi
import com.example.data.util.CriteriaValidator
import com.example.ui.theme.*
import kotlinx.coroutines.launch

@Composable
fun CriteriaValidationDialog(
    initialCriteria: String,
    taskTitle: String,
    savedCriteriaList: List<SavedCriteria>,
    authToken: String = "",
    strictCriteriaValidation: Boolean = true,
    onDismiss: () -> Unit,
    onSaveToCustom: (String, Int) -> Boolean,
    onCriteriaConfirmed: (String, CriteriaValidationResult) -> Unit
) {
    val context = LocalContext.current
    var criteriaInput by remember { mutableStateOf(initialCriteria) }
    var exemplarInput by remember { mutableStateOf("") }
    var validationResult by remember { mutableStateOf<CriteriaValidationResult?>(null) }
    var selectedTab by remember { mutableIntStateOf(0) }
    var savedSuccessMsg by remember { mutableStateOf<String?>(null) }

    val templates = remember { CriteriaValidator.loadTemplatesFromAsset(context) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, ElectricBlue.copy(alpha = 0.5f)),
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.9f)
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
                            Text("🛡️", fontSize = 18.sp)
                            Text(
                                text = "Criteria Validator",
                                style = MaterialTheme.typography.titleLarge,
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Text(
                            text = "Cloudflare Worker AI Gateway · Pass Threshold: 7/10",
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

                // Navigation Tabs
                TabRow(
                    selectedTabIndex = selectedTab,
                    containerColor = DarkSurfaceVariant,
                    contentColor = ElectricBlue
                ) {
                    Tab(
                        selected = selectedTab == 0,
                        onClick = { selectedTab = 0 },
                        text = { Text("Editor", fontSize = 12.sp, fontWeight = FontWeight.Bold) }
                    )
                    Tab(
                        selected = selectedTab == 1,
                        onClick = { selectedTab = 1 },
                        text = { Text("Templates (${templates.size})", fontSize = 12.sp, fontWeight = FontWeight.Bold) }
                    )
                    Tab(
                        selected = selectedTab == 2,
                        onClick = { selectedTab = 2 },
                        text = { Text("Saved (${savedCriteriaList.size}/6)", fontSize = 12.sp, fontWeight = FontWeight.Bold) }
                    )
                }

                Spacer(modifier = Modifier.height(14.dp))

                Box(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                ) {
                    when (selectedTab) {
                        0 -> {
                            Column {
                                if (taskTitle.isNotBlank()) {
                                    Text(
                                        text = "Task: $taskTitle",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = TextSecondary,
                                        fontWeight = FontWeight.SemiBold
                                    )
                                    Spacer(modifier = Modifier.height(8.dp))
                                }

                                Text(
                                    text = "Proof Criteria Statement:",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TextPrimary,
                                    fontWeight = FontWeight.Bold
                                )
                                Spacer(modifier = Modifier.height(4.dp))

                                OutlinedTextField(
                                    value = criteriaInput,
                                    onValueChange = { criteriaInput = it },
                                    placeholder = { Text("Specify unambiguous proof: medium, date/time in ink, measurable count...") },
                                    minLines = 3,
                                    colors = OutlinedTextFieldDefaults.colors(
                                        focusedBorderColor = ElectricBlue,
                                        unfocusedBorderColor = DarkBorder,
                                        focusedTextColor = TextPrimary,
                                        unfocusedTextColor = TextPrimary
                                    ),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .testTag("criteria_input_field")
                                )

                                Spacer(modifier = Modifier.height(10.dp))

                                Text(
                                    text = "Exemplar / Acceptance Notes (Optional):",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = TextSecondary
                                )
                                Spacer(modifier = Modifier.height(4.dp))

                                OutlinedTextField(
                                    value = exemplarInput,
                                    onValueChange = { exemplarInput = it },
                                    placeholder = { Text("Optional reference exemplar / acceptance notes...") },
                                    maxLines = 2,
                                    colors = OutlinedTextFieldDefaults.colors(
                                        focusedBorderColor = CyanAccent,
                                        unfocusedBorderColor = DarkBorder,
                                        focusedTextColor = TextPrimary,
                                        unfocusedTextColor = TextPrimary
                                    ),
                                    modifier = Modifier.fillMaxWidth()
                                )

                                Spacer(modifier = Modifier.height(12.dp))

                                var isChecking by remember { mutableStateOf(false) }
                                var validationError by remember { mutableStateOf<String?>(null) }
                                val scope = rememberCoroutineScope()

                                // Validate Button
                                Button(
                                    onClick = {
                                        isChecking = true
                                        validationError = null
                                        validationResult = null
                                        scope.launch {
                                            val result = TaskitatorWorkerApi.validateCriteria(
                                                criteria = criteriaInput,
                                                exemplarNote = exemplarInput.takeIf { it.isNotBlank() },
                                                token = authToken
                                            )
                                            isChecking = false
                                            result.fold(
                                                onSuccess = { validationResult = it },
                                                onFailure = { validationError = it.message ?: "AI service unreachable." }
                                            )
                                        }
                                    },
                                    enabled = criteriaInput.isNotBlank() && !isChecking,
                                    colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .testTag("validate_criteria_button")
                                ) {
                                    Text(if (isChecking) "Checking with Cloudflare AI..." else "Check Criteria with AI (Score /10)", fontWeight = FontWeight.Bold)
                                }

                                if (validationError != null) {
                                    Spacer(modifier = Modifier.height(10.dp))
                                    Surface(
                                        shape = RoundedCornerShape(8.dp),
                                        color = PriorityP1.copy(alpha = 0.15f),
                                        border = androidx.compose.foundation.BorderStroke(1.dp, PriorityP1.copy(alpha = 0.4f)),
                                        modifier = Modifier.fillMaxWidth()
                                    ) {
                                        Column(modifier = Modifier.padding(10.dp)) {
                                            Text(
                                                text = validationError!!,
                                                color = PriorityP1,
                                                style = MaterialTheme.typography.bodyMedium
                                            )
                                        }
                                    }
                                }

                                val res = validationResult
                                if (res != null) {
                                    Spacer(modifier = Modifier.height(14.dp))
                                    Card(
                                        shape = RoundedCornerShape(12.dp),
                                        colors = CardDefaults.cardColors(
                                            containerColor = if (res.isValid) SuccessGreen.copy(alpha = 0.15f) else PriorityP1.copy(alpha = 0.15f)
                                        ),
                                        border = androidx.compose.foundation.BorderStroke(
                                            1.dp,
                                            if (res.isValid) SuccessGreen else PriorityP1
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
                                                    text = if (res.isValid) "✅ PASSED (${res.score}/10)" else "❌ NEEDS REVISION (${res.score}/10)",
                                                    color = if (res.isValid) SuccessGreen else PriorityP1,
                                                    fontWeight = FontWeight.Bold,
                                                    style = MaterialTheme.typography.titleMedium
                                                )
                                                Text(
                                                    text = if (res.isValid) "Passes Gate (>=7)" else "Below 7/10 Gate",
                                                    fontSize = 11.sp,
                                                    color = TextSecondary
                                                )
                                            }

                                            Spacer(modifier = Modifier.height(6.dp))
                                            Text(
                                                text = res.critique,
                                                style = MaterialTheme.typography.bodyMedium,
                                                color = TextPrimary
                                            )

                                            if (res.suggestedRewrite != null) {
                                                Spacer(modifier = Modifier.height(10.dp))
                                                Surface(
                                                    shape = RoundedCornerShape(8.dp),
                                                    color = DarkSurface,
                                                    border = androidx.compose.foundation.BorderStroke(0.5.dp, DarkBorder),
                                                    modifier = Modifier.fillMaxWidth()
                                                ) {
                                                    Column(modifier = Modifier.padding(10.dp)) {
                                                        Text("Suggested Rewrite:", fontSize = 11.sp, color = CyanAccent, fontWeight = FontWeight.Bold)
                                                        Spacer(modifier = Modifier.height(4.dp))
                                                        Text(res.suggestedRewrite, style = MaterialTheme.typography.bodyMedium, color = TextPrimary)
                                                        Spacer(modifier = Modifier.height(6.dp))
                                                        OutlinedButton(
                                                            onClick = { criteriaInput = res.suggestedRewrite },
                                                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)
                                                        ) {
                                                            Text("Apply Rewrite", fontSize = 11.sp)
                                                        }
                                                    }
                                                }
                                            }

                                            if (res.score >= 9) {
                                                Spacer(modifier = Modifier.height(10.dp))
                                                OutlinedButton(
                                                    onClick = {
                                                        val saved = onSaveToCustom(criteriaInput, res.score)
                                                        savedSuccessMsg = if (saved) "Saved to presets!" else "Preset limit reached (max 6)."
                                                    },
                                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = CyanAccent),
                                                    border = androidx.compose.foundation.BorderStroke(1.dp, CyanAccent)
                                                ) {
                                                    Text(savedSuccessMsg ?: "⭐ Save as Custom Criteria (9+/10)", fontSize = 11.sp)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        1 -> {
                            // 11 Templates from bundled CRITERIA_TEMPLATES.json
                            Column {
                                Text(
                                    text = "Select an official pre-verified template (${templates.size}):",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = TextSecondary
                                )
                                Spacer(modifier = Modifier.height(8.dp))

                                templates.forEach { tmpl ->
                                    Card(
                                        shape = RoundedCornerShape(10.dp),
                                        colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                                        border = androidx.compose.foundation.BorderStroke(0.5.dp, DarkBorder),
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(vertical = 4.dp)
                                            .clickable {
                                                criteriaInput = tmpl.template
                                                selectedTab = 0
                                            }
                                    ) {
                                        Column(modifier = Modifier.padding(12.dp)) {
                                            Text(tmpl.label, fontWeight = FontWeight.Bold, color = TextPrimary)
                                            Text(tmpl.category, fontSize = 10.sp, color = CyanAccent)
                                            Spacer(modifier = Modifier.height(4.dp))
                                            Text(tmpl.template, style = MaterialTheme.typography.bodyMedium, color = TextSecondary, maxLines = 3)
                                        }
                                    }
                                }
                            }
                        }

                        2 -> {
                            // Saved Criteria (Max 6)
                            Column {
                                Text(
                                    text = "Your saved high-score presets (score >= 9/10):",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = TextSecondary
                                )
                                Spacer(modifier = Modifier.height(8.dp))

                                if (savedCriteriaList.isEmpty()) {
                                    Text(
                                        text = "No custom criteria saved yet. Validate criteria with score 9/10 or higher to save here.",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = TextMuted
                                    )
                                } else {
                                    savedCriteriaList.forEach { saved ->
                                        Card(
                                            shape = RoundedCornerShape(10.dp),
                                            colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                                            border = androidx.compose.foundation.BorderStroke(0.5.dp, DarkBorder),
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(vertical = 4.dp)
                                                .clickable {
                                                    criteriaInput = saved.criteria
                                                    selectedTab = 0
                                                }
                                        ) {
                                            Column(modifier = Modifier.padding(12.dp)) {
                                                Row(
                                                    modifier = Modifier.fillMaxWidth(),
                                                    horizontalArrangement = Arrangement.SpaceBetween
                                                ) {
                                                    Text(saved.title.ifBlank { "Custom Preset" }, fontWeight = FontWeight.Bold, color = TextPrimary)
                                                    Text("Score ${saved.score}/10", color = SuccessGreen, fontWeight = FontWeight.Bold, fontSize = 11.sp)
                                                }
                                                Spacer(modifier = Modifier.height(4.dp))
                                                Text(saved.criteria, style = MaterialTheme.typography.bodyMedium, color = TextSecondary, maxLines = 3)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                // Footer
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End
                ) {
                    TextButton(onClick = onDismiss) {
                        Text("Cancel", color = TextSecondary)
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            val res = validationResult
                            if (res != null) {
                                onCriteriaConfirmed(criteriaInput, res)
                            }
                        },
                        enabled = criteriaInput.isNotBlank() && validationResult != null && (!strictCriteriaValidation || validationResult!!.isValid),
                        colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                        modifier = Modifier.testTag("confirm_criteria_button")
                    ) {
                        Text("Use This Criteria", fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}
