// File: pro/pro-ui.js
// Taskitator Pro Phase 1: UI components for Settings page and task reviews

(function(global) {
    function getClient() {
        return global.TaskitatorPro || (global.ProClient ? new global.ProClient() : null);
    }

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
                            <div class="pro-quota-val"><span id="pro-daily-remaining">--</span> / <span id="pro-daily-limit">--</span></div>
                            <div class="pro-quota-sub">Resets at midnight Asia/Riyadh</div>
                            <div class="pro-progress-bar">
                                <div class="pro-progress-fill" id="pro-daily-fill" style="width: 0%;"></div>
                            </div>
                        </div>
                        <div class="pro-quota-card">
                            <div class="pro-quota-label">Monthly Hosted AI Credits</div>
                            <div class="pro-quota-val"><span id="pro-monthly-remaining">--</span> / <span id="pro-monthly-limit">--</span></div>
                            <div class="pro-quota-sub">Monthly reset window</div>
                            <div class="pro-progress-bar">
                                <div class="pro-progress-fill" id="pro-monthly-fill" style="width: 0%;"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="pro-form" id="pro-activation-form">
                    <label style="font-size: 13px; font-weight: 500; color: #cbd5e1;">Activate Pro with Keyo License Key</label>
                    <div class="pro-input-group">
                        <input type="text" class="pro-input" id="pro-license-input" placeholder="e.g. KEYO-PRO-XXXX-XXXX" autocomplete="off" autocorrect="off" spellcheck="false" />
                        <button class="pro-btn" id="pro-activate-btn">Activate Pro</button>
                    </div>
                    <div class="pro-msg" id="pro-form-msg"></div>
                </div>

                <div class="pro-info-note">
                    <strong>Hosted Personal AI:</strong> Pro accounts receive automated proof audits powered by hosted Gemini Flash models without needing a personal API key. (Lite and Flash families only; Pro models strictly excluded).
                </div>
            </div>
        `;

        bindProEvents();
        refreshProStatus();
    }

    function bindProEvents() {
        const btn = document.getElementById('pro-activate-btn');
        const input = document.getElementById('pro-license-input');

        if (!btn || !input) return;

        btn.addEventListener('click', async () => {
            const key = input.value.trim();
            if (!key) {
                showMsg('Please enter your license key.', 'error');
                return;
            }

            const client = getClient();
            if (!client) {
                showMsg('Pro client initialization error.', 'error');
                return;
            }

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

        try {
            const data = await client.getStatus();
            if (data.isPro) {
                if (badge) {
                    badge.className = 'pro-badge active';
                    badge.textContent = 'PRO ACTIVE';
                }
                if (expiry && data.expires_at) {
                    const expDate = new Date(data.expires_at).toLocaleDateString();
                    expiry.textContent = `Valid through ${expDate}`;
                }
                if (quotaBox) quotaBox.style.display = 'block';

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
                if (expiry) expiry.textContent = '';
                if (quotaBox) quotaBox.style.display = 'none';
            }
        } catch (e) {
            if (badge) {
                badge.className = 'pro-badge free';
                badge.textContent = 'FREE / UNLINKED';
            }
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
})(typeof window !== 'undefined' ? window : globalThis);
