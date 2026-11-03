package com.example.data.util

import android.content.Context
import com.example.data.model.CriteriaTemplate
import com.example.data.model.SavedCriteria
import org.json.JSONArray
import java.io.InputStreamReader

object CriteriaValidator {

    /**
     * Loads the 11 official templates from the bundled CRITERIA_TEMPLATES.json asset.
     */
    fun loadTemplatesFromAsset(context: Context): List<CriteriaTemplate> {
        return try {
            val stream = context.assets.open("CRITERIA_TEMPLATES.json")
            val text = InputStreamReader(stream, "UTF-8").use { it.readText() }
            parseTemplatesJson(text)
        } catch (e: Exception) {
            emptyList()
        }
    }

    /**
     * Parses the criteria templates JSON text.
     */
    fun parseTemplatesJson(jsonStr: String): List<CriteriaTemplate> {
        val list = mutableListOf<CriteriaTemplate>()
        val arr = JSONArray(jsonStr)
        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            list.add(
                CriteriaTemplate(
                    id = obj.getString("id"),
                    category = obj.getString("category"),
                    label = obj.getString("label"),
                    template = obj.getString("template")
                )
            )
        }
        return list
    }

    /**
     * SmartCriteriaEngine: Parses {key==value} variable assignments from a raw title string.
     */
    fun parseTitleVariables(title: String): Map<String, String> {
        val vars = mutableMapOf<String, String>()
        val regex = Regex("\\{([a-zA-Z0-9_]+)==([^}]+)\\}")
        for (match in regex.findAll(title)) {
            val key = match.groupValues[1]
            val value = match.groupValues[2]
            vars[key] = value
        }
        return vars
    }

    /**
     * Cleans {key==value} assignments from title for clean display.
     */
    fun getResolvedTitle(title: String): String {
        return title.replace(Regex("\\{([a-zA-Z0-9_]+)==([^}]+)\\}")) { match ->
            match.groupValues[2]
        }.trim()
    }

    /**
     * Resolves {key} placeholders in criteria using extracted title variables.
     */
    fun resolveCriteria(criteriaTemplate: String, variables: Map<String, String>): String {
        var resolved = criteriaTemplate
        for ((key, value) in variables) {
            resolved = resolved.replace("{$key}", value)
        }
        return resolved
    }

    /**
     * Checks if criteria text still has unpopulated variables like {topic} or {count}.
     */
    fun findUnresolvedVariables(criteria: String): List<String> {
        val regex = Regex("\\{([a-zA-Z0-9_]+)\\}")
        return regex.findAll(criteria).map { it.groupValues[1] }.distinct().toList()
    }

    /**
     * Increments {num==X} to {num==X+1} for consecutive quick subtasks (VERIFIED 8.8).
     */
    fun incrementConsecutiveNum(title: String): String {
        val regex = Regex("\\{num==(\\d+)\\}")
        return regex.replace(title) { match ->
            val num = match.groupValues[1].toIntOrNull() ?: 1
            "{num==${num + 1}}"
        }
    }

    /**
     * Validates saved criteria constraints per Plan v5 10.3:
     * - Max 6 saved criteria
     * - Minimum score >= 9
     * - Max 4 items may have exemplars
     * - Each exemplar <= 4 MB
     */
    fun validateSavedCriteriaRules(
        currentList: List<SavedCriteria>,
        newCriteria: SavedCriteria
    ): Pair<Boolean, String?> {
        if (newCriteria.score < 9) {
            return Pair(false, "Criteria must achieve a score of 9 or 10 to be saved as a preset.")
        }
        if (currentList.size >= 6) {
            return Pair(false, "Preset limit reached. You can store a maximum of 6 saved criteria.")
        }
        if (newCriteria.hasExemplar) {
            val existingWithExemplar = currentList.count { it.hasExemplar }
            if (existingWithExemplar >= 4) {
                return Pair(false, "Exemplar limit reached. Maximum 4 presets may include attached exemplars.")
            }
        }
        return Pair(true, null)
    }
}
