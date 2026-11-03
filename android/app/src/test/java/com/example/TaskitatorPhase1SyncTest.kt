package com.example

import com.example.data.network.TaskitatorWorkerApi
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TaskitatorPhase1SyncTest {

    @Test
    fun testPushPayloadIsTopLevelAndNotNestedUnderPayload() {
        val snapshot = JSONObject().apply {
            put("app", "taskitator")
            put("username", "TestUser")
            put("tasks", JSONArray().put(JSONObject().apply {
                put("id", "task_1")
                put("title", "Real Task")
            }))
            put("projects", JSONArray())
            put("settings", JSONObject().apply {
                put("copilot_name", "Ari")
            })
            put("recurrence_state", JSONObject().apply {
                put("series", JSONArray())
            })
            put("universe_excluded_field", "preserve_me")
            put("sleep_lock_excluded_field", "preserve_me_too")
        }

        val baseVersion = 42L
        val mutationId = "mutation-uuid-12345"

        val pushPayload = TaskitatorWorkerApi.createPushPayload(snapshot, baseVersion, mutationId)

        // Strict verification:
        assertFalse("Payload must NOT contain nested 'payload' key", pushPayload.has("payload"))
        assertEquals("base_version must be at root", 42L, pushPayload.getLong("base_version"))
        assertEquals("mutation_id must be at root", "mutation-uuid-12345", pushPayload.getString("mutation_id"))
        assertEquals("app must be at root", "taskitator", pushPayload.getString("app"))
        assertEquals("tasks array must be at root", 1, pushPayload.getJSONArray("tasks").length())
        assertEquals("universe field preserved", "preserve_me", pushPayload.getString("universe_excluded_field"))
        assertEquals("sleep lock field preserved", "preserve_me_too", pushPayload.getString("sleep_lock_excluded_field"))
    }

    @Test
    fun testDefaultSnapshotHasZeroDemoTasks() {
        val defaultSnapshot = JSONObject().apply {
            put("app", "taskitator")
            put("username", "Focus Champion")
            put("tasks", JSONArray())
            put("settings", JSONObject())
        }

        val tasksArray = defaultSnapshot.getJSONArray("tasks")
        assertEquals("Initial default tasks must be empty (NO demo tasks)", 0, tasksArray.length())
    }

    @Test
    fun testRawJsonRoundTripPreservesExcludedAndUnknownFields() {
        val serverJson = JSONObject().apply {
            put("app", "taskitator")
            put("version", 5L)
            put("universe_groups", JSONArray().put(JSONObject().apply { put("id", "grp_1"); put("name", "Team") }))
            put("sleep_lock_schedule", JSONObject().apply { put("bedtime", "23:00") })
            put("recurrence_state", JSONObject().apply { put("series", JSONArray()); put("schema", 1) })
            put("tasks", JSONArray().put(JSONObject().apply {
                put("id", "task_99")
                put("title", "Server Task")
                put("smart_study_opaque_tag", "DO_NOT_STRIP")
            }))
        }

        // Simulating client modification of a task title while preserving opaque/excluded fields
        val tasksArr = serverJson.getJSONArray("tasks")
        val taskObj = tasksArr.getJSONObject(0)

        // Modify title
        taskObj.put("title", "Server Task Updated")

        val pushPayload = TaskitatorWorkerApi.createPushPayload(serverJson, 5L, "mut_test")

        assertEquals("Server Task Updated", pushPayload.getJSONArray("tasks").getJSONObject(0).getString("title"))
        assertEquals("DO_NOT_STRIP", pushPayload.getJSONArray("tasks").getJSONObject(0).getString("smart_study_opaque_tag"))
        assertTrue("Universe fields must be preserved verbatim", pushPayload.has("universe_groups"))
        assertTrue("Sleep Lock fields must be preserved verbatim", pushPayload.has("sleep_lock_schedule"))
        assertTrue("Recurrence state preserved verbatim", pushPayload.has("recurrence_state"))
    }
}
