// File: pro/pro-client.js
// Taskitator Pro Phase 1: Client library for Keyo activation, status, and hosted AI review

(function(global) {
    class ProClient {
        constructor(options = {}) {
            this.baseUrl = options.baseUrl || '';
            this.getToken = options.getToken || this.defaultTokenProvider;
        }

        async defaultTokenProvider() {
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
            const token = await this.getToken();
            if (!token) {
                throw new Error('You must be signed in to access Taskitator Pro features.');
            }

            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(options.headers || {})
            };

            const res = await fetch(`${this.baseUrl}${path}`, {
                ...options,
                headers
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
         * @param {string} key - The Keyo license key (e.g. KEYO-PRO-xxxx-xxxx)
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
         * Submit an AI-audited task proof to the hosted Gemini Flash/Lite gateway.
         */
        async reviewProof({ taskId, title, criteria, file, operationId, model }) {
            if (!taskId) throw new Error('taskId is required for proof review.');
            if (!criteria) throw new Error('Criteria must be defined for AI-audited review.');

            const opId = operationId || (crypto?.randomUUID ? crypto.randomUUID() : `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

            return await this.request('/pro/ai/review', {
                method: 'POST',
                body: JSON.stringify({
                    task_id: taskId,
                    task_title: title || 'Task',
                    criteria,
                    file: file ? {
                        mime_type: file.mimeType || file.mime_type,
                        data: file.data || file.base64
                    } : null,
                    operation_id: opId,
                    model: model || 'gemini-3.5-flash-lite'
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
