package com.example.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.data.model.CustomPriority
import com.example.data.model.DEFAULT_PRIORITIES
import com.example.ui.theme.*

@Composable
fun FilterDialog(
    selectedPriority: String?,
    selectedTag: String?,
    allTags: List<String>,
    customPriorities: List<CustomPriority> = DEFAULT_PRIORITIES,
    onSelectPriority: (String?) -> Unit,
    onSelectTag: (String?) -> Unit,
    onClearFilters: () -> Unit,
    onDismiss: () -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = DarkSurface,
            border = androidx.compose.foundation.BorderStroke(1.dp, DarkBorder),
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text("Filter Tasks", style = MaterialTheme.typography.titleMedium, color = TextPrimary, fontWeight = FontWeight.Bold)

                Spacer(modifier = Modifier.height(14.dp))
                Text("By Priority", style = MaterialTheme.typography.labelLarge, color = TextSecondary)
                Spacer(modifier = Modifier.height(6.dp))

                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                    Surface(
                        shape = RoundedCornerShape(6.dp),
                        color = if (selectedPriority == null) ElectricBlue else DarkSurfaceVariant,
                        modifier = Modifier.weight(1f).clickable { onSelectPriority(null) }
                    ) {
                        Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 6.dp)) {
                            Text("All", color = TextPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    customPriorities.forEach { p ->
                        val isSel = selectedPriority == p.id
                        val color = when (p.id) {
                            "prio_high" -> PriorityP1
                            "prio_med" -> PriorityP2
                            "prio_low" -> PriorityP3
                            else -> PriorityP4
                        }
                        Surface(
                            shape = RoundedCornerShape(6.dp),
                            color = if (isSel) color else DarkSurfaceVariant,
                            modifier = Modifier.weight(1f).clickable { onSelectPriority(if (isSel) null else p.id) }
                        ) {
                            Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 6.dp)) {
                                Text(p.label, color = TextPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))
                Text("By Tag", style = MaterialTheme.typography.labelLarge, color = TextSecondary)
                Spacer(modifier = Modifier.height(6.dp))

                if (allTags.isEmpty()) {
                    Text("No tags in existing tasks.", style = MaterialTheme.typography.bodyMedium, color = TextMuted)
                } else {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        allTags.take(4).forEach { tag ->
                            val isSel = selectedTag == tag
                            Surface(
                                shape = RoundedCornerShape(12.dp),
                                color = if (isSel) CyanAccent else DarkSurfaceVariant,
                                modifier = Modifier.clickable { onSelectTag(if (isSel) null else tag) }
                            ) {
                                Text(
                                    text = "#$tag",
                                    color = if (isSel) DarkBackground else TextPrimary,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                                )
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(20.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { onClearFilters(); onDismiss() }) {
                        Text("Clear All", color = DangerRed)
                    }
                    Button(onClick = onDismiss, colors = ButtonDefaults.buttonColors(containerColor = ElectricBlue)) {
                        Text("Apply", color = TextPrimary, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}
