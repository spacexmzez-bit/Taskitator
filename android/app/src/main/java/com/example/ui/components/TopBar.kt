package com.example.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.BreakPlanningState
import com.example.data.model.BreakPlanningStateEnum
import com.example.data.model.UserSettings
import com.example.ui.theme.*

@Composable
fun TaskitatorTopBar(
    settings: UserSettings,
    completedTasksCount: Int,
    hasDistractionNotes: Boolean,
    breakPlanning: BreakPlanningState,
    onOpenDrawer: () -> Unit,
    onOpenBreaksModal: () -> Unit,
    onOpenDistractionDump: () -> Unit,
    onOpenEmergencyBypass: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        color = DarkSurface,
        tonalElevation = 4.dp,
        modifier = modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            // Left: Hamburger Menu
            IconButton(
                onClick = onOpenDrawer,
                modifier = Modifier.testTag("open_drawer_button")
            ) {
                Icon(
                    imageVector = Icons.Default.Menu,
                    contentDescription = "Open navigation menu",
                    tint = TextPrimary
                )
            }

            // Center Actions: Completed Counter, Break Status Pill, Distraction Scratchpad, Emergency Bypass
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                // Completed Task Count Button
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = DarkSurfaceVariant,
                    modifier = Modifier.testTag("completed_tasks_counter")
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Text("✓", fontSize = 12.sp, color = SuccessGreen, fontWeight = FontWeight.Bold)
                        Text(
                            text = "$completedTasksCount",
                            style = MaterialTheme.typography.labelSmall,
                            color = TextPrimary,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }

                // Break Pill with States (Plan / Breaks Locked / Planning Closed / Repair Breaks per 9.1)
                val breakLabel = when (breakPlanning.state) {
                    BreakPlanningStateEnum.PLAN -> "Plan Breaks"
                    BreakPlanningStateEnum.BREAKS_LOCKED -> "Breaks Locked"
                    BreakPlanningStateEnum.PLANNING_CLOSED -> "Planning Closed"
                    BreakPlanningStateEnum.REPAIR_BREAKS -> "Repair Breaks"
                }
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = if (breakPlanning.isLocked) SuccessGreen.copy(alpha = 0.2f) else DarkSurfaceVariant,
                    border = androidx.compose.foundation.BorderStroke(
                        1.dp,
                        if (breakPlanning.isLocked) SuccessGreen.copy(alpha = 0.5f) else DarkBorder
                    ),
                    modifier = Modifier
                        .clickable(onClick = onOpenBreaksModal)
                        .testTag("break_status_pill")
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Text("☕", fontSize = 12.sp)
                        Text(
                            text = breakLabel,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (breakPlanning.isLocked) SuccessGreen else TextPrimary,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }

                // Distraction Dump (Scratchpad Lightbulb)
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(DarkSurfaceVariant)
                        .clickable(onClick = onOpenDistractionDump)
                        .testTag("distraction_dump_button"),
                    contentAlignment = Alignment.Center
                ) {
                    Text("💡", fontSize = 16.sp)
                    if (hasDistractionNotes) {
                        Box(
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .padding(4.dp)
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(CyanAccent)
                        )
                    }
                }

                // Emergency Bypass Button (🚨)
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (settings.emergencyBypassActive) PriorityP1 else DarkSurfaceVariant)
                        .clickable(onClick = onOpenEmergencyBypass)
                        .testTag("emergency_bypass_button"),
                    contentAlignment = Alignment.Center
                ) {
                    Text("🚨", fontSize = 15.sp)
                }
            }
        }
    }
}
