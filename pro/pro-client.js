// File: pro/pro-client.js
// Taskitator Pro Phase 2: Client library for Keyo activation, status, Claude Haiku 5.5 review,
// multi-file proof review, batch proof review, and BYOK mode toggle.

(function(global) {
    class ProClient {
        constructor(options = {}) {
            this.baseUrl = options.baseUrl || null;
            this.getToken = options.getToken || this.defaultTokenProvider;
            this.pendingAudits = new Map();
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
        async reviewProof({ taskId, title, criteria, file, files, operationId, exemplar }) {
            if (!taskId) throw new Error('taskId is required for proof review.');
            if (!criteria) throw new Error('Criteria must be defined for AI-audited review.');

            const opId = operationId || (crypto?.randomUUID ? crypto.randomUUID() : `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

            const payload = {
                task_id: taskId,
                task_title: title || 'Task',
                criteria,
                operation_id: opId,
                exemplar: exemplar || null
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

            return await this.quotedReview(payload,false);
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

            return await this.quotedReview({
                tasks:tasks.map(t => ({id:t.id,title:t.title,criteria:t.criteria || t.resolved_criteria || '',exemplar:t.exemplar || null})),
                files:files.map(f => ({mime_type:f.mimeType || f.mime_type,data:f.data || f.base64})),
                operation_id:opId
            },true);
        }

        async quotedReview(payload,batch) {
            const owner = global.Clerk?.session?.id;
            const {operation_id:ignored,...input} = payload;
            const hashed = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({owner,input,batch})));
            const fingerprint = Array.from(new Uint8Array(hashed),b=>b.toString(16).padStart(2,'0')).join('');
            payload = {...payload,operation_id:this.pendingAudits.get(fingerprint) || payload.operation_id};
            this.pendingAudits.set(fingerprint,payload.operation_id);
            try {
                const quote = await this.request('/pro/ai/quote', {method:'POST',body:JSON.stringify({...payload,batch})});
                if (global.Clerk?.session?.id !== owner) throw new Error('Your session changed. Start a new audit.');
                if (quote.completed) { this.pendingAudits.delete(fingerprint); return quote.result; }
                if (!Number.isFinite(quote.maximum_credits) || quote.maximum_credits <= 0 || !quote.quote_id)
                    throw new Error('Could not obtain a valid audit price. No paid audit was started.');
                const tasks = batch ? payload.tasks : [{id:payload.task_id,title:payload.task_title}];
                const names = new Map(tasks.map((task,index) => {
                    const title = typeof task.title === 'string' ? task.title.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,120) : '';
                    return [task.id,title || (batch ? `Task ${index+1}` : 'Task')];
                }));
                const credits = value => Number(value.toFixed(3)).toString();
                const perTask = quote.tasks.map((task,index) =>
                    `${names.get(task.task_id) || (batch ? `Task ${index+1}` : 'Task')}: up to ${credits(task.credits)} credits` +
                    (task.exemplar ? ' (reference comparison: double charge)' : '')).join('\n');
                const text = 'Review price\n\n' +
                    `Estimated charge: ${credits(quote.estimated_credits)} credits\n` +
                    `Maximum held temporarily: ${credits(quote.maximum_credits)} credits\n\n` +
                    perTask + '\n\n' +
                    (batch && payload.tasks.length >= 2 ? 'Each task includes a 25% batch discount.\n\n' : '') +
                    'We temporarily hold the maximum shown. Your final charge depends on the amount of proof and review work, and will not exceed that maximum. Unused held credits return to your balance.\n\n' +
                    'You pay for the review even if the proof is not approved. Cancelling now starts no paid review.\n\nStart review?';
                if (!global.confirm(text)) throw Object.assign(new Error('Audit cancelled. No paid review was started.'),{code:'AUDIT_CANCELLED'});
                if (global.Clerk?.session?.id !== owner) throw new Error('Your session changed. Start a new audit.');
                const result = await this.request(batch ? '/pro/ai/batch-review' : '/pro/ai/review',{
                    method:'POST',body:JSON.stringify({...payload,quote_id:quote.quote_id})});
                this.pendingAudits.delete(fingerprint); return result;
            } catch (error) {
                // A lost browser response may already have been billed. Keep that operation for the next retry.
                if ((error.status && error.code !== 'AUDIT_PENDING') || error.code === 'AUDIT_CANCELLED') this.pendingAudits.delete(fingerprint);
                throw error;
            }
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

        /**
         * Phase 2.5: Check if a unique username is available.
         */
        async checkUsername(username) {
            if (!username) throw new Error('Username is required.');
            return await this.request(`/pro/username/check?username=${encodeURIComponent(username.trim())}`, {
                method: 'GET'
            });
        }

        /**
         * Phase 2.5: Set or update the account's unique username.
         */
        async setUsername(username) {
            if (!username) throw new Error('Username is required.');
            return await this.request('/pro/username', {
                method: 'POST',
                body: JSON.stringify({ username: username.trim() })
            });
        }

        /**
         * Phase 2.5: Get the account username profile.
         */
        async getUsernameProfile() {
            return await this.request('/pro/username/profile', { method: 'GET' });
        }

        /**
         * Phase 2.5: Resolve a username for login (pre-auth).
         */
        async resolveUsername(username) {
            const baseUrl = (this.baseUrl || global.TASKITATOR_AUTH_CONFIG?.workerUrl || '').trim().replace(/\/+$/, '');
            if (!baseUrl) throw new Error('Worker URL is missing.');
            const res = await fetch(`${baseUrl}/pro/username/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: String(username || '').trim() })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const err = new Error(data.error || 'Failed to resolve username.');
                err.status = res.status;
                err.disallow_google = data.disallow_google;
                throw err;
            }
            return data;
        }
    }

    global.ProClient = ProClient;
    global.TaskitatorPro = global.TaskitatorPro || new ProClient();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { ProClient };
    }
})(typeof window !== 'undefined' ? window : globalThis);
