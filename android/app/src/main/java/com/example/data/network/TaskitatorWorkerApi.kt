package com.example.data.network

import android.util.Base64
import com.example.data.model.CriteriaValidationResult
import com.example.data.model.EvidenceAuditResult
import com.example.data.model.EvidenceAuditVerdict
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

object TaskitatorWorkerApi {

    // Hardcoded per build via Plan v5 (VERIFIED core.js). Not user-editable.
    const val WORKER_BASE_URL = "https://taskitator-sync.spacexmzez.workers.dev"

    private fun openConnection(path: String, method: String, token: String, username: String? = null): HttpURLConnection {
        val endpoint = URL("$WORKER_BASE_URL$path")
        val conn = endpoint.openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 15000
        conn.readTimeout = 55000 // Worker AI timeout is 55s per AIGateway.generate
        conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
        conn.setRequestProperty("X-App-ID", "taskitator")
        if (!username.isNullOrBlank()) {
            conn.setRequestProperty("X-Taskitator-User", username)
        }
        if (token.isNotBlank()) {
            conn.setRequestProperty("Authorization", "Bearer $token")
        }
        return conn
    }

    /**
     * POST /ai/generate with format='criteria' (VERIFIED AuditEngine.validateCriteria, pro.js)
     * Pass rule: score >= 7.
     */
    suspend fun validateCriteria(
        criteria: String,
        exemplarNote: String?,
        token: String
    ): Result<CriteriaValidationResult> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/ai/generate", "POST", token)
            conn.doOutput = true

            val payload = JSONObject().apply {
                put("format", "criteria")
                put("prompt", criteria)
                if (!exemplarNote.isNullOrBlank()) {
                    put("exemplar", exemplarNote)
                }
            }

            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(payload.toString()) }

            val responseCode = conn.responseCode
            if (responseCode in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                val obj = JSONObject(text)
                val score = obj.optInt("score", 0)
                val critique = obj.optString("critique", obj.optString("reason", "Criteria evaluated."))
                val suggestedRewrite = obj.optString("suggested_rewrite").takeIf { it.isNotBlank() }
                    ?: obj.optString("suggestedRewrite").takeIf { it.isNotBlank() }
                val isValid = score >= 7

                Result.success(
                    CriteriaValidationResult(
                        isValid = isValid,
                        score = score,
                        critique = critique,
                        suggestedRewrite = suggestedRewrite
                    )
                )
            } else if (responseCode == 400 || responseCode == 403) {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: ""
                Result.failure(Exception("Criteria validation needs an AI key saved on the website (Settings → AI). $err"))
            } else {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: "HTTP $responseCode"
                Result.failure(Exception("AI criteria validation failed ($err). Please retry."))
            }
        } catch (e: Exception) {
            Result.failure(Exception("AI verification service unreachable. Please retry."))
        }
    }

    /**
     * POST /pro/ai/quote -> POST /pro/ai/review -> POST /pro/ai/batch-confirm for hosted audits (VERIFIED pro-backend.js)
     */
    suspend fun auditProofHosted(
        taskId: String,
        criteria: String,
        fileBytes: ByteArray,
        mimeType: String,
        token: String
    ): Result<EvidenceAuditResult> = withContext(Dispatchers.IO) {
        try {
            // Step 1: Quote
            val quoteConn = openConnection("/pro/ai/quote", "POST", token)
            quoteConn.doOutput = true
            val quotePayload = JSONObject().apply {
                put("file_count", 1)
                put("total_bytes", fileBytes.size)
            }
            OutputStreamWriter(quoteConn.outputStream, "UTF-8").use { it.write(quotePayload.toString()) }
            if (quoteConn.responseCode !in 200..299) {
                return@withContext Result.failure(Exception("Unable to obtain audit quote (HTTP ${quoteConn.responseCode}). Please retry."))
            }
            val quoteText = BufferedReader(InputStreamReader(quoteConn.inputStream, "UTF-8")).use { it.readText() }
            val quoteObj = JSONObject(quoteText)
            val quoteId = quoteObj.optString("quote_id")

            // Step 2: Review
            val reviewConn = openConnection("/pro/ai/review", "POST", token)
            reviewConn.doOutput = true
            val base64Data = Base64.encodeToString(fileBytes, Base64.NO_WRAP)
            val reviewPayload = JSONObject().apply {
                put("quote_id", quoteId)
                put("task_id", taskId)
                put("criteria", criteria)
                put("files", JSONArray().apply {
                    put(JSONObject().apply {
                        put("data", base64Data)
                        put("mime_type", mimeType)
                    })
                })
            }
            OutputStreamWriter(reviewConn.outputStream, "UTF-8").use { it.write(reviewPayload.toString()) }
            if (reviewConn.responseCode !in 200..299) {
                return@withContext Result.failure(Exception("AI audit review failed (HTTP ${reviewConn.responseCode}). Task remains locked. Please retry."))
            }
            val reviewText = BufferedReader(InputStreamReader(reviewConn.inputStream, "UTF-8")).use { it.readText() }
            val reviewObj = JSONObject(reviewText)
            val passed = reviewObj.optBoolean("passed", false)
            val feedback = reviewObj.optString("feedback", reviewObj.optString("reasons", "Audit complete."))
            val opId = reviewObj.optString("operation_id")

            if (passed) {
                // Step 3: Batch Confirm
                val confirmConn = openConnection("/pro/ai/batch-confirm", "POST", token)
                confirmConn.doOutput = true
                val confirmPayload = JSONObject().apply {
                    put("operation_id", opId)
                    put("task_id", taskId)
                    put("batch", false)
                }
                OutputStreamWriter(confirmConn.outputStream, "UTF-8").use { it.write(confirmPayload.toString()) }
                if (confirmConn.responseCode in 200..299) {
                    Result.success(EvidenceAuditResult(verdict = EvidenceAuditVerdict.APPROVED, feedback = feedback))
                } else {
                    Result.failure(Exception("Audit confirmation failed on server. Please retry."))
                }
            } else {
                Result.success(EvidenceAuditResult(verdict = EvidenceAuditVerdict.REJECTED, feedback = feedback))
            }
        } catch (e: Exception) {
            Result.failure(Exception("AI proof audit service unreachable. Task remains locked. Please retry."))
        }
    }

    /**
     * POST /pro/ai/personal-review for BYOK audits (VERIFIED pro.js)
     */
    suspend fun auditProofPersonal(
        taskId: String,
        criteria: String,
        fileBytes: ByteArray,
        mimeType: String,
        token: String
    ): Result<EvidenceAuditResult> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/pro/ai/personal-review", "POST", token)
            conn.doOutput = true
            val base64Data = Base64.encodeToString(fileBytes, Base64.NO_WRAP)
            val payload = JSONObject().apply {
                put("task_id", taskId)
                put("criteria", criteria)
                put("files", JSONArray().apply {
                    put(JSONObject().apply {
                        put("data", base64Data)
                        put("mime_type", mimeType)
                    })
                })
            }
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(payload.toString()) }
            val code = conn.responseCode
            if (code in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                val obj = JSONObject(text)
                val passed = obj.optBoolean("passed", false)
                val feedback = obj.optString("feedback", obj.optString("reasons", "Audit complete."))
                val verdict = if (passed) EvidenceAuditVerdict.APPROVED else EvidenceAuditVerdict.REJECTED
                Result.success(EvidenceAuditResult(verdict = verdict, feedback = feedback))
            } else {
                Result.failure(Exception("Personal review returned HTTP $code. Task remains locked. Please retry."))
            }
        } catch (e: Exception) {
            Result.failure(Exception("AI audit service unreachable. Task remains locked. Please retry."))
        }
    }

    /**
     * GET /ai/keys - reads metadata about saved keys in Worker KeyVault
     */
    suspend fun getAiKeysMetadata(token: String): Result<Map<String, Boolean>> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/ai/keys", "GET", token)
            if (conn.responseCode in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                val obj = JSONObject(text)
                val map = mutableMapOf<String, Boolean>()
                map["gemini"] = obj.optBoolean("gemini", false)
                map["claude"] = obj.optBoolean("claude", false)
                Result.success(map)
            } else {
                Result.failure(Exception("HTTP ${conn.responseCode}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * POST /ai/provider - select active provider ('gemini' or 'claude')
     */
    suspend fun setAiProvider(provider: String, token: String): Result<Boolean> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/ai/provider", "POST", token)
            conn.doOutput = true
            val payload = JSONObject().apply { put("provider", provider) }
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(payload.toString()) }
            Result.success(conn.responseCode in 200..299)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * POST /ai/keys/test - test stored key in Worker KeyVault
     */
    suspend fun testStoredKey(provider: String, token: String): Result<Pair<Boolean, String>> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/ai/keys/test", "POST", token)
            conn.doOutput = true
            val payload = JSONObject().apply { put("provider", provider) }
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(payload.toString()) }
            val code = conn.responseCode
            if (code in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                val obj = JSONObject(text)
                val ok = obj.optBoolean("success", true)
                val msg = obj.optString("message", "Key test successful.")
                Result.success(Pair(ok, msg))
            } else {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: "HTTP $code"
                Result.success(Pair(false, err))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * GET /pro/status - check Keyo Pro entitlement status
     */
    suspend fun getProStatus(token: String): Result<Boolean> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/pro/status", "GET", token)
            if (conn.responseCode in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                val obj = JSONObject(text)
                Result.success(obj.optBoolean("is_pro", obj.optBoolean("isPro", false)))
            } else {
                Result.failure(Exception("HTTP ${conn.responseCode}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * POST /pro/activate - activate 16-character Keyo key
     */
    suspend fun activateProKey(key: String, token: String): Result<Boolean> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/pro/activate", "POST", token)
            conn.doOutput = true
            val payload = JSONObject().apply { put("key", key.trim()) }
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(payload.toString()) }
            if (conn.responseCode in 200..299) {
                Result.success(true)
            } else {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: "HTTP ${conn.responseCode}"
                Result.failure(Exception("Activation failed: $err"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * POST /pro/byok - toggle use_byok
     */
    suspend fun toggleUseByok(useByok: Boolean, token: String): Result<Boolean> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/pro/byok", "POST", token)
            conn.doOutput = true
            val payload = JSONObject().apply { put("use_byok", useByok) }
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(payload.toString()) }
            Result.success(conn.responseCode in 200..299)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * POST /pro/emergency (or /emergency) - trigger Emergency Bypass
     */
    suspend fun triggerEmergencyBypass(token: String): Result<JSONObject> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/pro/emergency", "POST", token)
            conn.doOutput = true
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write("{}") }
            val code = conn.responseCode
            if (code in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                Result.success(JSONObject(text))
            } else if (code == 409) {
                Result.failure(Exception("Emergency Bypass is already active."))
            } else if (code == 429) {
                Result.failure(Exception("Emergency Bypass uses exhausted for this weekly cycle."))
            } else {
                Result.failure(Exception("HTTP $code"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * GET /auth/me - inspect account and deletion status
     */
    suspend fun getAuthMe(token: String): Result<JSONObject> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/auth/me", "GET", token)
            val code = conn.responseCode
            if (code in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                Result.success(JSONObject(text))
            } else if (code == 410) {
                Result.failure(AccountDeletedException("Account deletion has been accepted."))
            } else {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: "HTTP $code"
                Result.failure(Exception("Auth check failed ($code): $err"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * POST /auth/account - connect/create Worker account
     */
    suspend fun connectAccount(token: String, mode: String = "create"): Result<JSONObject> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/auth/account", "POST", token)
            conn.doOutput = true
            val payload = JSONObject().apply { put("mode", mode) }
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(payload.toString()) }
            val code = conn.responseCode
            if (code in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                Result.success(JSONObject(text))
            } else {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: "HTTP $code"
                Result.failure(Exception("Account connection failed ($code): $err"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * GET /sync/pull - pull latest snapshot
     */
    suspend fun pullSync(token: String, username: String? = null): Result<JSONObject> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/sync/pull", "GET", token, username)
            val code = conn.responseCode
            if (code in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                Result.success(JSONObject(text))
            } else if (code == 410) {
                Result.failure(AccountDeletedException("Account deletion has been accepted."))
            } else if (code == 401) {
                Result.failure(SecurityException("Unauthorized (401). Please sign in again."))
            } else if (code == 403) {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: "HTTP 403"
                Result.failure(WorkerProtectionException("Forbidden (403): $err"))
            } else {
                Result.failure(Exception("Pull failed with HTTP $code"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Constructs the exact top-level snapshot payload for POST /sync/push.
     * Note: NEVER nest data under "payload".
     */
    fun createPushPayload(snapshot: JSONObject, baseVersion: Long, mutationId: String): JSONObject {
        val payload = JSONObject(snapshot.toString())
        payload.put("base_version", baseVersion)
        payload.put("mutation_id", mutationId)
        payload.remove("payload") // strictly avoid nested payload
        return payload
    }

    /**
     * POST /sync/push - push snapshot with base_version and mutation_id at top level
     */
    suspend fun pushSync(
        snapshot: JSONObject,
        baseVersion: Long,
        mutationId: String,
        token: String,
        username: String? = null
    ): Result<JSONObject> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/sync/push", "POST", token, username)
            conn.doOutput = true
            val payload = createPushPayload(snapshot, baseVersion, mutationId)
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(payload.toString()) }
            val code = conn.responseCode
            if (code in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                Result.success(JSONObject(text))
            } else if (code == 409) {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: "{}"
                Result.failure(SyncConflictException("SYNC_409_CONFLICT", err))
            } else if (code == 403) {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: "{}"
                Result.failure(WorkerProtectionException("SYNC_403_FORBIDDEN: $err", err))
            } else if (code == 410) {
                Result.failure(AccountDeletedException("Account deletion has been accepted."))
            } else if (code == 429) {
                Result.failure(RateLimitException("Push rate limit exceeded. Please retry shortly."))
            } else {
                val err = conn.errorStream?.let { BufferedReader(InputStreamReader(it)).use { r -> r.readText() } } ?: "HTTP $code"
                Result.failure(Exception("Push rejected ($code): $err"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Phone token routes: GET, POST, DELETE /auth/phone
     */
    suspend fun getPhoneTokens(token: String): Result<List<String>> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/auth/phone", "GET", token)
            if (conn.responseCode in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                val obj = JSONObject(text)
                val arr = obj.optJSONArray("tokens") ?: JSONArray()
                val list = mutableListOf<String>()
                for (i in 0 until arr.length()) {
                    list.add(arr.getString(i))
                }
                Result.success(list)
            } else {
                Result.failure(Exception("HTTP ${conn.responseCode}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun createPhoneToken(token: String): Result<String> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/auth/phone", "POST", token)
            conn.doOutput = true
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write("{}") }
            if (conn.responseCode in 200..299) {
                val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use { it.readText() }
                val obj = JSONObject(text)
                Result.success(obj.optString("token"))
            } else {
                Result.failure(Exception("HTTP ${conn.responseCode}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun revokePhoneToken(phoneToken: String, token: String): Result<Boolean> = withContext(Dispatchers.IO) {
        try {
            val conn = openConnection("/auth/phone", "DELETE", token)
            conn.doOutput = true
            val payload = JSONObject().apply { put("token", phoneToken) }
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(payload.toString()) }
            Result.success(conn.responseCode in 200..299)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}

class SyncConflictException(message: String, val errorJson: String = "") : Exception(message)
class WorkerProtectionException(message: String, val errorJson: String = "") : Exception(message)
class AccountDeletedException(message: String) : Exception(message)
class RateLimitException(message: String) : Exception(message)

