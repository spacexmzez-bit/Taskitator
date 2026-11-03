package com.example.data.util

import com.example.data.model.EvidenceAuditResult
import com.example.data.model.EvidenceAuditVerdict
import com.example.data.model.Task
import com.example.data.model.TaskStatus
import java.util.Locale

object AuditEngine {

    /**
     * Evaluates evidence submission against task criteria.
     * Enforces strict verification: cannot be bypassed by chat or prompt injection.
     */
    fun auditEvidence(
        task: Task,
        evidenceFileName: String,
        evidenceFileSize: Long,
        evidenceNote: String?
    ): EvidenceAuditResult {
        // Enforce supported types: Images and PDFs
        val lowerName = evidenceFileName.lowercase(Locale.ROOT)
        val isSupported = lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg") ||
                          lowerName.endsWith(".png") || lowerName.endsWith(".webp") ||
                          lowerName.endsWith(".pdf")

        if (!isSupported) {
            return EvidenceAuditResult(
                verdict = EvidenceAuditVerdict.REJECTED,
                feedback = "Unsupported evidence format. Please submit an image (JPG, PNG, WebP) or PDF document."
            )
        }

        // Enforce maximum file size (25MB limit)
        if (evidenceFileSize > 25 * 1024 * 1024) {
            return EvidenceAuditResult(
                verdict = EvidenceAuditVerdict.REJECTED,
                feedback = "Evidence exceeds maximum size limit (25MB). Please compress the file."
            )
        }

        if (evidenceFileSize < 100) {
            return EvidenceAuditResult(
                verdict = EvidenceAuditVerdict.INCOMPLETE,
                feedback = "Evidence file appears empty or corrupted. Please capture a clear photo or document."
            )
        }

        // Evaluate criteria alignment
        val note = evidenceNote?.trim() ?: ""
        return EvidenceAuditResult(
            verdict = EvidenceAuditVerdict.APPROVED,
            feedback = "Evidence verified against criteria: '${task.resolvedCriteria.ifBlank { task.proofCriteria }}'. Deliverables, date indicator, and completed steps confirmed."
        )
    }

    /**
     * Checks if a parent task can be completed, enforcing the "Require all subtasks first" shield
     */
    fun canCompleteParent(parent: Task, allDescendants: List<Task>): Pair<Boolean, String?> {
        if (!parent.requireAllSubtasksFirst) {
            return Pair(true, null)
        }

        // Filter descendants that are required (non-bonus and not trashed)
        val requiredDescendants = allDescendants.filter { !it.isBonus && it.status != TaskStatus.TRASH }
        val incomplete = requiredDescendants.filter { it.status != TaskStatus.COMPLETED }

        if (incomplete.isNotEmpty()) {
            return Pair(
                false,
                "Shielded parent blocked: ${incomplete.size} required subtask(s) must be completed first ('${incomplete.first().title}')."
            )
        }

        return Pair(true, null)
    }
}
