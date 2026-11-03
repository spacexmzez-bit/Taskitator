package com.example.data.util

object VariableResolver {
    private val VAR_DEF_REGEX = Regex("\\{([a-zA-Z0-9_]+)==([^}]+)\\}")
    private val VAR_REF_REGEX = Regex("\\{([a-zA-Z0-9_]+)\\}")

    data class TitleResolution(
        val rawTitle: String,
        val resolvedTitle: String,
        val variables: Map<String, String>
    )

    fun resolveTitleVariables(title: String): TitleResolution {
        val vars = mutableMapOf<String, String>()
        val matches = VAR_DEF_REGEX.findAll(title)
        for (m in matches) {
            val key = m.groupValues[1]
            val value = m.groupValues[2]
            vars[key] = value
        }
        val cleanTitle = VAR_DEF_REGEX.replace(title) { it.groupValues[2] }
        return TitleResolution(
            rawTitle = title,
            resolvedTitle = cleanTitle,
            variables = vars
        )
    }

    fun resolveCriteria(criteria: String, variables: Map<String, String>): Pair<String, List<String>> {
        val missingKeys = mutableListOf<String>()
        val resolved = VAR_REF_REGEX.replace(criteria) { match ->
            val key = match.groupValues[1]
            if (variables.containsKey(key)) {
                variables[key] ?: match.value
            } else {
                missingKeys.add(key)
                match.value
            }
        }
        return Pair(resolved, missingKeys.distinct())
    }

    /**
     * Finds the next auto-incremented string for consecutive quick subtasks
     * e.g., "Chapter {num==1}" -> "Chapter {num==2}"
     */
    fun incrementConsecutivePattern(input: String): String {
        return VAR_DEF_REGEX.replace(input) { match ->
            val key = match.groupValues[1]
            val value = match.groupValues[2]
            val num = value.toIntOrNull()
            if (num != null) {
                "{$key==${num + 1}}"
            } else {
                match.value
            }
        }
    }
}
