// Phone Blocker Setup Guide view (moved out of components.html in Phase 3.0; runs inside the index.html shell).
// <<< MODULE_START: blocker-guide.html >>>
(() => {
    // --- Phase 1 Sequential Engine Config ---
    const P1_TOTAL_SUBS = 6;
    const P1_STORAGE_KEY = 'taskitator_guide_phase1_progress';

    const P1_STRUCTURE = {
        major: {
            1: [1, 2, 3],
            2: [4, 5, 6]
        },
        minor: {
            1: [1],
            2: [2],
            3: [3],
            4: [4],
            5: [5],
            6: [6]
        }
    };

    function getP1SavedState() {
        try {
            return JSON.parse(localStorage.getItem(P1_STORAGE_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    function setP1SavedState(state) {
        localStorage.setItem(P1_STORAGE_KEY, JSON.stringify(state));
    }

    function toggleP1Major(majorId) {
        const el = document.getElementById(`p1-major-${majorId}`);
        if (el) el.classList.toggle('open');
    }

    function toggleP1Minor(minorId) {
        const el = document.getElementById(`p1-minor-${minorId}`);
        if (el) el.classList.toggle('open');
    }

    function openP1MinorAndMajor(minorId) {
        const minorEl = document.getElementById(`p1-minor-${minorId}`);
        if (minorEl) minorEl.classList.add('open');
        for (const [majorId, subs] of Object.entries(P1_STRUCTURE.major)) {
            const minorSubs = P1_STRUCTURE.minor[majorId];
            if (subs.includes(Number(minorId) === 1 || Number(minorId) === 2 || Number(minorId) === 3 ? 1 : 4)) {
                // simple mapping for major check
            }
        }
        // Auto open corresponding major block
        if (minorId <= 3) {
            const maj = document.getElementById('p1-major-1');
            if (maj) maj.classList.add('open');
        } else {
            const maj = document.getElementById('p1-major-2');
            if (maj) maj.classList.add('open');
        }
    }

    function toggleP1Sub(subId) {
        const cb = document.getElementById(subId);
        const item = document.getElementById(`item-${subId}`);
        const state = getP1SavedState();

        if (cb.checked) {
            state[subId] = true;
            item.classList.add('checked');
        } else {
            delete state[subId];
            item.classList.remove('checked');
        }

        setP1SavedState(state);
        evaluateP1Rollups(state, true);
    }

    function evaluateP1Rollups(state, shouldAutoAdvance = false) {
        let completedSubs = 0;
        for (let i = 1; i <= P1_TOTAL_SUBS; i++) {
            if (state[`p1-sub-${i}`]) completedSubs++;
        }

        const pct = Math.round((completedSubs / P1_TOTAL_SUBS) * 100);
        document.getElementById('p1-progress-fill').style.width = `${pct}%`;
        document.getElementById('p1-step-count').innerText = `${completedSubs} / ${P1_TOTAL_SUBS}`;
        document.getElementById('p1-percent-text').innerText = `${pct}%`;

        let firstIncompleteMinor = null;

        // Roll up Minor Steps
        for (const [minorId, subs] of Object.entries(P1_STRUCTURE.minor)) {
            const done = subs.filter(s => state[`p1-sub-${s}`]).length;
            const statusEl = document.getElementById(`p1-status-minor-${minorId}`);
            if (statusEl) {
                if (done === subs.length) {
                    statusEl.innerText = `✓ Done`;
                    statusEl.classList.add('done');
                } else {
                    statusEl.innerText = `${done}/${subs.length}`;
                    statusEl.classList.remove('done');
                    if (!firstIncompleteMinor) firstIncompleteMinor = minorId;
                }
            }
        }

        // Roll up Major Steps
        for (const [majorId, subs] of Object.entries(P1_STRUCTURE.major)) {
            const done = subs.filter(s => state[`p1-sub-${s}`]).length;
            const statusEl = document.getElementById(`p1-status-major-${majorId}`);
            if (statusEl) {
                if (done === subs.length) {
                    statusEl.innerText = `✓ Completed`;
                    statusEl.classList.add('done');
                } else {
                    statusEl.innerText = `${done}/${subs.length}`;
                    statusEl.classList.remove('done');
                }
            }
        }

        if (shouldAutoAdvance && firstIncompleteMinor) {
            openP1MinorAndMajor(firstIncompleteMinor);
        }
    }

    function resetPhase1Progress() {
        if (!confirm("Reset all checked sub-steps in Phase 1?")) return;
        localStorage.removeItem(P1_STORAGE_KEY);
        for (let i = 1; i <= P1_TOTAL_SUBS; i++) {
            const cb = document.getElementById(`p1-sub-${i}`);
            const item = document.getElementById(`p1-item-sub-${i}`);
            if (cb) cb.checked = false;
            if (item) item.classList.remove('checked');
        }
        evaluateP1Rollups({});
        openP1MinorAndMajor(1);
    }

    // --- Phase 2 Sequential Engine Config ---
    const TOTAL_SUBS = 26;
    const STORAGE_KEY = 'taskitator_guide_phase2_progress';

    const STRUCTURE = {
        major: {
            1: [1, 2, 3],
            2: [4, 5, 6],
            3: [7, 8, 9, 10],
            4: [11, 12, 13, 14, 15],
            5: [16, 17, 18, 19, 20],
            6: [21, 22, 23, 24, 25, 26]
        },
        minor: {
            1: [1],
            2: [2, 3],
            3: [4],
            4: [5, 6],
            5: [7],
            6: [8, 9, 10],
            7: [11],
            8: [12, 13],
            9: [14, 15],
            10: [16],
            11: [17],
            12: [18],
            13: [19, 20],
            14: [21],
            15: [22],
            16: [23, 24],
            17: [25, 26]
        }
    };

    function getSavedState() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    function setSavedState(state) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function toggleMajor(majorId) {
        const el = document.getElementById(`major-${majorId}`);
        if (el) el.classList.toggle('open');
    }

    function toggleMinor(minorId) {
        const el = document.getElementById(`minor-${minorId}`);
        if (el) el.classList.toggle('open');
    }

    function openMinorAndMajor(minorId) {
        const minorEl = document.getElementById(`minor-${minorId}`);
        if (minorEl) minorEl.classList.add('open');
        for (const [majorId, subs] of Object.entries(STRUCTURE.major)) {
            const minorSubs = STRUCTURE.minor[majorId];
            if (minorSubs && subs.includes(minorSubs[0])) {
                const majorEl = document.getElementById(`major-${majorId}`);
                if (majorEl) majorEl.classList.add('open');
            }
        }
    }

    function toggleSub(subId) {
        const cb = document.getElementById(subId);
        const item = document.getElementById(`item-${subId}`);
        const state = getSavedState();

        if (cb.checked) {
            state[subId] = true;
            item.classList.add('checked');
        } else {
            delete state[subId];
            item.classList.remove('checked');
        }

        setSavedState(state);
        evaluateRollups(state, true);
    }

    function evaluateRollups(state, shouldAutoAdvance = false) {
        let completedSubs = 0;
        for (let i = 1; i <= TOTAL_SUBS; i++) {
            if (state[`sub-${i}`]) completedSubs++;
        }

        const pct = Math.round((completedSubs / TOTAL_SUBS) * 100);
        document.getElementById('p2-progress-fill').style.width = `${pct}%`;
        document.getElementById('p2-step-count').innerText = `${completedSubs} / ${TOTAL_SUBS}`;
        document.getElementById('p2-percent-text').innerText = `${pct}%`;

        let firstIncompleteMinor = null;

        // Roll up Minor Steps
        for (const [minorId, subs] of Object.entries(STRUCTURE.minor)) {
            const done = subs.filter(s => state[`sub-${s}`]).length;
            const statusEl = document.getElementById(`status-minor-${minorId}`);
            if (statusEl) {
                if (done === subs.length) {
                    statusEl.innerText = `✓ Done`;
                    statusEl.classList.add('done');
                } else {
                    statusEl.innerText = `${done}/${subs.length}`;
                    statusEl.classList.remove('done');
                    if (!firstIncompleteMinor) firstIncompleteMinor = minorId;
                }
            }
        }

        // Roll up Major Steps
        for (const [majorId, subs] of Object.entries(STRUCTURE.major)) {
            const done = subs.filter(s => state[`sub-${s}`]).length;
            const statusEl = document.getElementById(`status-major-${majorId}`);
            if (statusEl) {
                if (done === subs.length) {
                    statusEl.innerText = `✓ Completed`;
                    statusEl.classList.add('done');
                } else {
                    statusEl.innerText = `${done}/${subs.length}`;
                    statusEl.classList.remove('done');
                }
            }
        }

        if (shouldAutoAdvance && firstIncompleteMinor) {
            openMinorAndMajor(firstIncompleteMinor);
        }
    }

    function resetPhase2Progress() {
        if (!confirm("Reset all checked sub-steps in Phase 2?")) return;
        localStorage.removeItem(STORAGE_KEY);
        for (let i = 1; i <= TOTAL_SUBS; i++) {
            const cb = document.getElementById(`sub-${i}`);
            const item = document.getElementById(`item-${subId(i)}`);
            if (cb) cb.checked = false;
            if (item) item.classList.remove('checked');
        }
        evaluateRollups({});
        openMinorAndMajor(1);
    }

    function subId(i) { return `sub-${i}`; }

    window.addEventListener('taskitator-auth-ready', () => {
        // Init Phase 1
        const p1State = getP1SavedState();
        for (let i = 1; i <= P1_TOTAL_SUBS; i++) {
            const cb = document.getElementById(`p1-sub-${i}`);
            const item = document.getElementById(`p1-item-sub-${i}`);
            if (cb && p1State[`p1-sub-${i}`]) {
                cb.checked = true;
                if (item) item.classList.add('checked');
            }
        }
        evaluateP1Rollups(p1State, false);
        openP1MinorAndMajor(1);

        // Init Phase 2
        const state = getSavedState();
        for (let i = 1; i <= TOTAL_SUBS; i++) {
            const cb = document.getElementById(`sub-${i}`);
            const item = document.getElementById(`item-sub-${i}`);
            if (cb && state[`sub-${i}`]) {
                cb.checked = true;
                if (item) item.classList.add('checked');
            }
        }
        evaluateRollups(state, false);

        let opened = false;
        for (const [minorId, subs] of Object.entries(STRUCTURE.minor)) {
            const done = subs.filter(s => state[`sub-${s}`]).length;
            if (done < subs.length) {
                openMinorAndMajor(minorId);
                opened = true;
                break;
            }
        }
        if (!opened) openMinorAndMajor(1);
    });
document.querySelector('#componentView-blocker-guide [data-static-action-0]')?.addEventListener('click', function(event){resetPhase1Progress()});
document.querySelector('#componentView-blocker-guide [data-static-action-1]')?.addEventListener('click', function(event){toggleP1Major(1)});
document.querySelector('#componentView-blocker-guide [data-static-action-2]')?.addEventListener('click', function(event){toggleP1Minor(1)});
document.querySelector('#componentView-blocker-guide [data-static-action-3]')?.addEventListener('change', function(event){toggleP1Sub('p1-sub-1')});
document.querySelector('#componentView-blocker-guide [data-static-action-4]')?.addEventListener('click', function(event){toggleP1Minor(2)});
document.querySelector('#componentView-blocker-guide [data-static-action-5]')?.addEventListener('change', function(event){toggleP1Sub('p1-sub-2')});
document.querySelector('#componentView-blocker-guide [data-static-action-6]')?.addEventListener('click', function(event){toggleP1Minor(3)});
document.querySelector('#componentView-blocker-guide [data-static-action-7]')?.addEventListener('change', function(event){toggleP1Sub('p1-sub-3')});
document.querySelector('#componentView-blocker-guide [data-static-action-8]')?.addEventListener('click', function(event){toggleP1Major(2)});
document.querySelector('#componentView-blocker-guide [data-static-action-9]')?.addEventListener('click', function(event){toggleP1Minor(4)});
document.querySelector('#componentView-blocker-guide [data-static-action-10]')?.addEventListener('change', function(event){toggleP1Sub('p1-sub-4')});
document.querySelector('#componentView-blocker-guide [data-static-action-11]')?.addEventListener('click', function(event){toggleP1Minor(5)});
document.querySelector('#componentView-blocker-guide [data-static-action-12]')?.addEventListener('change', function(event){toggleP1Sub('p1-sub-5')});
document.querySelector('#componentView-blocker-guide [data-static-action-13]')?.addEventListener('click', function(event){toggleP1Minor(6)});
document.querySelector('#componentView-blocker-guide [data-static-action-14]')?.addEventListener('change', function(event){toggleP1Sub('p1-sub-6')});
document.querySelector('#componentView-blocker-guide [data-static-action-15]')?.addEventListener('click', function(event){resetPhase2Progress()});
document.querySelector('#componentView-blocker-guide [data-static-action-16]')?.addEventListener('click', function(event){toggleMajor(1)});
document.querySelector('#componentView-blocker-guide [data-static-action-17]')?.addEventListener('click', function(event){toggleMinor(1)});
document.querySelector('#componentView-blocker-guide [data-static-action-18]')?.addEventListener('change', function(event){toggleSub('sub-1')});
document.querySelector('#componentView-blocker-guide [data-static-action-19]')?.addEventListener('click', function(event){toggleMinor(2)});
document.querySelector('#componentView-blocker-guide [data-static-action-20]')?.addEventListener('change', function(event){toggleSub('sub-2')});
document.querySelector('#componentView-blocker-guide [data-static-action-21]')?.addEventListener('change', function(event){toggleSub('sub-3')});
document.querySelector('#componentView-blocker-guide [data-static-action-22]')?.addEventListener('click', function(event){toggleMajor(2)});
document.querySelector('#componentView-blocker-guide [data-static-action-23]')?.addEventListener('click', function(event){toggleMinor(3)});
document.querySelector('#componentView-blocker-guide [data-static-action-24]')?.addEventListener('change', function(event){toggleSub('sub-4')});
document.querySelector('#componentView-blocker-guide [data-static-action-25]')?.addEventListener('click', function(event){toggleMinor(4)});
document.querySelector('#componentView-blocker-guide [data-static-action-26]')?.addEventListener('change', function(event){toggleSub('sub-5')});
document.querySelector('#componentView-blocker-guide [data-static-action-27]')?.addEventListener('change', function(event){toggleSub('sub-6')});
document.querySelector('#componentView-blocker-guide [data-static-action-28]')?.addEventListener('click', function(event){toggleMajor(3)});
document.querySelector('#componentView-blocker-guide [data-static-action-29]')?.addEventListener('click', function(event){toggleMinor(5)});
document.querySelector('#componentView-blocker-guide [data-static-action-30]')?.addEventListener('change', function(event){toggleSub('sub-7')});
document.querySelector('#componentView-blocker-guide [data-static-action-31]')?.addEventListener('click', function(event){toggleMinor(6)});
document.querySelector('#componentView-blocker-guide [data-static-action-32]')?.addEventListener('change', function(event){toggleSub('sub-8')});
document.querySelector('#componentView-blocker-guide [data-static-action-33]')?.addEventListener('change', function(event){toggleSub('sub-9')});
document.querySelector('#componentView-blocker-guide [data-static-action-34]')?.addEventListener('change', function(event){toggleSub('sub-10')});
document.querySelector('#componentView-blocker-guide [data-static-action-35]')?.addEventListener('click', function(event){toggleMajor(4)});
document.querySelector('#componentView-blocker-guide [data-static-action-36]')?.addEventListener('click', function(event){toggleMinor(7)});
document.querySelector('#componentView-blocker-guide [data-static-action-37]')?.addEventListener('change', function(event){toggleSub('sub-11')});
document.querySelector('#componentView-blocker-guide [data-static-action-38]')?.addEventListener('click', function(event){toggleMinor(8)});
document.querySelector('#componentView-blocker-guide [data-static-action-39]')?.addEventListener('change', function(event){toggleSub('sub-12')});
document.querySelector('#componentView-blocker-guide [data-static-action-40]')?.addEventListener('change', function(event){toggleSub('sub-13')});
document.querySelector('#componentView-blocker-guide [data-static-action-41]')?.addEventListener('click', function(event){toggleMinor(9)});
document.querySelector('#componentView-blocker-guide [data-static-action-42]')?.addEventListener('change', function(event){toggleSub('sub-14')});
document.querySelector('#componentView-blocker-guide [data-static-action-43]')?.addEventListener('change', function(event){toggleSub('sub-15')});
document.querySelector('#componentView-blocker-guide [data-static-action-44]')?.addEventListener('click', function(event){toggleMajor(5)});
document.querySelector('#componentView-blocker-guide [data-static-action-45]')?.addEventListener('click', function(event){toggleMinor(10)});
document.querySelector('#componentView-blocker-guide [data-static-action-46]')?.addEventListener('change', function(event){toggleSub('sub-16')});
document.querySelector('#componentView-blocker-guide [data-static-action-47]')?.addEventListener('click', function(event){toggleMinor(11)});
document.querySelector('#componentView-blocker-guide [data-static-action-48]')?.addEventListener('change', function(event){toggleSub('sub-17')});
document.querySelector('#componentView-blocker-guide [data-static-action-49]')?.addEventListener('click', function(event){toggleMinor(12)});
document.querySelector('#componentView-blocker-guide [data-static-action-50]')?.addEventListener('change', function(event){toggleSub('sub-18')});
document.querySelector('#componentView-blocker-guide [data-static-action-51]')?.addEventListener('click', function(event){toggleMinor(13)});
document.querySelector('#componentView-blocker-guide [data-static-action-52]')?.addEventListener('change', function(event){toggleSub('sub-19')});
document.querySelector('#componentView-blocker-guide [data-static-action-53]')?.addEventListener('change', function(event){toggleSub('sub-20')});
document.querySelector('#componentView-blocker-guide [data-static-action-54]')?.addEventListener('click', function(event){toggleMajor(6)});
document.querySelector('#componentView-blocker-guide [data-static-action-55]')?.addEventListener('click', function(event){toggleMinor(14)});
document.querySelector('#componentView-blocker-guide [data-static-action-56]')?.addEventListener('change', function(event){toggleSub('sub-21')});
document.querySelector('#componentView-blocker-guide [data-static-action-57]')?.addEventListener('click', function(event){toggleMinor(15)});
document.querySelector('#componentView-blocker-guide [data-static-action-58]')?.addEventListener('change', function(event){toggleSub('sub-22')});
document.querySelector('#componentView-blocker-guide [data-static-action-59]')?.addEventListener('click', function(event){toggleMinor(16)});
document.querySelector('#componentView-blocker-guide [data-static-action-60]')?.addEventListener('change', function(event){toggleSub('sub-23')});
document.querySelector('#componentView-blocker-guide [data-static-action-61]')?.addEventListener('change', function(event){toggleSub('sub-24')});
document.querySelector('#componentView-blocker-guide [data-static-action-62]')?.addEventListener('click', function(event){toggleMinor(17)});
document.querySelector('#componentView-blocker-guide [data-static-action-63]')?.addEventListener('change', function(event){toggleSub('sub-25')});
document.querySelector('#componentView-blocker-guide [data-static-action-64]')?.addEventListener('change', function(event){toggleSub('sub-26')});
})();
// <<< MODULE_END: blocker-guide.html >>>
    
