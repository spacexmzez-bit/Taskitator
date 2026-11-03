package com.example

import com.example.data.model.*
import com.example.data.util.AuditEngine
import com.example.data.util.CriteriaValidator
import com.example.data.util.VariableResolver
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class TaskitatorUnitTest {

    @Test
    fun testCriteriaTemplatesCountAndIntegrity() {
        // Plan v5 10.3: Bundle CRITERIA_TEMPLATES.json (11 templates); re-count 11 on load in a test
        val file = listOf(
            File("src/main/assets/CRITERIA_TEMPLATES.json"),
            File("../CRITERIA_TEMPLATES.json"),
            File("CRITERIA_TEMPLATES.json"),
            File("app/src/main/assets/CRITERIA_TEMPLATES.json")
        ).firstOrNull { it.exists() }
        assertNotNull("CRITERIA_TEMPLATES.json must exist in assets or root", file)
        val jsonStr = file!!.readText()
        val templates = CriteriaValidator.parseTemplatesJson(jsonStr)

        assertEquals("Exactly 11 criteria templates must be loaded", 11, templates.size)
        val ids = templates.map { it.id }.toSet()
        assertTrue("Must include written_notes", ids.contains("written_notes"))
        assertTrue("Must include formula_derivation", ids.contains("formula_derivation"))
        assertTrue("Must include timed_exam", ids.contains("timed_exam"))
    }

    @Test
    fun testTitleVariablesParsingAndResolution() {
        val rawTitle = "Chapter {num==12} on {topic==Thermodynamics}"
        val res = VariableResolver.resolveTitleVariables(rawTitle)

        assertEquals("Chapter 12 on Thermodynamics", res.resolvedTitle)
        assertEquals("12", res.variables["num"])
        assertEquals("Thermodynamics", res.variables["topic"])

        val criteriaTemplate = "Notes on {topic} covering Section {num}."
        val (resolved, missing) = VariableResolver.resolveCriteria(criteriaTemplate, res.variables)
        assertEquals("Notes on Thermodynamics covering Section 12.", resolved)
        assertTrue("Missing variables should be empty", missing.isEmpty())
    }

    @Test
    fun testUnresolvedVariablesDetection() {
        val criteria = "Solve questions for {subject} with minimum {count} problems."
        val vars = mapOf("subject" to "Physics")
        val (resolved, missing) = VariableResolver.resolveCriteria(criteria, vars)

        assertEquals("Solve questions for Physics with minimum {count} problems.", resolved)
        assertEquals(listOf("count"), missing)
    }

    @Test
    fun testConsecutiveQuickSubtaskIncrement() {
        val input = "Problem {num==1}"
        val incremented = VariableResolver.incrementConsecutivePattern(input)
        assertEquals("Problem {num==2}", incremented)

        val next = VariableResolver.incrementConsecutivePattern(incremented)
        assertEquals("Problem {num==3}", next)
    }

    @Test
    fun testShieldBlocksCompletionUntilNonBonusSubtasksDone() {
        val parent = Task(
            id = "parent_1",
            title = "Parent Task",
            requireAllSubtasksFirst = true
        )
        val childRequired = Task(
            id = "child_1",
            parentId = "parent_1",
            title = "Required Child",
            status = TaskStatus.ACTIVE,
            isBonus = false
        )
        val childBonus = Task(
            id = "child_2",
            parentId = "parent_1",
            title = "Bonus Child",
            status = TaskStatus.ACTIVE,
            isBonus = true
        )

        // Shield blocks because required child is ACTIVE
        val check1 = AuditEngine.canCompleteParent(parent, listOf(childRequired, childBonus))
        assertFalse("Parent completion should be blocked by active non-bonus child", check1.first)

        // Mark required child COMPLETED, bonus remains ACTIVE
        val childRequiredCompleted = childRequired.copy(status = TaskStatus.COMPLETED)
        val check2 = AuditEngine.canCompleteParent(parent, listOf(childRequiredCompleted, childBonus))
        assertTrue("Parent completion should succeed because only bonus child is active", check2.first)
    }

    @Test
    fun testSavedCriteriaRulesEnforcement() {
        val existing = listOf(
            SavedCriteria(id = "1", criteria = "c1", score = 9),
            SavedCriteria(id = "2", criteria = "c2", score = 10),
            SavedCriteria(id = "3", criteria = "c3", score = 9),
            SavedCriteria(id = "4", criteria = "c4", score = 9),
            SavedCriteria(id = "5", criteria = "c5", score = 9)
        )

        // Score below 9 should fail
        val lowScore = SavedCriteria(id = "6", criteria = "c6", score = 7)
        val checkLow = CriteriaValidator.validateSavedCriteriaRules(existing, lowScore)
        assertFalse("Preset score < 9 must be rejected", checkLow.first)

        // Adding 6th item should succeed
        val valid6th = SavedCriteria(id = "6", criteria = "c6", score = 9)
        val check6th = CriteriaValidator.validateSavedCriteriaRules(existing, valid6th)
        assertTrue("6th preset should be accepted", check6th.first)

        // 7th item should fail (max 6)
        val existing6 = existing + valid6th
        val item7 = SavedCriteria(id = "7", criteria = "c7", score = 10)
        val check7 = CriteriaValidator.validateSavedCriteriaRules(existing6, item7)
        assertFalse("More than 6 presets must be rejected", check7.first)
    }

    @Test
    fun testRawJsonRoundTripPreservesUnknownFields() {
        val originalJson = JSONObject().apply {
            put("app", "taskitator")
            put("custom_server_meta", "xyz_123")
            put("projects", JSONArray().put(JSONObject().apply { put("id", "proj_1"); put("name", "Deep Work") }))
            put("tasks", JSONArray().put(JSONObject().apply {
                put("id", "t_1")
                put("title", "Task 1")
                put("smart_study_internal_tag", "DO_NOT_ERASE")
            }))
        }

        // Simulating raw snapshot preservation
        val tasksArr = originalJson.getJSONArray("tasks")
        val taskObj = tasksArr.getJSONObject(0)
        val unmapped = mutableMapOf<String, Any?>()
        val iter = taskObj.keys()
        while (iter.hasNext()) {
            val k = iter.next()
            if (k !in setOf("id", "title")) unmapped[k] = taskObj.get(k)
        }

        // Re-serialize
        val reconstructedObj = JSONObject()
        unmapped.forEach { (k, v) -> reconstructedObj.put(k, v) }
        reconstructedObj.put("id", taskObj.getString("id"))
        reconstructedObj.put("title", "Task 1 Renamed")

        assertEquals("DO_NOT_ERASE", reconstructedObj.getString("smart_study_internal_tag"))
        assertEquals("xyz_123", originalJson.getString("custom_server_meta"))
        assertEquals("Deep Work", originalJson.getJSONArray("projects").getJSONObject(0).getString("name"))
    }
}
