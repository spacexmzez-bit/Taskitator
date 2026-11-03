package com.example.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.CustomPriority
import com.example.data.network.TaskitatorWorkerApi
import com.example.ui.theme.*
import com.example.ui.viewmodel.TaskitatorViewModel
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    viewModel: TaskitatorViewModel,
    modifier: Modifier = Modifier
) {
    val settings by viewModel.settings.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var selectedTab by remember { mutableIntStateOf(0) }
    val tabTitles = listOf("General", "Tasks", "Day & Week", "AI & Pro", "Phone Lock", "Account")

    // General state
    var copilotNameInput by remember(settings.copilotName) { mutableStateOf(settings.copilotName) }
    var soundEffects by remember(settings.soundEffectsEnabled) { mutableStateOf(settings.soundEffectsEnabled) }
    var haptics by remember(settings.hapticsEnabled) { mutableStateOf(settings.hapticsEnabled) }
    var dumpDuration by remember(settings.dumpDurationSeconds) { mutableFloatStateOf(settings.dumpDurationSeconds.toFloat()) }
    var syncStatusMessage by remember { mutableStateOf<String?>(null) }
    var isSyncing by remember { mutableStateOf(false) }

    // Tasks state
    var strictValidation by remember(settings.strictCriteriaValidation) { mutableStateOf(settings.strictCriteriaValidation) }
    var newTagInput by remember { mutableStateOf("") }

    // Day & week state
    var dayStartHour by remember(settings.dayStartHour) { mutableFloatStateOf(settings.dayStartHour.toFloat()) }
    var weekendStart by remember(settings.weekendStart) { mutableIntStateOf(settings.weekendStart) }
    var weekendEnd by remember(settings.weekendEnd) { mutableIntStateOf(settings.weekendEnd) }

    // AI & Pro state
    var keyoActivationKey by remember { mutableStateOf("") }
    var isActivatingKeyo by remember { mutableStateOf(false) }
    var keyoResultMsg by remember { mutableStateOf<String?>(null) }
    var isTestingAi by remember { mutableStateOf(false) }
    var testResultMsg by remember { mutableStateOf<String?>(null) }
    var useByokState by remember(settings.useByok) { mutableStateOf(settings.useByok) }
    var activeModel by remember(settings.activeAiModel) { mutableStateOf(settings.activeAiModel) }

    // Phone lock state
    var phoneTokensList by remember { mutableStateOf(settings.phoneTokens) }
    var newlyCreatedToken by remember { mutableStateOf<String?>(null) }
    var isGeneratingToken by remember { mutableStateOf(false) }
    var phoneErrorMessage by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp)
    ) {
        Spacer(modifier = Modifier.height(12.dp))

        Text(
            text = "Settings",
            style = MaterialTheme.typography.headlineMedium,
            color = TextPrimary,
            fontWeight = FontWeight.ExtraBold
        )

        Spacer(modifier = Modifier.height(10.dp))

        // 6 Tabs per Plan v5 Section 9.4
        ScrollableTabRow(
            selectedTabIndex = selectedTab,
            containerColor = DarkSurfaceVariant,
            contentColor = ElectricBlue,
            edgePadding = 0.dp
        ) {
            tabTitles.forEachIndexed { index, title ->
                Tab(
                    selected = selectedTab == index,
                    onClick = { selectedTab = index },
                    text = { Text(title, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
                )
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
        ) {
            when (selectedTab) {
                0 -> {
                    // TAB 0: General
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Focus & Experience", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(12.dp))

                            OutlinedTextField(
                                value = copilotNameInput,
                                onValueChange = {
                                    if (it.length <= 20) {
                                        copilotNameInput = it
                                        viewModel.repository.updateSettings(settings.copy(copilotName = it))
                                    }
                                },
                                label = { Text("Assistant Name (max 20 chars)") },
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

                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        soundEffects = !soundEffects
                                        viewModel.repository.updateSettings(settings.copy(soundEffectsEnabled = soundEffects))
                                    },
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text("Sound Effects", color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
                                Switch(
                                    checked = soundEffects,
                                    onCheckedChange = {
                                        soundEffects = it
                                        viewModel.repository.updateSettings(settings.copy(soundEffectsEnabled = it))
                                    }
                                )
                            }

                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        haptics = !haptics
                                        viewModel.repository.updateSettings(settings.copy(hapticsEnabled = haptics))
                                    },
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text("Haptic Feedback", color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
                                Switch(
                                    checked = haptics,
                                    onCheckedChange = {
                                        haptics = it
                                        viewModel.repository.updateSettings(settings.copy(hapticsEnabled = it))
                                    }
                                )
                            }

                            Spacer(modifier = Modifier.height(14.dp))

                            Text(
                                text = "Distraction Dump Timer: ${dumpDuration.toInt()} seconds",
                                style = MaterialTheme.typography.labelMedium,
                                color = TextPrimary,
                                fontWeight = FontWeight.SemiBold
                            )
                            Slider(
                                value = dumpDuration,
                                onValueChange = {
                                    val stepped = (Math.round(it / 15f) * 15).coerceIn(30, 300)
                                    dumpDuration = stepped.toFloat()
                                    viewModel.repository.updateSettings(settings.copy(dumpDurationSeconds = stepped))
                                },
                                valueRange = 30f..300f,
                                steps = 17,
                                colors = SliderDefaults.colors(thumbColor = CyanAccent, activeTrackColor = CyanAccent)
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    // Cloudflare Worker Sync Card
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Cloudflare Worker Synchronization", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(4.dp))
                            Text("Worker Gateway: ${TaskitatorWorkerApi.WORKER_BASE_URL}", fontSize = 11.sp, color = TextMuted)
                            Spacer(modifier = Modifier.height(10.dp))

                            Button(
                                onClick = {
                                    isSyncing = true
                                    syncStatusMessage = null
                                    scope.launch {
                                        val (ok, msg) = viewModel.repository.performSync()
                                        isSyncing = false
                                        syncStatusMessage = msg
                                    }
                                },
                                enabled = !isSyncing,
                                colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text(if (isSyncing) "Syncing with Worker..." else "Sync Now", fontWeight = FontWeight.Bold)
                            }

                            if (syncStatusMessage != null) {
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(syncStatusMessage!!, fontSize = 11.sp, color = CyanAccent)
                            }
                        }
                    }
                }

                1 -> {
                    // TAB 1: Tasks
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Criteria & Protection Rules", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(8.dp))

                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        strictValidation = !strictValidation
                                        viewModel.repository.updateSettings(settings.copy(strictCriteriaValidation = strictValidation))
                                    },
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text("Strict Criteria Validation", color = TextPrimary, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text("Ordinary AI-locked tasks must achieve score >= 7/10 before saving.", color = TextMuted, fontSize = 11.sp)
                                }
                                Switch(
                                    checked = strictValidation,
                                    onCheckedChange = {
                                        strictValidation = it
                                        viewModel.repository.updateSettings(settings.copy(strictCriteriaValidation = it))
                                    }
                                )
                            }

                            Spacer(modifier = Modifier.height(16.dp))

                            Text("Custom Tags", style = MaterialTheme.typography.titleSmall, color = TextPrimary, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(6.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                OutlinedTextField(
                                    value = newTagInput,
                                    onValueChange = { newTagInput = it },
                                    placeholder = { Text("Add tag...") },
                                    singleLine = true,
                                    colors = OutlinedTextFieldDefaults.colors(
                                        focusedBorderColor = CyanAccent,
                                        unfocusedBorderColor = DarkBorder,
                                        focusedTextColor = TextPrimary,
                                        unfocusedTextColor = TextPrimary
                                    ),
                                    modifier = Modifier.weight(1f)
                                )
                                Button(
                                    onClick = {
                                        if (newTagInput.isNotBlank()) {
                                            val current = settings.customTags.toMutableList()
                                            val t = newTagInput.trim().lowercase()
                                            if (t !in current) current.add(t)
                                            viewModel.repository.updateSettings(settings.copy(customTags = current))
                                            newTagInput = ""
                                        }
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = CyanAccent)
                                ) {
                                    Text("Add", color = DarkBackground, fontWeight = FontWeight.Bold)
                                }
                            }

                            Spacer(modifier = Modifier.height(8.dp))
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                settings.customTags.forEach { tag ->
                                    Surface(
                                        shape = RoundedCornerShape(12.dp),
                                        color = DarkSurfaceVariant,
                                        border = androidx.compose.foundation.BorderStroke(0.5.dp, DarkBorder)
                                    ) {
                                        Row(
                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(4.dp)
                                        ) {
                                            Text("#$tag", color = TextPrimary, fontSize = 11.sp)
                                            Text(
                                                "✕",
                                                color = TextMuted,
                                                fontSize = 10.sp,
                                                modifier = Modifier.clickable {
                                                    val current = settings.customTags.toMutableList()
                                                    current.remove(tag)
                                                    viewModel.repository.updateSettings(settings.copy(customTags = current))
                                                }
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                2 -> {
                    // TAB 2: Day & week
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Schedule & Calendar Cycle", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(12.dp))

                            Text(
                                text = "Logical Day Start: ${dayStartHour.toInt()}:00 AM",
                                style = MaterialTheme.typography.labelMedium,
                                color = TextPrimary,
                                fontWeight = FontWeight.SemiBold
                            )
                            Text("Tasks due 'today' remain active until this hour tomorrow morning (0..4 AM).", color = TextMuted, fontSize = 11.sp)
                            Slider(
                                value = dayStartHour,
                                onValueChange = {
                                    val h = it.toInt().coerceIn(0, 4)
                                    dayStartHour = h.toFloat()
                                    viewModel.repository.updateSettings(settings.copy(dayStartHour = h))
                                },
                                valueRange = 0f..4f,
                                steps = 3,
                                colors = SliderDefaults.colors(thumbColor = ElectricBlue, activeTrackColor = ElectricBlue)
                            )

                            Spacer(modifier = Modifier.height(14.dp))

                            Text("Break & Schedule Timezone", style = MaterialTheme.typography.labelMedium, color = TextPrimary, fontWeight = FontWeight.SemiBold)
                            Text("App Timezone: ${settings.breakTimezone} (Server sync uses Riyadh UTC+3)", color = TextMuted, fontSize = 11.sp)
                        }
                    }
                }

                3 -> {
                    // TAB 3: AI & Pro
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text("Pro Entitlement & AI", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                                Surface(
                                    shape = RoundedCornerShape(8.dp),
                                    color = if (settings.isPro) SuccessGreen.copy(alpha = 0.2f) else DarkSurfaceVariant,
                                    border = androidx.compose.foundation.BorderStroke(1.dp, if (settings.isPro) SuccessGreen else DarkBorder)
                                ) {
                                    Text(
                                        text = if (settings.isPro) "KEYO PRO ACTIVE" else "FREE ACCOUNT",
                                        color = if (settings.isPro) SuccessGreen else TextSecondary,
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(12.dp))

                            // Keyo Activation Input
                            if (!settings.isPro) {
                                Text("Activate Keyo License Key:", style = MaterialTheme.typography.labelSmall, color = TextSecondary)
                                Spacer(modifier = Modifier.height(4.dp))
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    OutlinedTextField(
                                        value = keyoActivationKey,
                                        onValueChange = { keyoActivationKey = it },
                                        placeholder = { Text("16-character license key") },
                                        singleLine = true,
                                        colors = OutlinedTextFieldDefaults.colors(
                                            focusedBorderColor = CyanAccent,
                                            unfocusedBorderColor = DarkBorder,
                                            focusedTextColor = TextPrimary,
                                            unfocusedTextColor = TextPrimary
                                        ),
                                        modifier = Modifier.weight(1f)
                                    )
                                    Button(
                                        onClick = {
                                            isActivatingKeyo = true
                                            keyoResultMsg = null
                                            scope.launch {
                                                val res = TaskitatorWorkerApi.activateProKey(keyoActivationKey, settings.authToken)
                                                isActivatingKeyo = false
                                                res.fold(
                                                    onSuccess = {
                                                        keyoResultMsg = "Keyo Pro activated successfully!"
                                                        viewModel.repository.updateSettings(settings.copy(isPro = true))
                                                    },
                                                    onFailure = { keyoResultMsg = it.message ?: "Activation failed." }
                                                )
                                            }
                                        },
                                        enabled = keyoActivationKey.isNotBlank() && !isActivatingKeyo,
                                        colors = ButtonDefaults.buttonColors(containerColor = CyanAccent)
                                    ) {
                                        Text("Activate", color = DarkBackground, fontWeight = FontWeight.Bold)
                                    }
                                }

                                if (keyoResultMsg != null) {
                                    Spacer(modifier = Modifier.height(6.dp))
                                    Text(keyoResultMsg!!, fontSize = 11.sp, color = CyanAccent)
                                }
                            }

                            Spacer(modifier = Modifier.height(16.dp))

                            // Target AI Model Selection per Plan v5 Section 4
                            Text("Target AI Model:", style = MaterialTheme.typography.labelMedium, color = TextPrimary, fontWeight = FontWeight.SemiBold)
                            Spacer(modifier = Modifier.height(6.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                val models = listOf(
                                    Pair("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"),
                                    Pair("claude-haiku-5-5", "Claude Haiku 5.5")
                                )
                                models.forEach { (modelId, display) ->
                                    val isSel = activeModel == modelId
                                    Surface(
                                        shape = RoundedCornerShape(10.dp),
                                        color = if (isSel) ElectricBlue.copy(alpha = 0.2f) else DarkSurfaceVariant,
                                        border = androidx.compose.foundation.BorderStroke(1.dp, if (isSel) ElectricBlue else DarkBorder),
                                        modifier = Modifier
                                            .weight(1f)
                                            .clickable {
                                                activeModel = modelId
                                                val provider = if (modelId.startsWith("gemini")) "gemini" else "claude"
                                                viewModel.repository.updateSettings(settings.copy(activeAiModel = modelId, activeProvider = provider))
                                                scope.launch { TaskitatorWorkerApi.setAiProvider(provider, settings.authToken) }
                                            }
                                    ) {
                                        Column(modifier = Modifier.padding(10.dp)) {
                                            Text(display, color = if (isSel) ElectricBlue else TextPrimary, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                                            Text(modelId, color = TextMuted, fontSize = 10.sp)
                                        }
                                    }
                                }
                            }

                            Spacer(modifier = Modifier.height(16.dp))

                            // Hosted vs BYOK Mode Toggle
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        useByokState = !useByokState
                                        viewModel.repository.updateSettings(settings.copy(useByok = useByokState))
                                        scope.launch { TaskitatorWorkerApi.toggleUseByok(useByokState, settings.authToken) }
                                    },
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text("Use Personal BYOK Key", color = TextPrimary, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text("Route audits through your personal key in the Worker KeyVault.", color = TextMuted, fontSize = 11.sp)
                                }
                                Switch(
                                    checked = useByokState,
                                    onCheckedChange = {
                                        useByokState = it
                                        viewModel.repository.updateSettings(settings.copy(useByok = it))
                                        scope.launch { TaskitatorWorkerApi.toggleUseByok(it, settings.authToken) }
                                    }
                                )
                            }

                            Spacer(modifier = Modifier.height(14.dp))

                            // Key Protection Explanation & Web Custom Tab Button (VERIFIED 11.4)
                            Surface(
                                shape = RoundedCornerShape(10.dp),
                                color = DarkSurfaceVariant,
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Column(modifier = Modifier.padding(12.dp)) {
                                    Text("Vault Security Notice", style = MaterialTheme.typography.labelMedium, color = CyanAccent, fontWeight = FontWeight.Bold)
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Text(
                                        text = "Keys are encrypted with API_VAULT_KEYS inside Cloudflare Durable Object storage, never transmitted to clients, and never stored locally on this phone. Add or update keys on the website.",
                                        fontSize = 11.sp,
                                        color = TextSecondary
                                    )
                                    Spacer(modifier = Modifier.height(10.dp))

                                    Button(
                                        onClick = {
                                            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://taskitator.mazendev.com"))
                                            context.startActivity(intent)
                                        },
                                        colors = ButtonDefaults.buttonColors(containerColor = CyanAccent),
                                        modifier = Modifier.fillMaxWidth()
                                    ) {
                                        Text("Manage AI Keys on Website (Custom Tab)", color = DarkBackground, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                                    }
                                }
                            }
                        }
                    }
                }

                4 -> {
                    // TAB 4: Phone Lock (MacroDroid contract per 11.6)
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("MacroDroid Phone Lock Integration", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(6.dp))
                            Text(
                                text = "MacroDroid polls the Worker status endpoint with a phone token:\nGET https://taskitator-sync.spacexmzez.workers.dev/?action=status&format=text\nReturns device_unlocked = true|false.",
                                fontSize = 11.sp,
                                color = TextSecondary
                            )

                            Spacer(modifier = Modifier.height(14.dp))

                            // Token generation
                            Button(
                                onClick = {
                                    isGeneratingToken = true
                                    phoneErrorMessage = null
                                    scope.launch {
                                        val res = TaskitatorWorkerApi.createPhoneToken(settings.authToken)
                                        isGeneratingToken = false
                                        res.fold(
                                            onSuccess = { token ->
                                                newlyCreatedToken = token
                                                phoneTokensList = phoneTokensList + token
                                                viewModel.repository.updateSettings(settings.copy(phoneTokens = phoneTokensList))
                                            },
                                            onFailure = {
                                                phoneErrorMessage = it.message ?: "Failed to generate phone token."
                                            }
                                        )
                                    }
                                },
                                enabled = !isGeneratingToken,
                                colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text(if (isGeneratingToken) "Generating..." else "Create New Phone Token", fontWeight = FontWeight.Bold)
                            }

                            if (newlyCreatedToken != null) {
                                Spacer(modifier = Modifier.height(10.dp))
                                Surface(
                                    shape = RoundedCornerShape(8.dp),
                                    color = WarningAmber.copy(alpha = 0.15f),
                                    border = androidx.compose.foundation.BorderStroke(1.dp, WarningAmber),
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Column(modifier = Modifier.padding(10.dp)) {
                                        Text("⚠️ Copy this token now. It will not be shown again:", color = WarningAmber, fontWeight = FontWeight.Bold, fontSize = 11.sp)
                                        Spacer(modifier = Modifier.height(4.dp))
                                        Text(newlyCreatedToken!!, color = TextPrimary, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                                        Spacer(modifier = Modifier.height(6.dp))
                                        Button(
                                            onClick = {
                                                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                                clipboard.setPrimaryClip(ClipData.newPlainText("phone_token", newlyCreatedToken))
                                                Toast.makeText(context, "Copied to clipboard", Toast.LENGTH_SHORT).show()
                                            },
                                            colors = ButtonDefaults.buttonColors(containerColor = WarningAmber),
                                            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)
                                        ) {
                                            Text("Copy Token", color = DarkBackground, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                        }
                                    }
                                }
                            }

                            if (phoneErrorMessage != null) {
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(phoneErrorMessage!!, color = PriorityP1, fontSize = 11.sp)
                            }
                        }
                    }
                }

                5 -> {
                    // TAB 5: Account & Data
                    Card(
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = DarkSurface),
                        border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Account Information", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(8.dp))
                            Text("User: ${settings.username}", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
                            Text("Remote Snapshot Version: v${settings.remoteVersion}", color = TextMuted, fontSize = 11.sp)

                            Spacer(modifier = Modifier.height(16.dp))

                            // Account Deletion per Plan v5 Section 9.4 and Google Play requirement (16)
                            OutlinedButton(
                                onClick = {
                                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://taskitator.mazendev.com"))
                                    context.startActivity(intent)
                                },
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = PriorityP1),
                                border = androidx.compose.foundation.BorderStroke(1.dp, PriorityP1),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("Delete Account on Website (Custom Tab)", fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }
    }
}
