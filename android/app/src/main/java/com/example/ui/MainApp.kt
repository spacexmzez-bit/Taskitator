package com.example.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.SavedCriteria
import com.example.data.model.Task
import com.example.data.model.TaskStatus
import com.example.ui.components.*
import com.example.ui.screens.*
import com.example.ui.theme.*
import com.example.ui.viewmodel.AppScreen
import com.example.ui.viewmodel.TaskitatorViewModel
import kotlinx.coroutines.launch

@Composable
fun MainApp(
    viewModel: TaskitatorViewModel
) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    val currentScreen by viewModel.currentScreen.collectAsState()
    val settings by viewModel.settings.collectAsState()
    val tasks by viewModel.tasks.collectAsState()
    val notes by viewModel.notes.collectAsState()
    val savedCriteriaList by viewModel.savedCriteria.collectAsState()
    val breakPlanningState by viewModel.breakPlanning.collectAsState()

    val isSelectMode by viewModel.isSelectMode.collectAsState()
    val selectedTaskIds by viewModel.selectedTaskIds.collectAsState()

    // Modals visibility
    val showCreateEditDialog by viewModel.showCreateEditDialog.collectAsState()
    val editingTask by viewModel.editingTask.collectAsState()
    val parentTaskId by viewModel.parentTaskIdForNewSubtask.collectAsState()
    val showDistractionDump by viewModel.showDistractionDumpDialog.collectAsState()
    val showEmergency by viewModel.showEmergencyDialog.collectAsState()

    val showBreakPlanning by viewModel.showBreakPlanningDialog.collectAsState()
    val showEvidenceAudit by viewModel.showEvidenceAuditDialog.collectAsState()
    val auditingTask by viewModel.auditingTask.collectAsState()

    val showBatchTags by viewModel.showBatchTagsModal.collectAsState()
    val showBatchPriority by viewModel.showBatchPriorityModal.collectAsState()
    val showBatchReschedule by viewModel.showBatchRescheduleModal.collectAsState()
    val showFilter by viewModel.showFilterModal.collectAsState()
    val priorityFilter by viewModel.priorityFilter.collectAsState()
    val tagFilter by viewModel.tagFilter.collectAsState()

    val hasPendingAiLockedTasksToday by viewModel.hasPendingAiLockedTasksToday.collectAsState()
    val allTags = remember(tasks) { tasks.flatMap { it.tags }.distinct() }
    val completedCount = remember(tasks) { tasks.count { it.status == TaskStatus.COMPLETED } }

    BackHandler(enabled = currentScreen != AppScreen.TODAY) {
        viewModel.navigateTo(AppScreen.TODAY)
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                drawerContainerColor = DarkSurface,
                modifier = Modifier.width(280.dp)
            ) {
                // Header
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(24.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Surface(shape = CircleShape, color = ElectricBlue, modifier = Modifier.size(36.dp)) {
                            Box(contentAlignment = Alignment.Center) { Text("🎯", fontSize = 18.sp) }
                        }
                        Text("Taskitator", style = MaterialTheme.typography.titleLarge, color = TextPrimary, fontWeight = FontWeight.ExtraBold)
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Text("Focus & Task Engine · Personal", style = MaterialTheme.typography.bodyMedium, color = TextSecondary, fontSize = 12.sp)
                }

                HorizontalDivider(color = DarkBorder, thickness = 0.5.dp)
                Spacer(modifier = Modifier.height(8.dp))

                // Navigation: exactly 3 destinations (Today, General, Settings per Plan v5 Section 3)
                AppScreen.values().forEach { screen ->
                    val isSelected = currentScreen == screen
                    NavigationDrawerItem(
                        icon = { Text(screen.icon, fontSize = 18.sp) },
                        label = {
                            Text(
                                text = screen.title,
                                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                                color = if (isSelected) TextPrimary else TextSecondary
                            )
                        },
                        selected = isSelected,
                        onClick = {
                            viewModel.navigateTo(screen)
                            scope.launch { drawerState.close() }
                        },
                        colors = NavigationDrawerItemDefaults.colors(
                            selectedContainerColor = ElectricBlue.copy(alpha = 0.2f),
                            unselectedContainerColor = androidx.compose.ui.graphics.Color.Transparent
                        ),
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp)
                    )
                }
            }
        }
    ) {
        Scaffold(
            topBar = {
                TaskitatorTopBar(
                    settings = settings,
                    completedTasksCount = completedCount,
                    hasDistractionNotes = notes.isNotEmpty(),
                    breakPlanning = breakPlanningState,
                    onOpenDrawer = { scope.launch { drawerState.open() } },
                    onOpenBreaksModal = { viewModel.setBreakPlanningDialogVisible(true) },
                    onOpenDistractionDump = { viewModel.setDistractionDumpDialogVisible(true) },
                    onOpenEmergencyBypass = { viewModel.setEmergencyDialogVisible(true) }
                )
            },
            floatingActionButton = {
                if (currentScreen in listOf(AppScreen.TODAY, AppScreen.GENERAL) && !isSelectMode) {
                    ExtendedFloatingActionButton(
                        onClick = { viewModel.openCreateTaskDialog() },
                        containerColor = ElectricBlue,
                        contentColor = TextPrimary,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.testTag("fab_add_task")
                    ) {
                        Icon(Icons.Default.Add, contentDescription = null)
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("New task", fontWeight = FontWeight.Bold)
                    }
                }
            },
            bottomBar = {
                AnimatedVisibility(
                    visible = isSelectMode && selectedTaskIds.isNotEmpty(),
                    enter = slideInVertically(initialOffsetY = { it }) + fadeIn(),
                    exit = slideOutVertically(targetOffsetY = { it }) + fadeOut()
                ) {
                    BatchActionBar(
                        selectedCount = selectedTaskIds.size,
                        onSelectAll = {
                            val visibleIds = tasks.filter { it.status == TaskStatus.ACTIVE }.map { it.id }
                            viewModel.selectAllVisible(visibleIds)
                        },
                        onOpenTags = { viewModel.setBatchTagsModalVisible(true) },
                        onOpenPriority = { viewModel.setBatchPriorityModalVisible(true) },
                        onOpenReschedule = { viewModel.setBatchRescheduleModalVisible(true) },
                        onBatchComplete = {
                            selectedTaskIds.forEach { viewModel.repository.toggleTaskCompletion(it) }
                            viewModel.clearSelection()
                        },
                        onBatchTrash = {
                            selectedTaskIds.forEach { viewModel.repository.trashBranch(it) }
                            viewModel.clearSelection()
                        },
                        onCancel = { viewModel.clearSelection() }
                    )
                }
            },
            containerColor = DarkBackground,
            contentWindowInsets = WindowInsets.safeDrawing
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
            ) {
                when (currentScreen) {
                    AppScreen.TODAY -> TodayScreen(
                        viewModel = viewModel,
                        onOpenCreateTask = { viewModel.openCreateTaskDialog() }
                    )
                    AppScreen.GENERAL -> GeneralScreen(viewModel = viewModel)
                    AppScreen.SETTINGS -> SettingsScreen(viewModel = viewModel)
                }
            }
        }
    }

    // --- Interactive Dialogs & Workflows ---

    if (showCreateEditDialog) {
        CreateEditTaskDialog(
            taskToEdit = editingTask,
            initialParentId = parentTaskId,
            allExistingTasks = tasks.filter { it.status != TaskStatus.TRASH },
            isPro = settings.isPro,
            customPriorities = settings.customPriorities,
            customTags = settings.customTags,
            savedCriteriaList = savedCriteriaList,
            strictCriteriaValidation = settings.strictCriteriaValidation,
            authToken = settings.authToken,
            onDismiss = { viewModel.closeCreateEditDialog() },
            onSaveCustomCriteria = { text, score ->
                viewModel.repository.saveCriteriaPreset(SavedCriteria(criteria = text, score = score)).first
            },
            onSaveTask = { task, quickSubtasks, selectedParentId ->
                val (ok, err) = viewModel.repository.upsertTask(task)
                if (ok) {
                    quickSubtasks.forEach { subTitle ->
                        viewModel.repository.upsertTask(
                            Task(
                                title = subTitle,
                                rawTitle = subTitle,
                                parentId = task.id,
                                priorityId = task.priorityId,
                                tags = task.tags
                            )
                        )
                    }
                } else if (err != null) {
                    viewModel.setStatusMessage(err)
                }
                viewModel.closeCreateEditDialog()
            }
        )
    }

    if (showEvidenceAudit && auditingTask != null) {
        EvidenceAuditDialog(
            task = auditingTask!!,
            isPro = settings.isPro,
            useByok = settings.useByok,
            authToken = settings.authToken,
            onDismiss = { viewModel.closeEvidenceAuditDialog() },
            onAuditApproved = { taskId, feedback ->
                viewModel.repository.confirmAuditApproval(taskId, feedback)
                viewModel.closeEvidenceAuditDialog()
            }
        )
    }

    if (showBreakPlanning) {
        BreakPlanningDialog(
            state = breakPlanningState,
            onStartPlanningWindow = { viewModel.repository.startPlanningWindow() },
            onLockSchedule = { intervals -> viewModel.repository.lockSchedule(intervals) },
            onDismiss = { viewModel.setBreakPlanningDialogVisible(false) }
        )
    }

    if (showDistractionDump) {
        DistractionDumpDialog(
            timerDurationSeconds = settings.dumpDurationSeconds,
            hasPendingAiLockedTasksToday = hasPendingAiLockedTasksToday,
            notes = notes,
            onDismiss = { viewModel.setDistractionDumpDialogVisible(false) },
            onSaveNote = { text, title -> viewModel.repository.saveDistractionNote(text, title) },
            onDeleteNote = { viewModel.repository.deleteDistractionNote(it) },
            onClearAll = { }
        )
    }

    if (showEmergency) {
        EmergencyBypassDialog(
            settings = settings,
            onActivateBypass = { viewModel.repository.activateEmergencyBypassLocally() },
            onDeactivateBypass = { },
            onDismiss = { viewModel.setEmergencyDialogVisible(false) }
        )
    }

    if (showBatchTags) {
        BatchTagsDialog(
            onDismiss = { viewModel.setBatchTagsModalVisible(false) },
            onApply = { tags ->
                selectedTaskIds.forEach { id ->
                    val t = tasks.find { it.id == id }
                    if (t != null) viewModel.repository.upsertTask(t.copy(tags = tags))
                }
                viewModel.setBatchTagsModalVisible(false)
            }
        )
    }

    if (showBatchPriority) {
        BatchPriorityDialog(
            customPriorities = settings.customPriorities,
            onDismiss = { viewModel.setBatchPriorityModalVisible(false) },
            onSelectPriority = { priorityId ->
                selectedTaskIds.forEach { id ->
                    val t = tasks.find { it.id == id }
                    if (t != null) viewModel.repository.upsertTask(t.copy(priorityId = priorityId))
                }
                viewModel.setBatchPriorityModalVisible(false)
            }
        )
    }

    if (showBatchReschedule) {
        BatchRescheduleDialog(
            onDismiss = { viewModel.setBatchRescheduleModalVisible(false) },
            onConfirm = { date ->
                selectedTaskIds.forEach { id ->
                    val t = tasks.find { it.id == id }
                    if (t != null) viewModel.repository.upsertTask(t.copy(dueDate = date))
                }
                viewModel.setBatchRescheduleModalVisible(false)
            }
        )
    }

    if (showFilter) {
        FilterDialog(
            selectedPriority = priorityFilter,
            selectedTag = tagFilter,
            allTags = allTags,
            customPriorities = settings.customPriorities,
            onSelectPriority = { viewModel.setPriorityFilter(it) },
            onSelectTag = { viewModel.setTagFilter(it) },
            onClearFilters = { viewModel.clearFilters() },
            onDismiss = { viewModel.setFilterModalVisible(false) }
        )
    }
}
