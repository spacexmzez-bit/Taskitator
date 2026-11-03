package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.model.*
import com.example.data.util.VariableResolver
import com.example.ui.theme.*

@Composable
fun CreateEditTaskDialog(
    taskToEdit: Task? = null,
    initialParentId: String? = null,
    allExistingTasks: List<Task> = emptyList(),
    isPro: Boolean = true,
    customPriorities: List<CustomPriority> = DEFAULT_PRIORITIES,
    customTags: List<String> = DEFAULT_TAGS,
    savedCriteriaList: List<SavedCriteria> = emptyList(),
    strictCriteriaValidation: Boolean = true,
    authToken: String = "",
    onDismiss: () -> Unit,
    onSaveCustomCriteria: (String, Int) -> Boolean,
    onSaveTask: (Task, List<String>, String?) -> Unit
) {
    var title by remember { mutableStateOf(taskToEdit?.title ?: "") }
    var description by remember { mutableStateOf(taskToEdit?.description ?: "") }
    var dueDate by remember { mutableStateOf(taskToEdit?.dueDate ?: "") }
    var priorityId by remember { mutableStateOf(taskToEdit?.priorityId ?: "prio_med") }
    var tagsInput by remember { mutableStateOf(taskToEdit?.tags?.joinToString(", ") ?: "") }
    var recurrence by remember { mutableStateOf(taskToEdit?.recurrence ?: RecurrenceRule.NONE) }
    var aiLocked by remember { mutableStateOf(taskToEdit?.aiLocked ?: false) }
    var proofCriteria by remember { mutableStateOf(taskToEdit?.proofCriteria ?: "") }
    var criteriaScore by remember { mutableStateOf(taskToEdit?.criteriaValidationScore) }
    var criteriaCritique by remember { mutableStateOf(taskToEdit?.criteriaValidationCritique) }
    var requireAllSubtasksFirst by remember { mutableStateOf(taskToEdit?.requireAllSubtasksFirst ?: false) }
    var isBonus by remember { mutableStateOf(taskToEdit?.isBonus ?: false) }

    var selectedParentId by remember { mutableStateOf(taskToEdit?.parentId ?: initialParentId) }

    val quickSubtasks = remember { mutableStateListOf<String>() }
    var newSubtaskInput by remember { mutableStateOf("") }
    var consecutiveMode by remember { mutableStateOf(false) }

    var showCriteriaValidationModal by remember { mutableStateOf(false) }
    var showIrreversibleConfirmDialog by remember { mutableStateOf(false) }
    var validationWarningMessage by remember { mutableStateOf<String?>(null) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.92f)
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
                    Text(
                        text = if (taskToEdit != null) "Edit Task" else if (selectedParentId != null) "Add Subtask" else "Create Task",
                        style = MaterialTheme.typography.titleLarge,
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                    }
                }

                Spacer(modifier = Modifier.height(10.dp))

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                ) {
                    // Title Input
                    OutlinedTextField(
                        value = title,
                        onValueChange = { title = it },
                        label = { Text("Task Title") },
                        placeholder = { Text("e.g. Chapter {num==1} or Read Physics $$") },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ElectricBlue,
                            unfocusedBorderColor = DarkBorder,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("task_title_input")
                    )

                    // Variable preview if title contains {key==value}
                    val titleRes = remember(title) { VariableResolver.resolveTitleVariables(title) }
                    if (titleRes.variables.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(6.dp))
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = CyanAccent.copy(alpha = 0.1f),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                text = "Preview: \"${titleRes.resolvedTitle}\" · Variables: ${titleRes.variables}",
                                style = MaterialTheme.typography.labelSmall,
                                color = CyanAccent,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // Description Input
                    OutlinedTextField(
                        value = description,
                        onValueChange = { description = it },
                        label = { Text("Description (Optional)") },
                        maxLines = 3,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ElectricBlue,
                            unfocusedBorderColor = DarkBorder,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    // Due Date
                    OutlinedTextField(
                        value = dueDate,
                        onValueChange = { dueDate = it },
                        label = { Text("Due Date (YYYY-MM-DD, 'today', or empty)") },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ElectricBlue,
                            unfocusedBorderColor = DarkBorder,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(14.dp))

                    // Priority Chips (from customPriorities per 8.4)
                    Text("Priority:", style = MaterialTheme.typography.labelMedium, color = TextSecondary)
                    Spacer(modifier = Modifier.height(6.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        customPriorities.forEach { p ->
                            val isSel = priorityId == p.id
                            val col = when (p.id) {
                                "prio_high" -> PriorityP1
                                "prio_med" -> PriorityP2
                                "prio_low" -> PriorityP3
                                else -> PriorityP4
                            }
                            Surface(
                                shape = RoundedCornerShape(8.dp),
                                color = if (isSel) col.copy(alpha = 0.25f) else DarkSurfaceVariant,
                                border = androidx.compose.foundation.BorderStroke(1.dp, if (isSel) col else DarkBorder),
                                modifier = Modifier
                                    .weight(1f)
                                    .clickable { priorityId = p.id }
                            ) {
                                Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 8.dp)) {
                                    Text(
                                        text = p.label,
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (isSel) col else TextSecondary,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    // Tags Input
                    OutlinedTextField(
                        value = tagsInput,
                        onValueChange = { tagsInput = it },
                        label = { Text("Tags (comma-separated, e.g. study, work)") },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ElectricBlue,
                            unfocusedBorderColor = DarkBorder,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(14.dp))

                    // Protection Rules Section
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = DarkSurfaceVariant.copy(alpha = 0.5f),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text("Task Protection & Shields", style = MaterialTheme.typography.titleSmall, color = TextPrimary, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(8.dp))

                            // Shield toggle
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { requireAllSubtasksFirst = !requireAllSubtasksFirst },
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Checkbox(
                                    checked = requireAllSubtasksFirst,
                                    onCheckedChange = { requireAllSubtasksFirst = it },
                                    colors = CheckboxDefaults.colors(checkedColor = CyanAccent)
                                )
                                Column {
                                    Text("🛡️ Shield (Require all subtasks first)", color = TextPrimary, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text("Cannot complete until all non-bonus subtasks are done.", color = TextMuted, fontSize = 11.sp)
                                }
                            }

                            // Bonus toggle
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { isBonus = !isBonus },
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Checkbox(
                                    checked = isBonus,
                                    onCheckedChange = { isBonus = it },
                                    colors = CheckboxDefaults.colors(checkedColor = WarningAmber)
                                )
                                Column {
                                    Text("⭐ Bonus Work ($$)", color = TextPrimary, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text("Optional task that never blocks parent shields.", color = TextMuted, fontSize = 11.sp)
                                }
                            }

                            // AI Lock toggle
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { aiLocked = !aiLocked },
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Checkbox(
                                    checked = aiLocked,
                                    onCheckedChange = { aiLocked = it },
                                    colors = CheckboxDefaults.colors(checkedColor = ElectricBlue)
                                )
                                Column {
                                    Text("🔒 AI-Locked Task", color = TextPrimary, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text("Requires proof submission and AI audit to complete.", color = TextMuted, fontSize = 11.sp)
                                }
                            }
                        }
                    }

                    // AI Criteria Editor Section
                    if (aiLocked) {
                        Spacer(modifier = Modifier.height(14.dp))
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = ElectricBlue.copy(alpha = 0.08f),
                            border = androidx.compose.foundation.BorderStroke(1.dp, ElectricBlue.copy(alpha = 0.3f)),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Text("Proof Acceptance Criteria", color = ElectricBlue, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
                                Spacer(modifier = Modifier.height(6.dp))

                                OutlinedTextField(
                                    value = proofCriteria,
                                    onValueChange = { proofCriteria = it },
                                    placeholder = { Text("e.g. Photo of at least 1 page of handwritten summary notes with today's date in ink.") },
                                    minLines = 2,
                                    colors = OutlinedTextFieldDefaults.colors(
                                        focusedBorderColor = ElectricBlue,
                                        unfocusedBorderColor = DarkBorder,
                                        focusedTextColor = TextPrimary,
                                        unfocusedTextColor = TextPrimary
                                    ),
                                    modifier = Modifier.fillMaxWidth()
                                )

                                Spacer(modifier = Modifier.height(8.dp))

                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = if (criteriaScore != null) "Verified Score: $criteriaScore/10" else "Unverified Criteria",
                                        color = if (criteriaScore != null && criteriaScore!! >= 7) SuccessGreen else TextMuted,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 11.sp
                                    )
                                    Button(
                                        onClick = { showCriteriaValidationModal = true },
                                        colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)
                                    ) {
                                        Text("Validate with AI", fontSize = 11.sp)
                                    }
                                }
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    // Quick Subtasks Section
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = DarkSurfaceVariant.copy(alpha = 0.5f),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text("Quick Subtasks", style = MaterialTheme.typography.titleSmall, color = TextPrimary, fontWeight = FontWeight.Bold)
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Checkbox(
                                        checked = consecutiveMode,
                                        onCheckedChange = { consecutiveMode = it },
                                        colors = CheckboxDefaults.colors(checkedColor = CyanAccent)
                                    )
                                    Text("Consecutive {num}", fontSize = 11.sp, color = CyanAccent)
                                }
                            }

                            Spacer(modifier = Modifier.height(8.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                OutlinedTextField(
                                    value = newSubtaskInput,
                                    onValueChange = { newSubtaskInput = it },
                                    placeholder = { Text("Subtask title (e.g. Problem {num==1})") },
                                    singleLine = true,
                                    colors = OutlinedTextFieldDefaults.colors(
                                        focusedBorderColor = CyanAccent,
                                        unfocusedBorderColor = DarkBorder,
                                        focusedTextColor = TextPrimary,
                                        unfocusedTextColor = TextPrimary
                                    ),
                                    modifier = Modifier.weight(1f)
                                )
                                Spacer(modifier = Modifier.width(6.dp))
                                IconButton(
                                    onClick = {
                                        if (newSubtaskInput.isNotBlank()) {
                                            quickSubtasks.add(newSubtaskInput.trim())
                                            if (consecutiveMode) {
                                                newSubtaskInput = VariableResolver.incrementConsecutivePattern(newSubtaskInput)
                                            } else {
                                                newSubtaskInput = ""
                                            }
                                        }
                                    }
                                ) {
                                    Icon(Icons.Default.Add, contentDescription = "Add subtask", tint = CyanAccent)
                                }
                            }

                            if (quickSubtasks.isNotEmpty()) {
                                Spacer(modifier = Modifier.height(8.dp))
                                quickSubtasks.forEachIndexed { idx, st ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(vertical = 2.dp),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Text("• $st", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                                        IconButton(onClick = { quickSubtasks.removeAt(idx) }, modifier = Modifier.size(20.dp)) {
                                            Icon(Icons.Default.Close, contentDescription = "Remove", tint = TextMuted, modifier = Modifier.size(14.dp))
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (validationWarningMessage != null) {
                        Spacer(modifier = Modifier.height(10.dp))
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = PriorityP1.copy(alpha = 0.15f),
                            border = androidx.compose.foundation.BorderStroke(1.dp, PriorityP1.copy(alpha = 0.4f)),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                text = validationWarningMessage!!,
                                color = PriorityP1,
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.padding(10.dp)
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                // Footer Save Action
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
                            if (title.isNotBlank()) {
                                // Strict Criteria Validation check
                                if (strictCriteriaValidation && aiLocked && (criteriaScore == null || criteriaScore!! < 7)) {
                                    validationWarningMessage = "Strict criteria validation is ON: AI-locked tasks must achieve a score >= 7/10 before saving."
                                    return@Button
                                }

                                val isNewlyShieldedOrLocked = (aiLocked && taskToEdit?.aiLocked != true) ||
                                        (requireAllSubtasksFirst && taskToEdit?.requireAllSubtasksFirst != true)

                                if (isNewlyShieldedOrLocked) {
                                    showIrreversibleConfirmDialog = true
                                } else {
                                    executeSave(
                                        title, description, dueDate, priorityId, tagsInput, recurrence,
                                        aiLocked, proofCriteria, criteriaScore, criteriaCritique,
                                        requireAllSubtasksFirst, isBonus, selectedParentId,
                                        taskToEdit, quickSubtasks.toList(), onSaveTask
                                    )
                                }
                            }
                        },
                        enabled = title.isNotBlank(),
                        colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                        modifier = Modifier.testTag("save_task_button")
                    ) {
                        Text("Save Task", fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }

    if (showIrreversibleConfirmDialog) {
        AlertDialog(
            onDismissRequest = { showIrreversibleConfirmDialog = false },
            title = { Text("Irreversible Protection Warning", fontWeight = FontWeight.Bold) },
            text = {
                Text("Enabling AI Lock or Shield on a task enforces strict accountability. An AI-locked task cannot be completed without an audited proof of work, and shields cannot complete until all subtasks are finished. Do you wish to proceed?")
            },
            confirmButton = {
                Button(
                    onClick = {
                        showIrreversibleConfirmDialog = false
                        executeSave(
                            title, description, dueDate, priorityId, tagsInput, recurrence,
                            aiLocked, proofCriteria, criteriaScore, criteriaCritique,
                            requireAllSubtasksFirst, isBonus, selectedParentId,
                            taskToEdit, quickSubtasks.toList(), onSaveTask
                        )
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = PriorityP1)
                ) {
                    Text("Confirm & Save", fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { showIrreversibleConfirmDialog = false }) {
                    Text("Go Back")
                }
            }
        )
    }

    if (showCriteriaValidationModal) {
        CriteriaValidationDialog(
            initialCriteria = proofCriteria,
            taskTitle = title,
            savedCriteriaList = savedCriteriaList,
            authToken = authToken,
            strictCriteriaValidation = strictCriteriaValidation,
            onDismiss = { showCriteriaValidationModal = false },
            onSaveToCustom = onSaveCustomCriteria,
            onCriteriaConfirmed = { crit, result ->
                proofCriteria = crit
                criteriaScore = result.score
                criteriaCritique = result.critique
                validationWarningMessage = null
                showCriteriaValidationModal = false
            }
        )
    }
}

private fun executeSave(
    title: String,
    description: String,
    dueDate: String,
    priorityId: String,
    tagsInput: String,
    recurrence: RecurrenceRule,
    aiLocked: Boolean,
    proofCriteria: String,
    criteriaScore: Int?,
    criteriaCritique: String?,
    requireAllSubtasksFirst: Boolean,
    isBonus: Boolean,
    selectedParentId: String?,
    taskToEdit: Task?,
    quickSubtasks: List<String>,
    onSaveTask: (Task, List<String>, String?) -> Unit
) {
    val parsedTags = tagsInput.split(",").map { it.trim().removePrefix("#") }.filter { it.isNotEmpty() }
    val varRes = VariableResolver.resolveTitleVariables(title.trim())
    val (resCriteria, _) = VariableResolver.resolveCriteria(proofCriteria, varRes.variables)

    val task = if (taskToEdit != null) {
        taskToEdit.copy(
            title = title.trim(),
            rawTitle = title.trim(),
            description = description.trim(),
            dueDate = dueDate.trim(),
            priorityId = priorityId,
            tags = parsedTags,
            recurrence = recurrence,
            aiLocked = aiLocked,
            proofCriteria = proofCriteria.trim(),
            rawProofCriteria = proofCriteria.trim(),
            criteriaValidationScore = criteriaScore,
            criteriaValidationCritique = criteriaCritique,
            requireAllSubtasksFirst = requireAllSubtasksFirst,
            isBonus = isBonus,
            parentId = selectedParentId
        )
    } else {
        Task(
            title = title.trim(),
            rawTitle = title.trim(),
            description = description.trim(),
            dueDate = dueDate.trim(),
            priorityId = priorityId,
            tags = parsedTags,
            recurrence = recurrence,
            aiLocked = aiLocked,
            proofCriteria = proofCriteria.trim(),
            rawProofCriteria = proofCriteria.trim(),
            criteriaValidationScore = criteriaScore,
            criteriaValidationCritique = criteriaCritique,
            requireAllSubtasksFirst = requireAllSubtasksFirst,
            isBonus = isBonus,
            parentId = selectedParentId
        )
    }
    onSaveTask(task, quickSubtasks, selectedParentId)
}
