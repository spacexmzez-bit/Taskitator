// File: pro/pro-client.js
// Taskitator Pro Phase 2: Client library for Keyo activation, status, Claude Haiku 5.5 review,
// multi-file proof review, batch proof review, and BYOK mode toggle.

(function(global) {
    class ProClient {
        constructor(options = {}) {
            this.baseUrl = options.baseUrl || null;
            this.getToken = options.getToken || this.defaultTokenProvider;
        }

        async defaultTokenProvider() {
            if (global.TaskitatorAuth?.token) {
                return await global.TaskitatorAuth.token();
            }
            if (global.Clerk?.session) {
                try {
                    return await global.Clerk.session.getToken();
                } catch (e) {
                    console.warn('[ProClient] Failed to retrieve token from Clerk session:', e);
                }
            }
            if (global.TaskitatorAuth?.getToken) {
                try {
                    return await global.TaskitatorAuth.getToken();
                } catch (e) {
                    console.warn('[ProClient] Failed to retrieve token from TaskitatorAuth:', e);
                }
            }
            return localStorage.getItem('taskitator_session_token') || null;
        }

        async request(path, options = {}) {
            // Resolve at request time: auth-config may load after this client.
            const baseUrl = (this.baseUrl || global.TASKITATOR_AUTH_CONFIG?.workerUrl || '').trim().replace(/\/+$/, '');
            if (!baseUrl) {
                throw new Error('Taskitator Worker URL is missing. Reload the app and check auth-config.js.');
            }
            const token = await this.getToken();
            if (!token) {
                throw new Error('You must be signed in to access Taskitator Pro features.');
            }

            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(options.headers || {})
            };

            const res = await fetch(`${baseUrl}${path}`, {
                ...options,
                headers,
                cache: 'no-store'
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                const err = new Error(data.error || `Pro API request failed with status ${res.status}`);
                err.status = res.status;
                err.code = data.code;
                err.details = data;
                throw err;
            }

            return data;
        }

        /**
         * Get Pro tier status and remaining daily/monthly credit balances.
         */
        async getStatus() {
            return await this.request('/pro/status', { method: 'GET' });
        }

        /**
         * Activate Pro using a Keyo license key.
         * @param {string} key - The Keyo license key
         */
        async activate(key) {
            if (!key || typeof key !== 'string') {
                throw new Error('Please enter a valid license key.');
            }
            return await this.request('/pro/activate', {
                method: 'POST',
                body: JSON.stringify({ key: key.trim() })
            });
        }

        /**
         * Toggle BYOK mode for Pro users (hosted limits do not reset).
         */
        async setUseByok(useByok) {
            return await this.request('/pro/byok', {
                method: 'POST',
                body: JSON.stringify({ use_byok: Boolean(useByok) })
            });
        }

        /**
         * Submit single or multi-file proof review to hosted Claude Haiku 5.5 gateway.
         */
        async reviewProof({ taskId, title, criteria, file, files, operationId }) {
            if (!taskId) throw new Error('taskId is required for proof review.');
            if (!criteria) throw new Error('Criteria must be defined for AI-audited review.');

            const opId = operationId || (crypto?.randomUUID ? crypto.randomUUID() : `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

            const payload = {
                task_id: taskId,
                task_title: title || 'Task',
                criteria,
                operation_id: opId
            };

            if (Array.isArray(files) && files.length) {
                payload.files = files.map(f => ({
                    mime_type: f.mimeType || f.mime_type,
                    data: f.data || f.base64
                }));
            } else if (file) {
                payload.file = {
                    mime_type: file.mimeType || file.mime_type,
                    data: file.data || file.base64
                };
            }

            return await this.request('/pro/ai/review', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        }

        /**
         * Phase 2: Batch Proof Review across multiple selected tasks.
         * @param {Array<{id: string, title: string, criteria: string}>} tasks
         * @param {Array<{mimeType: string, data: string}>} files
         */
        async batchReview({ tasks, files, operationId }) {
            if (!Array.isArray(tasks) || !tasks.length) throw new Error('Please select at least one task for batch review.');
            if (!Array.isArray(files) || !files.length) throw new Error('Please attach at least one proof file for batch review.');

            const opId = operationId || (crypto?.randomUUID ? crypto.randomUUID() : `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

            return await this.request('/pro/ai/batch-review', {
                method: 'POST',
                body: JSON.stringify({
                    tasks: tasks.map(t => ({ id: t.id, title: t.title, criteria: t.criteria || t.resolved_criteria || '' })),
                    files: files.map(f => ({ mime_type: f.mimeType || f.mime_type, data: f.data || f.base64 })),
                    operation_id: opId
                })
            });
        }

        /**
         * Phase 2: Confirm eligible batch completions with server attestation.
         */
        async batchConfirm({ jobId, taskIds, operationId }) {
            if (!jobId) throw new Error('jobId is required.');
            if (!Array.isArray(taskIds) || !taskIds.length) throw new Error('taskIds array is required.');

            const opId = operationId || (crypto?.randomUUID ? crypto.randomUUID() : `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

            return await this.request('/pro/ai/batch-confirm', {
                method: 'POST',
                body: JSON.stringify({
                    job_id: jobId,
                    task_ids: taskIds,
                    operation_id: opId
                })
            });
        }
    }

    global.ProClient = ProClient;
    global.TaskitatorPro = global.TaskitatorPro || new ProClient();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { ProClient };
    }
})(typeof window !== 'undefined' ? window : globalThis);
