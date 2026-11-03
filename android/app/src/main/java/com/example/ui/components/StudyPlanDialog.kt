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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.model.StudyPlanConfig
import com.example.data.model.StudyPlanDayPreview
import com.example.data.model.Task
import com.example.data.util.DateUtils
import com.example.data.util.StudyPlanGenerator
import com.example.ui.theme.*

@Composable
fun StudyPlanDialog(
    isPro: Boolean,
    onDismiss: () -> Unit,
    onConfirmPlan: (List<Task>) -> Unit
) {
    val today = remember { DateUtils.getLogicalDate(0) }
    var planTitle by remember { mutableStateOf("Calculus Exam Preparation") }
    var unitName by remember { mutableStateOf("Chapter") }
    var totalUnits by remember { mutableStateOf("12") }
    var studyDays by remember { mutableStateOf("6") }
    var startingUnit by remember { mutableStateOf("1") }
    var startDate by remember { mutableStateOf(today) }
    var selectedWeekdays by remember { mutableStateOf(setOf(1, 2, 3, 4, 5)) } // Mon-Fri
    var sharedCriteria by remember { mutableStateOf("Show completed handwritten summary notes and solved practice drills for {unit_name} {num}.") }
    var enableAiAudits by remember { mutableStateOf(true) }

    // Smart Study Controls (Pro)
    var smartStudyEnabled by remember { mutableStateOf(false) }
    var smartStudyMode by remember { mutableStateOf("lighten_original") } // "lighten_original", "lighten_weekend", "lighten_selected"

    var previewDays by remember { mutableStateOf<List<StudyPlanDayPreview>?>(null) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
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
                            Text("📚", fontSize = 18.sp)
                            Text(
                                text = "Study Recurrence · Pro",
                                style = MaterialTheme.typography.titleLarge,
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Text(
                            text = "Generate a finite, structured study plan tree",
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

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                ) {
                    if (previewDays == null) {
                        // Configuration Form
                        OutlinedTextField(
                            value = planTitle,
                            onValueChange = { planTitle = it },
                            label = { Text("Plan Title") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = ElectricBlue,
                                unfocusedBorderColor = DarkBorder,
                                focusedTextColor = TextPrimary,
                                unfocusedTextColor = TextPrimary
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )

                        Spacer(modifier = Modifier.height(10.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            OutlinedTextField(
                                value = unitName,
                                onValueChange = { unitName = it },
                                label = { Text("Unit Name") },
                                placeholder = { Text("Chapter, Lesson") },
                                singleLine = true,
                                modifier = Modifier.weight(1f),
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = ElectricBlue,
                                    unfocusedBorderColor = DarkBorder,
                                    focusedTextColor = TextPrimary,
                                    unfocusedTextColor = TextPrimary
                                )
                            )
                            OutlinedTextField(
                                value = totalUnits,
                                onValueChange = { totalUnits = it },
                                label = { Text("Total Units (1-1000)") },
                                singleLine = true,
                                modifier = Modifier.weight(1f),
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = ElectricBlue,
                                    unfocusedBorderColor = DarkBorder,
                                    focusedTextColor = TextPrimary,
                                    unfocusedTextColor = TextPrimary
                                )
                            )
                        }

                        Spacer(modifier = Modifier.height(10.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            OutlinedTextField(
                                value = studyDays,
                                onValueChange = { studyDays = it },
                                label = { Text("Study Days (1-365)") },
                                singleLine = true,
                                modifier = Modifier.weight(1f),
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = ElectricBlue,
                                    unfocusedBorderColor = DarkBorder,
                                    focusedTextColor = TextPrimary,
                                    unfocusedTextColor = TextPrimary
                                )
                            )
                            OutlinedTextField(
                                value = startingUnit,
                                onValueChange = { startingUnit = it },
                                label = { Text("Start Unit #") },
                                singleLine = true,
                                modifier = Modifier.weight(1f),
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = ElectricBlue,
                                    unfocusedBorderColor = DarkBorder,
                                    focusedTextColor = TextPrimary,
                                    unfocusedTextColor = TextPrimary
                                )
                            )
                        }

                        Spacer(modifier = Modifier.height(10.dp))

                        OutlinedTextField(
                            value = startDate,
                            onValueChange = { startDate = it },
                            label = { Text("Start Date (YYYY-MM-DD)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = ElectricBlue,
                                unfocusedBorderColor = DarkBorder,
                                focusedTextColor = TextPrimary,
                                unfocusedTextColor = TextPrimary
                            )
                        )

                        Spacer(modifier = Modifier.height(12.dp))

                        Text("Study Weekdays (selecting none means every day):", style = MaterialTheme.typography.labelSmall, color = TextSecondary)
                        Spacer(modifier = Modifier.height(4.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            val daysLabels = listOf(1 to "M", 2 to "Tu", 3 to "W", 4 to "Th", 5 to "F", 6 to "Sa", 7 to "Su")
                            daysLabels.forEach { (num, label) ->
                                val isSel = num in selectedWeekdays
                                Surface(
                                    shape = RoundedCornerShape(6.dp),
                                    color = if (isSel) ElectricBlue else DarkSurfaceVariant,
                                    modifier = Modifier
                                        .weight(1f)
                                        .clickable {
                                            selectedWeekdays = if (isSel) selectedWeekdays - num else selectedWeekdays + num
                                        }
                                ) {
                                    Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 6.dp)) {
                                        Text(label, color = TextPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                    }
                                }
                            }
                        }

                        Spacer(modifier = Modifier.height(12.dp))

                        // Shared AI Criteria for Units
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = enableAiAudits, onCheckedChange = { enableAiAudits = it })
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Enable AI Evidence Audits for Unit Subtasks", style = MaterialTheme.typography.bodyMedium, color = TextPrimary)
                        }

                        if (enableAiAudits) {
                            OutlinedTextField(
                                value = sharedCriteria,
                                onValueChange = { sharedCriteria = it },
                                label = { Text("Shared Proof Criteria ({num} is replaced by unit #)") },
                                maxLines = 3,
                                modifier = Modifier.fillMaxWidth(),
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = CyanAccent,
                                    unfocusedBorderColor = DarkBorder,
                                    focusedTextColor = TextPrimary,
                                    unfocusedTextColor = TextPrimary
                                )
                            )
                        }

                        Spacer(modifier = Modifier.height(14.dp))

                        // Smart Study Toggle (Pro)
                        Card(
                            shape = RoundedCornerShape(10.dp),
                            colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Switch(
                                        checked = smartStudyEnabled,
                                        onCheckedChange = { smartStudyEnabled = it }
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Column {
                                        Text("Smart Study Recurrence · Pro", fontWeight = FontWeight.Bold, color = TextPrimary)
                                        Text("Show future units early as bonus opportunities", fontSize = 11.sp, color = TextSecondary)
                                    }
                                }

                                if (smartStudyEnabled) {
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text("Adjustment Mode:", style = MaterialTheme.typography.labelSmall, color = CyanAccent)
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                        listOf(
                                            "lighten_original" to "Lighten Original",
                                            "lighten_weekend" to "Lighten Weekend",
                                            "lighten_selected" to "Lighten Selected"
                                        ).forEach { (mode, label) ->
                                            val isSel = smartStudyMode == mode
                                            Surface(
                                                shape = RoundedCornerShape(6.dp),
                                                color = if (isSel) CyanAccent.copy(alpha = 0.25f) else DarkSurfaceElevated,
                                                border = if (isSel) androidx.compose.foundation.BorderStroke(1.dp, CyanAccent) else null,
                                                modifier = Modifier
                                                    .weight(1f)
                                                    .clickable { smartStudyMode = mode }
                                            ) {
                                                Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 6.dp)) {
                                                    Text(label, fontSize = 10.sp, color = if (isSel) CyanAccent else TextSecondary, fontWeight = FontWeight.Bold)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        Spacer(modifier = Modifier.height(16.dp))

                        Button(
                            onClick = {
                                val cfg = StudyPlanConfig(
                                    title = planTitle.trim().ifBlank { "Study Plan" },
                                    unitName = unitName.trim().ifBlank { "Chapter" },
                                    totalUnits = totalUnits.toIntOrNull() ?: 12,
                                    studyDays = studyDays.toIntOrNull() ?: 6,
                                    startingUnit = startingUnit.toIntOrNull() ?: 1,
                                    startDate = startDate.trim().ifBlank { today },
                                    studyWeekdays = selectedWeekdays.toList(),
                                    sharedCriteria = sharedCriteria.trim(),
                                    enableAiAudits = enableAiAudits,
                                    smartStudyEnabled = smartStudyEnabled,
                                    smartStudyMode = smartStudyMode
                                )
                                previewDays = StudyPlanGenerator.generatePreview(cfg)
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("generate_study_preview_button")
                        ) {
                            Text("Generate Editable Plan Preview", fontWeight = FontWeight.Bold)
                        }
                    } else {
                        // Preview Mode
                        Text(
                            text = "Plan Preview (${previewDays?.size} Days)",
                            style = MaterialTheme.typography.titleMedium,
                            color = TextPrimary,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "Review scheduled distribution before creating tasks:",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TextSecondary,
                            fontSize = 11.sp
                        )

                        Spacer(modifier = Modifier.height(10.dp))

                        previewDays?.forEach { day ->
                            Card(
                                shape = RoundedCornerShape(10.dp),
                                colors = CardDefaults.cardColors(containerColor = DarkSurfaceVariant),
                                border = androidx.compose.foundation.BorderStroke(0.5.dp, DarkBorder),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp)
                            ) {
                                Column(modifier = Modifier.padding(10.dp)) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween
                                    ) {
                                        Text("Day ${day.dayNumber}: ${day.date}", fontWeight = FontWeight.Bold, color = TextPrimary)
                                        Text("🛡️ Strict prerequisite", fontSize = 10.sp, color = CyanAccent)
                                    }
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Text(
                                        text = "Required: " + day.unitNumbers.joinToString(", ") { "$unitName $it" },
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = TextSecondary
                                    )
                                    if (day.earlyBonusUnits.isNotEmpty()) {
                                        Spacer(modifier = Modifier.height(2.dp))
                                        Text(
                                            text = "⭐ Early Bonus: " + day.earlyBonusUnits.joinToString(", ") { "$unitName $it" },
                                            style = MaterialTheme.typography.labelSmall,
                                            color = WarningAmber
                                        )
                                    }
                                }
                            }
                        }

                        Spacer(modifier = Modifier.height(16.dp))

                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(
                                onClick = { previewDays = null },
                                modifier = Modifier.weight(1f)
                            ) {
                                Text("Edit Settings", color = TextSecondary)
                            }

                            Button(
                                onClick = {
                                    val cfg = StudyPlanConfig(
                                        title = planTitle.trim().ifBlank { "Study Plan" },
                                        unitName = unitName.trim().ifBlank { "Chapter" },
                                        totalUnits = totalUnits.toIntOrNull() ?: 12,
                                        studyDays = studyDays.toIntOrNull() ?: 6,
                                        startingUnit = startingUnit.toIntOrNull() ?: 1,
                                        startDate = startDate.trim().ifBlank { today },
                                        studyWeekdays = selectedWeekdays.toList(),
                                        sharedCriteria = sharedCriteria.trim(),
                                        enableAiAudits = enableAiAudits,
                                        smartStudyEnabled = smartStudyEnabled,
                                        smartStudyMode = smartStudyMode
                                    )
                                    val builtTasks = StudyPlanGenerator.buildTasksFromPreview(cfg, previewDays!!)
                                    onConfirmPlan(builtTasks)
                                    onDismiss()
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                                modifier = Modifier
                                    .weight(1f)
                                    .testTag("confirm_create_study_plan_button")
                            ) {
                                Text("Confirm & Create", fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }
    }
}
