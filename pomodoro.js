/**
 * Standalone Pomodoro Desk Clock & Timer Module (pomodoro.js)
 * Completely isolated from Taskitator core logic.
 * Self-injects its styles, FAB, modal, synthesized Web Audio chime, and full-screen landscape API.
 */

(() => {
    // =========================================================================
    // 1. Audio Synthesis (Brass Desk Bell via Web Audio API)
    // =========================================================================
    let audioCtx = null;

    function initAudio() {
        if (!audioCtx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioCtx();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    function playBell() {
        try {
            initAudio();
            const now = audioCtx.currentTime;
            // Dual-tone harmonic chime (587.33 Hz D5 + 1174.66 Hz D6 overtone)
            [587.33, 1174.66].forEach((freq, idx) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, now);

                const initialGain = idx === 0 ? 0.35 : 0.18;
                gain.gain.setValueAtTime(initialGain, now);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);

                osc.connect(gain);
                gain.connect(audioCtx.destination);

                osc.start(now);
                osc.stop(now + 2.2);
            });
        } catch (e) {
            console.warn('[Pomodoro] Audio error:', e);
        }
    }

    // =========================================================================
    // 2. CSS Styles Injection
    // =========================================================================
    const styles = `
        /* Pomodoro FAB Stacked Directly Above Core FAB */
        #pomodoroFabBtn {
            position: fixed;
            bottom: calc(24px + 64px);
            right: 24px;
            width: 52px;
            height: 52px;
            border-radius: 50%;
            background: #2563eb;
            color: #ffffff;
            border: none;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
            font-size: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 998;
            transition: transform 0.15s ease, background 0.2s ease, opacity 0.2s ease;
        }
        #pomodoroFabBtn:active {
            transform: scale(0.92);
        }
        #pomodoroFabBtn.hidden {
            display: none !important;
        }

        /* Fullscreen Overlay Container */
        #pomodoroOverlay {
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 42, 0.95);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            z-index: 10000;
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: #f8fafc;
            user-select: none;
            padding: 24px;
            box-sizing: border-box;
        }
        #pomodoroOverlay.active {
            display: flex;
        }

        /* Top Action Bar (Fullscreen & Close) */
        .pomo-header-bar {
            position: absolute;
            top: 20px;
            left: 20px;
            right: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .pomo-header-btn {
            background: rgba(255, 255, 255, 0.1);
            color: #f8fafc;
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 8px;
            padding: 8px 14px;
            font-size: 0.85rem;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: background 0.15s ease;
        }
        .pomo-header-btn:hover {
            background: rgba(255, 255, 255, 0.2);
        }

        /* Setup Panel */
        #pomoSetupPanel {
            max-width: 380px;
            width: 100%;
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 14px;
            padding: 24px;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
        }
        .pomo-field {
            margin-bottom: 16px;
        }
        .pomo-field label {
            display: block;
            font-size: 0.82rem;
            color: #94a3b8;
            margin-bottom: 6px;
            font-weight: 600;
        }
        .pomo-field input {
            width: 100%;
            padding: 10px 12px;
            background: #0f172a;
            border: 1.5px solid #334155;
            border-radius: 8px;
            color: #f8fafc;
            font-size: 1rem;
            box-sizing: border-box;
        }
        .pomo-start-btn {
            width: 100%;
            padding: 12px;
            background: #2563eb;
            color: #ffffff;
            font-weight: 700;
            font-size: 1rem;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            margin-top: 8px;
        }

        /* Active Clock Display */
        #pomoClockPanel {
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            width: 100%;
        }
        .pomo-phase-badge {
            font-size: 1.1rem;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            padding: 6px 16px;
            border-radius: 20px;
            margin-bottom: 14px;
            background: rgba(37, 99, 235, 0.2);
            color: #60a5fa;
            border: 1px solid rgba(96, 165, 250, 0.3);
        }
        .pomo-phase-badge.break {
            background: rgba(16, 185, 129, 0.2);
            color: #34d399;
            border-color: rgba(52, 211, 153, 0.3);
        }
        .pomo-digits {
            font-family: 'SF Mono', Monaco, Consolas, monospace;
            font-size: clamp(5rem, 18vw, 12rem);
            font-weight: 800;
            line-height: 1;
            margin: 10px 0 20px 0;
            color: #f8fafc;
        }
        .pomo-dots {
            display: flex;
            gap: 10px;
            margin-bottom: 30px;
        }
        .pomo-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #334155;
            transition: background 0.2s ease;
        }
        .pomo-dot.filled {
            background: #2563eb;
        }
        .pomo-dot.active {
            background: #60a5fa;
            box-shadow: 0 0 10px #60a5fa;
        }
        .pomo-controls {
            display: flex;
            gap: 14px;
            align-items: center;
        }
        .pomo-ctrl-btn {
            background: #1e293b;
            border: 1.5px solid #334155;
            color: #f8fafc;
            padding: 12px 28px;
            border-radius: 10px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.15s ease;
        }
        .pomo-ctrl-btn.primary {
            background: #2563eb;
            border-color: #2563eb;
        }
    `;

    // =========================================================================
    // 3. State Machine & Countdown Engine (Drift-Proof)
    // =========================================================================
    let config = {
        workMins: 25,
        breakMins: 5,
        totalSessions: 4
    };

    let state = {
        phase: 'work', // 'work' | 'break'
        currentSession: 1,
        isRunning: false,
        remainingMs: 25 * 60 * 1000,
        targetTimestamp: null,
        intervalId: null
    };

    function startTimer() {
        initAudio();
        if (state.isRunning) return;
        state.isRunning = true;
        state.targetTimestamp = Date.now() + state.remainingMs;

        state.intervalId = setInterval(tick, 200);
        updateClockUI();
    }

    function pauseTimer() {
        if (!state.isRunning) return;
        state.isRunning = false;
        clearInterval(state.intervalId);
        state.remainingMs = Math.max(0, state.targetTimestamp - Date.now());
        updateClockUI();
    }

    function resetTimer() {
        pauseTimer();
        state.phase = 'work';
        state.currentSession = 1;
        state.remainingMs = config.workMins * 60 * 1000;
        updateClockUI();
    }

    function tick() {
        const remaining = Math.max(0, state.targetTimestamp - Date.now());
        state.remainingMs = remaining;

        if (remaining <= 0) {
            handlePhaseTransition();
        } else {
            renderDigits(remaining);
        }
    }

    function handlePhaseTransition() {
        playBell();
        clearInterval(state.intervalId);

        if (state.phase === 'work') {
            if (state.currentSession >= config.totalSessions) {
                // All sessions complete
                state.isRunning = false;
                alert('Congratulations! All Pomodoro sessions complete.');
                resetTimer();
                showSetup();
                return;
            }
            state.phase = 'break';
            state.remainingMs = config.breakMins * 60 * 1000;
        } else {
            state.phase = 'work';
            state.currentSession += 1;
            state.remainingMs = config.workMins * 60 * 1000;
        }

        state.targetTimestamp = Date.now() + state.remainingMs;
        state.intervalId = setInterval(tick, 200);
        updateClockUI();
    }

    // =========================================================================
    // 4. UI Rendering & DOM Setup
    // =========================================================================
    let dom = {};

    function injectDOM() {
        // Inject Style
        const styleEl = document.createElement('style');
        styleEl.textContent = styles;
        document.head.appendChild(styleEl);

        // Inject FAB
        const fab = document.createElement('button');
        fab.id = 'pomodoroFabBtn';
        fab.title = 'Open Pomodoro Clock';
        fab.innerHTML = '⏱️';
        document.body.appendChild(fab);

        // Inject Modal Overlay
        const overlay = document.createElement('div');
        overlay.id = 'pomodoroOverlay';
        overlay.innerHTML = `
            <div class="pomo-header-bar">
                <button type="button" class="pomo-header-btn" id="pomoFullscreenToggleBtn">⛶ Full Screen</button>
                <button type="button" class="pomo-header-btn" id="pomoCloseModalBtn">✕ Close</button>
            </div>

            <!-- Setup Screen -->
            <div id="pomoSetupPanel">
                <h3 style="margin: 0 0 16px 0; font-size: 1.15rem; font-weight: 700;">Pomodoro Configuration</h3>
                <div class="pomo-field">
                    <label>Work Duration (Minutes)</label>
                    <input type="number" id="pomoWorkDurationInput" value="25" min="1" max="120">
                </div>
                <div class="pomo-field">
                    <label>Break Duration (Minutes)</label>
                    <input type="number" id="pomoBreakDurationInput" value="5" min="1" max="60">
                </div>
                <div class="pomo-field">
                    <label>Total Sessions</label>
                    <input type="number" id="pomoTotalSessionsInput" value="4" min="1" max="12">
                </div>
                <button type="button" class="pomo-start-btn" id="pomoLaunchSessionBtn">Start Session</button>
            </div>

            <!-- Active Clock Screen -->
            <div id="pomoClockPanel">
                <div class="pomo-phase-badge" id="pomoPhaseBadge">Focus Session</div>
                <div class="pomo-digits" id="pomoCountdownDisplay">25:00</div>
                <div class="pomo-dots" id="pomoSessionsDotContainer"></div>
                <div class="pomo-controls">
                    <button type="button" class="pomo-ctrl-btn primary" id="pomoPlayPauseBtn">Pause</button>
                    <button type="button" class="pomo-ctrl-btn" id="pomoResetBtn">Reset</button>
                    <button type="button" class="pomo-ctrl-btn" id="pomoBackToConfigBtn">Config</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // Cache Elements
        dom = {
            fab,
            overlay,
            setupPanel: document.getElementById('pomoSetupPanel'),
            clockPanel: document.getElementById('pomoClockPanel'),
            workInput: document.getElementById('pomoWorkDurationInput'),
            breakInput: document.getElementById('pomoBreakDurationInput'),
            sessionsInput: document.getElementById('pomoTotalSessionsInput'),
            launchBtn: document.getElementById('pomoLaunchSessionBtn'),
            phaseBadge: document.getElementById('pomoPhaseBadge'),
            digits: document.getElementById('pomoCountdownDisplay'),
            dots: document.getElementById('pomoSessionsDotContainer'),
            playPauseBtn: document.getElementById('pomoPlayPauseBtn'),
            resetBtn: document.getElementById('pomoResetBtn'),
            backBtn: document.getElementById('pomoBackToConfigBtn'),
            fullscreenBtn: document.getElementById('pomoFullscreenToggleBtn'),
            closeBtn: document.getElementById('pomoCloseModalBtn')
        };

        bindEvents();
        checkViewVisibility();
    }

    function renderDigits(ms) {
        const totalSecs = Math.ceil(ms / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        dom.digits.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function updateClockUI() {
        if (state.phase === 'work') {
            dom.phaseBadge.textContent = `Focus Session ${state.currentSession} of ${config.totalSessions}`;
            dom.phaseBadge.className = 'pomo-phase-badge';
        } else {
            dom.phaseBadge.textContent = `Rest & Recharge`;
            dom.phaseBadge.className = 'pomo-phase-badge break';
        }

        renderDigits(state.remainingMs);
        dom.playPauseBtn.textContent = state.isRunning ? 'Pause' : 'Resume';

        // Render Dots
        dom.dots.innerHTML = '';
        for (let i = 1; i <= config.totalSessions; i++) {
            const dot = document.createElement('span');
            dot.className = 'pomo-dot';
            if (i < state.currentSession) dot.classList.add('filled');
            else if (i === state.currentSession) dot.classList.add('active');
            dom.dots.appendChild(dot);
        }
    }

    function showSetup() {
        dom.setupPanel.style.display = 'block';
        dom.clockPanel.style.display = 'none';
    }

    function showClock() {
        dom.setupPanel.style.display = 'none';
        dom.clockPanel.style.display = 'flex';
        updateClockUI();
    }

    // =========================================================================
    // 5. Fullscreen & Orientation Lock API
    // =========================================================================
    async function toggleFullscreen() {
        try {
            if (!document.fullscreenElement) {
                await dom.overlay.requestFullscreen();
                dom.fullscreenBtn.textContent = '✕ Exit Full Screen';
                // Request landscape orientation where supported (Android Chrome / Tablets)
                if (screen.orientation && typeof screen.orientation.lock === 'function') {
                    screen.orientation.lock('landscape').catch(() => {});
                }
            } else {
                await document.exitFullscreen();
                dom.fullscreenBtn.textContent = '⛶ Full Screen';
                if (screen.orientation && typeof screen.orientation.unlock === 'function') {
                    screen.orientation.unlock();
                }
            }
        } catch (e) {
            console.warn('[Pomodoro] Fullscreen error:', e);
        }
    }

    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && dom.fullscreenBtn) {
            dom.fullscreenBtn.textContent = '⛶ Full Screen';
        }
    });

    // =========================================================================
    // 6. View Scoping (#today visibility check)
    // =========================================================================
    function checkViewVisibility() {
        const hash = window.location.hash.replace('#', '').toLowerCase();
        // Today view active on empty hash or #today
        if (hash === '' || hash === 'today') {
            dom.fab.classList.remove('hidden');
        } else {
            dom.fab.classList.add('hidden');
        }
    }

    function bindEvents() {
        window.addEventListener('hashchange', checkViewVisibility);

        dom.fab.addEventListener('click', () => {
            dom.overlay.classList.add('active');
            if (!state.isRunning && state.remainingMs === config.workMins * 60 * 1000) {
                showSetup();
            } else {
                showClock();
            }
        });

        dom.closeBtn.addEventListener('click', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
            dom.overlay.classList.remove('active');
        });

        dom.launchBtn.addEventListener('click', () => {
            const w = parseInt(dom.workInput.value, 10);
            const b = parseInt(dom.breakInput.value, 10);
            const s = parseInt(dom.sessionsInput.value, 10);

            config.workMins = (!isNaN(w) && w > 0) ? w : 25;
            config.breakMins = (!isNaN(b) && b > 0) ? b : 5;
            config.totalSessions = (!isNaN(s) && s > 0) ? s : 4;

            resetTimer();
            showClock();
            startTimer();
        });

        dom.playPauseBtn.addEventListener('click', () => {
            if (state.isRunning) pauseTimer();
            else startTimer();
        });

        dom.resetBtn.addEventListener('click', () => {
            resetTimer();
        });

        dom.backBtn.addEventListener('click', () => {
            pauseTimer();
            showSetup();
        });

        dom.fullscreenBtn.addEventListener('click', toggleFullscreen);
    }

    // Auto-initialize when the DOM finishes loading
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectDOM);
    } else {
        injectDOM();
    }
})();
