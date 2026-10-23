// File: pro/pro-ui.js
// Taskitator Pro Phase 2: UI components for Settings page, BYOK toggle,
// multi-file proof review, and batch proof review.

(function(global) {
    function getClient() {
        return global.TaskitatorPro || (global.ProClient ? new global.ProClient() : null);
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const b64 = reader.result.split(',')[1];
                resolve(b64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // --- Phase 2: Batch Proof Review Modal & Trigger ---

    function openBatchReviewModal(selectedIds = null) {
        if (document.getElementById('proBatchModalRoot')) return;

        let allTasks = [];
        try {
            allTasks = JSON.parse(localStorage.getItem('taskitator_tasks') || '[]');
        } catch {
            allTasks = [];
        }

        const scope = Array.isArray(selectedIds) ? new Set(selectedIds) : null;
        const eligibleTasks = allTasks.filter(t => t.status === 'active' && (t.ai_locked || t.require_ai_proof) && (!scope || scope.has(t.id)));
        const preselect = Boolean(scope && eligibleTasks.length <= 20);

        const modal = document.createElement('div');
        modal.id = 'proBatchModalRoot';
        modal.className = 'pro-modal-backdrop';

        if (!eligibleTasks.length) {
            modal.innerHTML = `
                <div class="pro-modal-box">
                    <div class="pro-modal-header">
                        <h3 style="margin: 0;">⚡ Batch Proof Review</h3>
                        <button type="button" class="icon-btn" id="proBatchCloseBtn">✕</button>
                    </div>
                    <p style="color: #94a3b8; font-size: 0.95rem; margin: 20px 0;">
                        ${scope ? 'None of the selected tasks are active AI-audited tasks. Select an active task with' : 'No active AI-audited tasks found. Create a task with'} <em>Require AI Proof Verification</em> enabled first!
                    </p>
                    <div style="text-align: right;">
                        <button type="button" class="pro-btn" id="proBatchCancelBtn">Close</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            document.getElementById('proBatchCloseBtn').addEventListener('click', () => modal.remove());
            document.getElementById('proBatchCancelBtn').addEventListener('click', () => modal.remove());
            return;
        }

        const taskRowsHtml = eligibleTasks.map(t => `
            <label class="pro-batch-task-row">
                <input type="checkbox" class="pro-batch-task-cb" value="${escapeHtml(t.id)}" ${preselect ? 'checked' : ''} data-title="${escapeHtml(t.title)}" data-criteria="${escapeHtml(t.proof_criteria || '')}" />
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 600; color: #f8fafc; font-size: 0.9rem;">${escapeHtml(t.title)}</div>
                    <div style="font-size: 0.78rem; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        Criteria: ${escapeHtml(t.proof_criteria || 'None specified')}
                    </div>
                </div>
            </label>
        `).join('');

        modal.innerHTML = `
            <div class="pro-modal-box pro-batch-box">
                <div class="pro-modal-header">
                    <h3 style="margin: 0; display: flex; align-items: center; gap: 8px;">
                        <span>⚡</span> Batch Proof Review
                    </h3>
                    <button type="button" class="icon-btn" id="proBatchCloseBtn">✕</button>
                </div>
                <p style="font-size: 0.88rem; color: #94a3b8; margin: 8px 0 16px 0;">
                    ${scope ? 'Only your selected active AI-audited tasks are shown. ' : ''}Select up to 20 tasks and attach up to 5 proof files. Each task is reviewed and charged separately. Reviewing two or more tasks together gives each task a 25% discount. Comparing proof with a reference example doubles that task’s charge. You can check the price before starting.
                </p>

                <div class="pro-batch-section-title">1. Select Target Tasks (<span id="proBatchSelectedCount">0</span> selected)</div>
                <div class="pro-batch-task-list">
                    ${taskRowsHtml}
                </div>

                <div class="pro-batch-section-title" style="margin-top: 16px;">2. Attach Evidence Files (Up to 5 images or PDFs)</div>
                <div class="pro-batch-upload-area">
                    <input type="file" id="proBatchFileInput" multiple accept="image/jpeg,image/png,image/webp,application/pdf" style="display:none;" />
                    <button type="button" class="icon-btn" id="proBatchPickFilesBtn" style="gap: 6px;">
                        📁 <span>Select Evidence Files</span>
                    </button>
                    <div id="proBatchFileList" class="pro-batch-file-chips"></div>
                </div>

                <div id="proBatchResultsArea" style="display: none; margin-top: 20px;"></div>

                <div class="pro-modal-footer">
                    <div id="proBatchFeedback" style="font-size: 0.85rem; color: #f87171;"></div>
                    <div style="display: flex; gap: 10px;">
                        <button type="button" class="icon-btn" id="proBatchCancelBtn">Cancel</button>
                        <button type="button" class="pro-btn" id="proBatchSubmitBtn" disabled>Preview Batch Audit</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const closeBtn = document.getElementById('proBatchCloseBtn');
        const cancelBtn = document.getElementById('proBatchCancelBtn');
        const submitBtn = document.getElementById('proBatchSubmitBtn');
        const pickBtn = document.getElementById('proBatchPickFilesBtn');
        const fileInput = document.getElementById('proBatchFileInput');
        const fileListDiv = document.getElementById('proBatchFileList');
        const countSpan = document.getElementById('proBatchSelectedCount');
        const feedback = document.getElementById('proBatchFeedback');
        const resultsArea = document.getElementById('proBatchResultsArea');

        const close = () => modal.remove();
        closeBtn.onclick = close;
        cancelBtn.onclick = close;

        const selectedTasks = preselect ? eligibleTasks.map(t => ({id:t.id, title:t.title, criteria:t.proof_criteria || ''})) : [];
        let stagedFiles = [];

        modal.querySelectorAll('.pro-batch-task-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                const taskId = cb.value;
                const title = cb.dataset.title;
                const criteria = cb.dataset.criteria;
                if (cb.checked) {
                    if (selectedTasks.length >= 20) {
                        cb.checked = false;
                        feedback.textContent = 'Maximum 20 tasks per batch.';
                        return;
                    }
                    selectedTasks.push({ id: taskId, title, criteria });
                } else {
                    const idx = selectedTasks.findIndex(t => t.id === taskId);
                    if (idx !== -1) selectedTasks.splice(idx, 1);
                }
                countSpan.textContent = selectedTasks.length;
                updateSubmitState();
            });
        });

        countSpan.textContent = selectedTasks.length;
        updateSubmitState();

        pickBtn.onclick = () => fileInput.click();

        fileInput.addEventListener('change', async () => {
            const files = Array.from(fileInput.files);
            if (stagedFiles.length + files.length > 5) {
                feedback.textContent = 'Maximum 5 evidence files permitted.';
                return;
            }

            for (const file of files) {
                const b64 = await fileToBase64(file);
                stagedFiles.push({
                    name: file.name,
                    mimeType: file.type,
                    data: b64
                });
            }

            renderStagedFiles();
            updateSubmitState();
        });

        function renderStagedFiles() {
            fileListDiv.innerHTML = stagedFiles.map((f, i) => `
                <div class="pro-file-chip">
                    <span>${f.mimeType === 'application/pdf' ? '📄' : '🖼️'} ${escapeHtml(f.name)}</span>
                    <button type="button" class="pro-chip-del" data-index="${i}">✕</button>
                </div>
            `).join('');

            fileListDiv.querySelectorAll('.pro-chip-del').forEach(btn => {
                btn.onclick = () => {
                    const idx = Number(btn.dataset.index);
                    stagedFiles.splice(idx, 1);
                    renderStagedFiles();
                    updateSubmitState();
                };
            });
        }

        function updateSubmitState() {
            feedback.textContent = '';
            submitBtn.disabled = selectedTasks.length === 0 || stagedFiles.length === 0;
            if (selectedTasks.length > 0) {
                submitBtn.textContent = `Preview Batch Audit (${selectedTasks.length} tasks)`;
            } else {
                submitBtn.textContent = 'Run Batch Audit';
            }
        }

        submitBtn.onclick = async () => {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Auditing with Claude Haiku 5.5...';
            feedback.textContent = '';

            const client = getClient();
            try {
                const res = await client.batchReview({
                    tasks: await Promise.all(selectedTasks.map(async item => {
                        const task = allTasks.find(t => t.id === item.id);
                        let part = task?.reference_inline_data || global.TaskitatorRecurrenceUI?.state()?.reference_files?.[task?.reference_id];
                        const stored = await global.ExemplarStore?.getExemplar(item.id);
                        if (stored?.inline_data) part = stored.inline_data;
                        part = part?.inline_data || part;
                        if (task?.reference_id && !part) throw new Error('The reference exemplar for "'+item.title+'" is unavailable. Restore it before reviewing.');
                        return {...item,exemplar:part ? {mime_type:part.mime_type,data:part.data} : null};
                    })),
                    files: stagedFiles
                });

                renderBatchResults(res);
            } catch (err) {
                feedback.textContent = err.message || 'Batch audit failed.';
                submitBtn.disabled = false;
                submitBtn.textContent = `Preview Batch Audit (${selectedTasks.length} tasks)`;
            }
        };

        function renderBatchResults(result) {
            submitBtn.style.display = 'none';
            resultsArea.style.display = 'block';

            const tasks = result.tasks || [];
            const eligible = tasks.filter(t => t.status === 'eligible');

            let html = `
                <div class="pro-batch-section-title">3. Audit Results (Job: ${escapeHtml(result.job_id)})</div>
                <div class="pro-batch-results-list">
            `;

            tasks.forEach(t => {
                const isPass = t.status === 'eligible';
                const orig = selectedTasks.find(s => s.id === t.task_id);
                html += `
                    <div class="pro-result-row ${isPass ? 'pass' : 'fail'}">
                        <div style="font-weight: 600;">${isPass ? '✓ ELIGIBLE' : '✕ ' + t.status.toUpperCase()}: ${escapeHtml(orig?.title || t.task_id)}</div>
                        <div style="font-size: 0.8rem; margin-top: 4px; color: #cbd5e1;">${escapeHtml(t.reason || t.critique || '')}</div>
                    </div>
                `;
            });

            html += `</div>`;

            if (eligible.length > 0) {
                html += `
                    <div style="margin-top: 16px; text-align: right;">
                        <button type="button" class="pro-btn" id="proConfirmBatchBtn">
                            Confirm Completion for ${eligible.length} Eligible Task(s)
                        </button>
                    </div>
                `;
            }

            resultsArea.innerHTML = html;

            const confirmBtn = document.getElementById('proConfirmBatchBtn');
            if (confirmBtn) {
                confirmBtn.onclick = async () => {
                    confirmBtn.disabled = true;
                    confirmBtn.textContent = 'Confirming...';
                    try {
                        const client = getClient();
                        await client.batchConfirm({
                            jobId: result.job_id,
                            taskIds: eligible.map(e => e.task_id)
                        });

                        // batchConfirm downloads the server-authorized task snapshot.
                        modal.remove();
                        if (typeof window.TaskitatorApp?.refresh === 'function') window.TaskitatorApp.refresh();
                        else location.reload();
                    } catch (e) {
                        feedback.textContent = e.message || 'Failed to confirm batch completion.';
                        confirmBtn.disabled = false;
                    }
                };
            }
        }
    }

    // --- Settings Tab: Pro Dashboard & BYOK Toggle ---

    function renderProSection(containerId = 'pro-settings-container') {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = `
            <div class="pro-card" id="pro-card-root">
                <div class="pro-header">
                    <div class="pro-title-wrap">
                        <h3 style="margin: 0; font-size: 16px; font-weight: 600;">⭐ Taskitator Pro</h3>
                        <span class="pro-badge free" id="pro-status-badge">Checking...</span>
                    </div>
                    <span id="pro-expiry-label" style="font-size: 12px; color: #94a3b8;"></span>
                </div>

                <div id="pro-quota-container" style="display: none;">
                    <div class="pro-quota-grid">
                        <div class="pro-quota-card">
                            <div class="pro-quota-label">Daily Hosted AI Credits</div>
                            <div class="pro-quota-val"><span id="pro-daily-remaining">--</span> / <span id="pro-daily-limit">45</span></div>
                            <div class="pro-quota-sub">Resets at midnight Asia/Riyadh</div>
                            <div class="pro-progress-bar">
                                <div class="pro-progress-fill" id="pro-daily-fill" style="width: 0%;"></div>
                            </div>
                        </div>
                        <div class="pro-quota-card">
                            <div class="pro-quota-label">Monthly Hosted AI Credits</div>
                            <div class="pro-quota-val"><span id="pro-monthly-remaining">--</span> / <span id="pro-monthly-limit">1000</span></div>
                            <div class="pro-quota-sub">Resets on the first, Asia/Riyadh</div>
                            <div class="pro-progress-bar">
                                <div class="pro-progress-fill" id="pro-monthly-fill" style="width: 0%;"></div>
                            </div>
                        </div>
                    </div>

                    <section class="pro-credit-help" aria-labelledby="pro-credit-help-title">
                        <h4 id="pro-credit-help-title">How credits work</h4>
                        <ul>
                            <li><strong>Larger files and longer reviews use more credits.</strong> Each task has its own charge.</li>
                            <li>Comparing your proof with a <strong>reference example doubles that task’s charge</strong>.</li>
                            <li>Reviewing <strong>two or more tasks together gives each task 25% off</strong>.</li>
                            <li>Before starting, you’ll see the <strong>estimated charge and maximum credits temporarily held</strong>.</li>
                            <li>After the review, you pay for actual usage. <strong>Unused held credits return to your balance.</strong> Your charge will not exceed the maximum shown.</li>
                        </ul>
                        <p>You pay for a completed review even if the proof is not approved. Cancelling at the price preview starts no paid review.</p>
                        <p>Large uploads may need splitting into smaller files. Daily and monthly credit limits, plus a separate monthly hosted allowance, apply.</p>
                    </section>
                    <div class="pro-byok-box">
                        <label class="pro-switch-wrap">
                            <input type="checkbox" id="proByokToggle" />
                            <span class="pro-switch-label"><strong>Personal BYOK Mode:</strong> Use your own saved API key for proofs. (Your hosted credit limits remain active without resetting).</span>
                        </label>
                    </div>
                </div>

                <div class="pro-form" id="pro-activation-form">
                    <label style="font-size: 13px; font-weight: 500; color: #cbd5e1;">Activate Pro with Keyo License Key</label>
                    <div class="pro-input-group">
                        <input type="text" class="pro-input" id="pro-license-input" placeholder="e.g. XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocorrect="off" spellcheck="false" />
                        <button class="pro-btn" id="pro-activate-btn">Activate Pro</button>
                    </div>
                    <div class="pro-msg" id="pro-form-msg"></div>
                </div>

                <div class="pro-info-note">
                    <strong>Hosted Personal AI:</strong> Pro accounts receive automated single, multi-file, and batch proof audits powered by personal <strong>Claude Haiku 5.5</strong> without needing a personal API key.
                </div>
            </div>
        `;

        bindProEvents();
        refreshProStatus();
    }

    function bindProEvents() {
        const btn = document.getElementById('pro-activate-btn');
        const input = document.getElementById('pro-license-input');
        const byokToggle = document.getElementById('proByokToggle');

        if (btn && input) {
            btn.addEventListener('click', async () => {
                const key = input.value.trim();
                if (!key) {
                    showMsg('Please enter your license key.', 'error');
                    return;
                }

                const client = getClient();
                btn.disabled = true;
                btn.textContent = 'Activating...';
                showMsg('', '');

                try {
                    const res = await client.activate(key);
                    showMsg(res.message || 'Taskitator Pro successfully activated!', 'success');
                    input.value = '';
                    await refreshProStatus();
                } catch (err) {
                    showMsg(err.message || 'Failed to activate license key.', 'error');
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Activate Pro';
                }
            });
        }

        if (byokToggle) {
            byokToggle.addEventListener('change', async () => {
                const client = getClient();
                try {
                    await client.setUseByok(byokToggle.checked);
                    showMsg(byokToggle.checked ? 'BYOK mode enabled. Limits remain active.' : 'Switched to hosted Claude Haiku 5.5 mode.', 'success');
                } catch (err) {
                    showMsg(err.message || 'Failed to update BYOK mode.', 'error');
                    byokToggle.checked = !byokToggle.checked;
                }
            });
        }
    }

    function showMsg(text, type) {
        const msg = document.getElementById('pro-form-msg');
        if (!msg) return;
        if (!text) {
            msg.className = 'pro-msg';
            msg.textContent = '';
            msg.style.display = 'none';
            return;
        }
        msg.className = `pro-msg ${type}`;
        msg.textContent = text;
        msg.style.display = 'block';
    }

    async function refreshProStatus() {
        const client = getClient();
        if (!client) return;

        const badge = document.getElementById('pro-status-badge');
        const expiry = document.getElementById('pro-expiry-label');
        const quotaBox = document.getElementById('pro-quota-container');
        const byokToggle = document.getElementById('proByokToggle');

        try {
            const data = await client.getStatus();
            if (data.isPro) {
                if (badge) {
                    badge.className = 'pro-badge active';
                    badge.textContent = 'PRO ACTIVE';
                }
                if (expiry) expiry.textContent = data.expires_at === null ? 'Lifetime license' :
                    `Valid through ${new Date(data.expires_at).toLocaleDateString()}`;
                if (quotaBox) quotaBox.style.display = 'block';

                if (byokToggle) byokToggle.checked = Boolean(data.use_byok);

                const dailyRem = document.getElementById('pro-daily-remaining');
                const dailyLim = document.getElementById('pro-daily-limit');
                const dailyFill = document.getElementById('pro-daily-fill');
                const monthlyRem = document.getElementById('pro-monthly-remaining');
                const monthlyLim = document.getElementById('pro-monthly-limit');
                const monthlyFill = document.getElementById('pro-monthly-fill');

                if (data.credits) {
                    if (dailyRem) dailyRem.textContent = data.credits.daily_remaining;
                    if (dailyLim) dailyLim.textContent = data.credits.daily_limit;
                    if (dailyFill && data.credits.daily_limit > 0) {
                        const pct = Math.round((data.credits.daily_remaining / data.credits.daily_limit) * 100);
                        dailyFill.style.width = `${pct}%`;
                    }

                    if (monthlyRem) monthlyRem.textContent = data.credits.monthly_remaining;
                    if (monthlyLim) monthlyLim.textContent = data.credits.monthly_limit;
                    if (monthlyFill && data.credits.monthly_limit > 0) {
                        const pct = Math.round((data.credits.monthly_remaining / data.credits.monthly_limit) * 100);
                        monthlyFill.style.width = `${pct}%`;
                    }
                }
            } else {
                if (badge) {
                    badge.className = 'pro-badge free';
                    badge.textContent = 'FREE TIER';
                }
                if (expiry) expiry.textContent = data.status === 'verification_required' ?
                    'Please enter your Keyo license key again to verify this account.' :
                    ['revoked','invalid','expired'].includes(data.status) ? 'License verification failed. Check your license in Keyo, then reactivate.' : '';
                if (quotaBox) quotaBox.style.display = 'none';
            }
        } catch (err) {
            if (badge) {
                badge.className = 'pro-badge free';
                badge.textContent = 'VERIFICATION UNAVAILABLE';
            }
            if (expiry) expiry.textContent = err.message || 'Unable to check your license. Please refresh Settings and retry.';
            if (quotaBox) quotaBox.style.display = 'none';
        }
    }

    function autoInit() {
        if (document.getElementById('pro-settings-container')) {
            renderProSection('pro-settings-container');
        }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', autoInit);
        } else {
            autoInit();
        }
        global.addEventListener('taskitator-auth-ready', autoInit);
    }

    global.renderProSection = renderProSection;
    global.refreshProStatus = refreshProStatus;
    global.openBatchReviewModal = openBatchReviewModal;
})(typeof window !== 'undefined' ? window : globalThis);
