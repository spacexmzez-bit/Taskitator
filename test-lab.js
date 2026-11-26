/* Test lab (Phase 3.5, Pro). A workbench for proof criteria: write criteria (and a second version B to compare), attach test proofs,
   then Validate (score out of 10) and Test (a dry-run audit, same prompt and billing as a real one, nothing is locked or completed).
   Tests are kept on this device only, in IndexedDB. Phase 6.3: one card per version (A blue, B purple) with Validate, Test and both results; shared inputs in one block; a sticky test switcher; colour-coded scores and verdicts. A criteria that scored 8/10 or more can be confirmed into Saved criteria (marked "Lab").
   The pure helpers below are shared with the tests; the view only exists in the browser. */
(function (root) {
    'use strict';
    const LIMITS = Object.freeze({ files: 5, history: 30, bytes: 25 * 1024 * 1024, pass: 8, title: 40 });
    const blank = () => ({ criteria: '', validate: null, test: null });
    // {num} in the criteria is replaced with the test's unit number before anything is sent to the AI.
    const unitOf = n => { const v = Math.floor(Number(n)); return v >= 1 && v <= 9999 ? v : 1; };
    const fillNum = (text, n) => String(text).replace(/\{num\}/g, String(unitOf(n)));
    // Title variables work as in normal tasks: {name==value} in the title fills {name} in the criteria.
    // The unit number only supplies {num} when the title does not define it. Returns { title, text } or { missing: [...] }.
    const prepare = (rec, raw, smart) => {
        if (!smart) return { title: rec.taskTitle, text: fillNum(raw, rec.unit) };
        const { cleanTitle, varMap } = smart.parseTitle(rec.taskTitle);
        const { resolvedText, hasUnresolved, unresolvedKeys } = smart.resolveCriteria(raw, { num: String(unitOf(rec.unit)), ...varMap });
        return hasUnresolved ? { missing: unresolvedKeys.length ? unresolvedKeys : ['unknown'] } : { title: cleanTitle, text: resolvedText };
    };
    const newTest = (now = Date.now(), rand = Math.random) => ({ id: 'lab_' + now.toString(36) + '_' + rand().toString(36).slice(2, 6), created: now, updated: now, taskTitle: '', context: '', unit: 1, a: blank(), b: null, files: [], exemplar: null, credits: 0, calls: 0 });
    const sizeOf = r => (r.files || []).reduce((n, f) => n + (f.blob && f.blob.size || 0), 0) + (r.exemplar && r.exemplar.blob ? r.exemplar.blob.size : 0);
    // Oldest tests go first when there are more than 30 or more than 25 MB of stored proofs. The test being edited is never dropped.
    function toDrop(records, keepId, limits = LIMITS) {
        const sorted = [...records].sort((x, y) => (x.updated || 0) - (y.updated || 0));
        let total = sorted.reduce((n, r) => n + sizeOf(r), 0), count = sorted.length;
        const drop = [];
        for (const r of sorted) {
            if (count <= limits.history && total <= limits.bytes) break;
            if (r.id === keepId) continue;
            drop.push(r.id); count--; total -= sizeOf(r);
        }
        return drop;
    }
    // Confirm needs a Validate score of 8/10 or more for exactly the text that is in the box now.
    const canConfirm = side => Boolean(side && side.validate && Number(side.validate.score) >= LIMITS.pass && side.validate.criteria === String(side.criteria || '').trim());
    const stale = (side, result) => Boolean(result && result.criteria !== String(side.criteria || '').trim());
    const labelOf = r => String(r.taskTitle || (r.a && r.a.criteria) || 'Untitled test').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Untitled test';
    function savedItem(side, title, exemplar, now = Date.now(), rand = Math.random) {
        const SC = root.TaskitatorSavedCriteria, t = SC.clean(title);
        if (!t) throw Error('Please enter a title.');
        if (!canConfirm(side)) throw Error('Validate this exact criteria with a score of 8/10 or higher first.');
        return { id: 'sc_' + now + '_' + rand().toString(36).slice(2, 6), title: t, criteria: String(side.criteria).trim(), score: side.validate.score, has_exemplar: Boolean(exemplar), exemplar: exemplar || null, created_at: new Date(now).toISOString(), source: 'lab' };
    }
    function memoryAdapter() {
        const m = new Map();
        return { all: async () => [...m.values()], put: async r => { m.set(r.id, r); }, delete: async id => { m.delete(id); }, clear: async () => { m.clear(); } };
    }
    const dbName = user => 'taskitator-test-lab-' + (String(user || 'local').replace(/[^\w-]/g, '_'));
    function idbAdapter(name, idb = root.indexedDB) {
        let opened = null;
        const open = () => opened || (opened = new Promise((resolve, reject) => {
            const q = idb.open(name, 1);
            q.onupgradeneeded = () => q.result.createObjectStore('tests', { keyPath: 'id' });
            q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
        }));
        const run = async (mode, fn) => {
            const db = await open();
            return new Promise((resolve, reject) => {
                const t = db.transaction('tests', mode), req = fn(t.objectStore('tests'));
                let out; if (req) req.onsuccess = () => { out = req.result; };
                t.oncomplete = () => resolve(out); t.onerror = t.onabort = () => reject(t.error);
            });
        };
        return { all: async () => (await run('readonly', s => s.getAll())) || [], put: r => run('readwrite', s => s.put(r)), delete: id => run('readwrite', s => s.delete(id)), clear: () => run('readwrite', s => s.clear()) };
    }
    // Account deletion: the whole database of this account goes.
    function clear(user, idb = root.indexedDB) {
        return new Promise(resolve => {
            if (!idb) return resolve(true);
            try { const q = idb.deleteDatabase(dbName(user)); q.onsuccess = () => resolve(true); q.onerror = () => resolve(false); q.onblocked = () => resolve(false); }
            catch (_) { resolve(false); }
        });
    }
    root.TaskitatorTestLab = { LIMITS, unitOf, fillNum, prepare, newTest, sizeOf, toDrop, canConfirm, stale, labelOf, savedItem, memoryAdapter, idbAdapter, dbName, clear };

    if (typeof document === 'undefined') return;
    const $ = id => document.getElementById(id);
    const tr = (key, vars) => (root.TaskitatorI18n && root.TaskitatorI18n.t ? root.TaskitatorI18n.t(key, vars) : key.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : '')));
    const el = (tag, text, parent, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; if (parent) parent.append(e); return e; };
    const notify = m => (root.TaskitatorNotify ? root.TaskitatorNotify(m) : alert(m));
    const AE = () => root.TaskitatorEngine && root.TaskitatorEngine.AuditEngine;
    const SAVED_KEY = 'taskitator_saved_criteria';

    let mounted = false, rec = null, store = null, isPro = false, busy = false, timer = null, sessionCalls = 0, sessionCredits = 0, ui = {};
    const user = () => (root.TaskitatorAuth && root.TaskitatorAuth.account && root.TaskitatorAuth.account.user) || 'local';

    async function persist() {
        if (!store || !rec) return;
        rec.updated = Date.now();
        try {
            await store.put(rec);
            const all = await store.all();
            for (const id of toDrop(all, rec.id)) { await store.delete(id); ui.footNote.textContent = tr('The oldest saved test was removed to stay within the storage limit.'); }
            renderHistory(all.filter(r => !toDrop(all, rec.id).includes(r.id)));
        } catch (_) { ui.footNote.textContent = tr('Saving on this device is not available, so this test will be lost when you leave the page.'); }
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(persist, 700); };

    function field(label, parent, type = 'text') { const l = el('label', label, parent, 'lab-field'), i = el(type === 'textarea' ? 'textarea' : 'input', undefined, l); if (type !== 'textarea') i.type = type; return i; }

    async function toFile(f) { return f.blob instanceof File ? f.blob : new File([f.blob], f.name, { type: f.type }); }
    async function payloadOf(f) {
        const file = await toFile(f);
        return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve({ fileName: file.name || 'exemplar', mimeType: file.type || 'application/octet-stream', fileSize: file.size || 0, data: String(r.result).split(',')[1] || '' }); r.onerror = reject; r.readAsDataURL(file); });
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
        return new Promise((resolve, reject) => { const t = el('textarea', text, document.body); t.style.cssText = 'position:fixed;opacity:0'; t.select(); try { document.execCommand('copy') ? resolve() : reject(Error('copy')); } catch (e) { reject(e); } t.remove(); });
    }

    // ---- one criteria version (A or B): criteria, Validate, Test and both results in one card (Phase 6.3) ----
    const SIDE_NAME = { a: 'Version A', b: 'Version B' };
    function card(key, parent) {
        const c = el('section', undefined, parent, 'lab-card');
        c.dataset.side = key;
        const head = el('div', undefined, c, 'lab-card-head');
        el('h3', tr(SIDE_NAME[key]), head, 'lab-card-title');
        const copyBtn = el('button', tr('Copy'), head, 'icon-btn lab-small'); copyBtn.type = 'button';
        let removeBtn = null;
        if (key === 'b') {
            removeBtn = el('button', tr('Remove B'), head, 'icon-btn lab-small lab-danger'); removeBtn.type = 'button';
            removeBtn.addEventListener('click', () => { if (busy) return; rec.b = null; load(); later(); });
        }
        const box = field(tr('Proof criteria'), c, 'textarea'); box.rows = 6; box.maxLength = 4000;
        const bar = el('div', undefined, c, 'lab-actions');
        const vBtn = el('button', tr('Validate'), bar, 'icon-btn lab-secondary'); vBtn.type = 'button';
        const tBtn = el('button', tr('Test'), bar, 'icon-btn lab-primary'); tBtn.type = 'button';
        const vOut = el('div', undefined, c, 'lab-result');
        const tOut = el('div', undefined, c, 'lab-result');
        const okBar = el('div', undefined, c, 'lab-actions');
        const confirmBtn = el('button', tr('Save to criteria library'), okBar, 'icon-btn lab-confirm'); confirmBtn.type = 'button';
        const confirmNote = el('span', undefined, okBar, 'lab-muted');
        const savePane = el('div', undefined, c, 'lab-save'); savePane.hidden = true;
        const part = { key, root: c, roots: [c], box, vBtn, tBtn, vOut, tOut, confirmBtn, confirmNote, copyBtn, removeBtn, savePane };
        box.addEventListener('input', () => { rec[key].criteria = box.value; paint(part); later(); });
        vBtn.addEventListener('click', () => act('validate', [key]));
        tBtn.addEventListener('click', () => act('test', [key]));
        copyBtn.addEventListener('click', async () => { try { await copyText(rec[key].criteria); copyBtn.textContent = tr('Copied'); setTimeout(() => { copyBtn.textContent = tr('Copy'); }, 1500); } catch (_) { notify(tr('Copy is not available here. Select the text and copy it by hand.')); } });
        confirmBtn.addEventListener('click', () => openSave(part));
        return part;
    }
    // good (green), warn (amber), bad (red): the same colours everywhere a score or verdict is shown.
    const scoreTone = s => (Number(s) >= 7 ? 'good' : Number(s) >= 4 ? 'warn' : 'bad');
    const verdictTone = v => (v === 'approved' ? 'good' : v === 'incomplete' ? 'warn' : 'bad');
    function paint(part) {
        const side = rec[part.key]; if (!side) return;
        if (part.box.value !== side.criteria) part.box.value = side.criteria;
        const fill = (out, r, label, line, tone) => {
            out.textContent = ''; out.hidden = !r; if (!r) return;
            const head = el('div', undefined, out, 'lab-result-head');
            el('span', label, head, 'lab-result-kind');
            if (r.error) { out.dataset.tone = 'bad'; el('strong', tr('Could not run'), head); el('p', r.error, out); return; }
            out.dataset.tone = tone(r);
            el('strong', line(r), head, 'lab-badge');
            if (stale(side, r)) el('span', tr('Older text'), head, 'lab-stale').title = tr('This result is for an earlier version of the text.');
            if (r.critique) el('p', r.critique, out);
            if (r.rewrite) { el('p', tr('Suggested rewrite:'), out, 'lab-muted'); el('p', r.rewrite, out, 'lab-rewrite'); }
            el('p', r.credits != null ? tr('{n} credits used.', { n: r.credits }) : tr('AI usage was consumed.'), out, 'lab-muted');
        };
        fill(part.vOut, side.validate, tr('Validation'), r => tr('Score: {n}/10', { n: r.score }), r => scoreTone(r.score));
        fill(part.tOut, side.test, tr('Test'), r => ({ approved: tr('APPROVED'), incomplete: tr('INSUFFICIENT PROOF') }[r.verdict]) || tr('REJECTED'), r => verdictTone(r.verdict));
        const ok = canConfirm(side);
        part.confirmBtn.disabled = busy || !ok;
        part.confirmNote.textContent = ok ? '' : tr('Needs a validation score of {n}/10 or higher for this exact text.', { n: LIMITS.pass });
        part.copyBtn.disabled = !String(side.criteria || '').trim();
        part.vBtn.disabled = part.tBtn.disabled = busy;
        if (part.removeBtn) part.removeBtn.disabled = busy;
    }
    const paintAll = () => {
        for (const k of ['a', 'b']) if (ui[k]) paint(ui[k]);
        ui.b.root.hidden = !rec.b; ui.addB.hidden = Boolean(rec.b); ui.both.hidden = !rec.b;
        ui.newBtn.disabled = ui.picker.disabled = ui.delBtn.disabled = busy;
        ui.totals.textContent = tr('This session: {c} AI calls, {n} credits reported.', { c: sessionCalls, n: sessionCredits });
    };

    // ---- confirm into Saved criteria ----
    function openSave(part) {
        const side = rec[part.key], p = part.savePane; p.textContent = ''; p.hidden = false;
        const t = field(tr('Title'), p); t.maxLength = LIMITS.title; t.value = labelOf(rec);
        const go = el('button', tr('Save to Saved criteria'), p, 'icon-btn lab-primary'); go.type = 'button';
        const no = el('button', tr('Cancel'), p, 'icon-btn'); no.type = 'button';
        const msg = el('p', undefined, p, 'lab-muted'); msg.setAttribute('role', 'status');
        no.addEventListener('click', () => { p.hidden = true; });
        go.addEventListener('click', async () => {
            try {
                let list; try { list = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (_) { list = []; }
                const SC = root.TaskitatorSavedCriteria; let exemplar = null, note = '';
                if (rec.exemplar) { const why = SC.addError(list, isPro, rec.exemplar.blob.size); if (!why) exemplar = await payloadOf(rec.exemplar); else note = ' ' + tr('The exemplar was not saved: {why}', { why }); }
                const full = SC.addError(list, isPro, 0); if (full) { msg.textContent = full; return; }
                list.push(savedItem(side, t.value, exemplar));
                localStorage.setItem(SAVED_KEY, JSON.stringify(list));
                if (root.SyncEngine && typeof SyncEngine.markLocalModified === 'function') { SyncEngine.markLocalModified(); SyncEngine.scheduleAutoPush(); }
                p.textContent = '';
                el('p', tr('Saved. It is in Saved criteria, marked with the Lab flask.') + note, p);
                el('p', tr('To use it: open a task, go to Proof criteria, press Suggested criteria, then open the Saved Criteria tab and tap it.'), p, 'lab-muted');
            } catch (e) { msg.textContent = e.message; }
        });
    }

    // ---- running ----
    async function costOk(kind, n, files) {
        const text = kind === 'test'
            ? tr('This runs {n} AI test call(s) with {f} proof file(s). It uses credits from your allowance.', { n, f: files })
            : tr('This runs {n} AI validation call(s). It uses credits from your allowance.', { n });
        if (root.TaskitatorConfirm) return root.TaskitatorConfirm({ title: kind === 'test' ? tr('Run test?') : tr('Validate criteria?'), message: text, confirmLabel: tr('Run') });
        return confirm(text);
    }
    async function act(kind, keys) {
        if (busy) return;
        if (root.TaskitatorOffline && root.TaskitatorOffline.active) { notify(tr('The Test lab needs an internet connection.')); return; }
        if (keys.some(k => !String(rec[k].criteria).trim())) { notify(tr('Enter the proof criteria first.')); return; }
        if (kind === 'test' && !rec.files.length) { notify(tr('Attach a test proof photo or PDF.')); return; }
        const prepared = {};
        for (const k of keys) {
            const p = prepare(rec, rec[k].criteria.trim(), root.TaskitatorSmartCriteria);
            if (p.missing) { notify(tr('Unresolved variable(s): {names}. Define each in the title as {name==value}.', { names: p.missing.join(', ') })); return; }
            prepared[k] = p;
        }
        if (!await costOk(kind, keys.length, rec.files.length)) return;
        busy = true; paintAll();
        try {
            let exemplarPart = null, exemplarFile = null;
            if (rec.exemplar) { exemplarFile = await toFile(rec.exemplar); if (kind === 'test') exemplarPart = await AE().fileToBase64(exemplarFile); }
            const files = kind === 'test' ? await Promise.all(rec.files.map(toFile)) : [];
            for (const k of keys) {
                const side = rec[k], text = side.criteria.trim(), sent = prepared[k].text, sentTitle = prepared[k].title;
                let res;
                try {
                    res = kind === 'validate'
                        ? await AE().validateCriteria(sent, sentTitle, exemplarFile)
                        : await AE().verifyProof({ taskId: rec.id, file: files[0], files, taskTitle: sentTitle, criteria: sent, userContext: rec.context, exemplarPart, test: true });
                } catch (e) { res = { success: false, error: e.message }; }
                sessionCalls++; rec.calls++;
                const credits = res && res.credits_charged != null ? Number(res.credits_charged) : null;
                if (credits) { sessionCredits += credits; rec.credits += credits; }
                if (!res || !res.success) side[kind] = { criteria: text, error: (res && res.error) || tr('The request could not be completed.') };
                else if (kind === 'validate') side.validate = { criteria: text, score: Number(res.score), passed: Boolean(res.passed), critique: res.critique || '', rewrite: res.suggested_rewrite || '', credits };
                else side.test = { criteria: text, verdict: String(res.verdict || 'rejected').toLowerCase(), critique: res.critique || res.reason || '', credits };
                paintAll();
            }
        } finally { busy = false; paintAll(); persist(); }
    }

    // ---- saved tests: a switcher in the sticky top bar (Phase 6.3) ----
    let known = [];
    function renderHistory(all) {
        known = [...all].sort((x, y) => (y.updated || 0) - (x.updated || 0));
        if (rec && !known.some(r => r.id === rec.id)) known.unshift(rec);
        const pick = ui.picker; pick.textContent = '';
        for (const r of known) {
            const o = el('option', labelOf(r) + ' · ' + new Date(r.updated || Date.now()).toLocaleDateString(), pick);
            o.value = r.id; if (rec && r.id === rec.id) o.selected = true;
        }
        ui.count.textContent = tr('{n} saved', { n: known.length });
    }
    function switchTo(id) {
        if (busy || !rec || id === rec.id) return;
        const next = known.find(r => r.id === id); if (!next) return;
        clearTimeout(timer); persist();
        rec = next; load(); renderHistory(known);
    }
    async function deleteCurrent() {
        if (busy || !rec) return;
        const ok = root.TaskitatorConfirm
            ? await root.TaskitatorConfirm({ title: tr('Delete this test?'), message: tr('Its criteria, results and proofs are removed from this device.'), confirmLabel: tr('Delete'), tone: 'danger' })
            : confirm(tr('Delete this test?'));
        if (!ok) return;
        clearTimeout(timer);
        try { await store.delete(rec.id); } catch (_) { /* already gone */ }
        const all = (await store.all()).sort((x, y) => (y.updated || 0) - (x.updated || 0));
        rec = all[0] || newTest(); load(); renderHistory(all);
    }
    function renderFiles() {
        ui.fileList.textContent = '';
        rec.files.forEach((f, i) => { const chip = el('span', f.name + ' ', ui.fileList, 'lab-chip'); const x = el('button', '✕', chip, 'lab-chip-x'); x.type = 'button'; x.setAttribute('aria-label', tr('Remove')); x.addEventListener('click', () => { rec.files.splice(i, 1); renderFiles(); later(); }); });
        ui.exName.textContent = rec.exemplar ? rec.exemplar.name : '';
        ui.exClear.hidden = !rec.exemplar;
        ui.inputsNote.textContent = tr('{f} proof file(s){x}', { f: rec.files.length, x: rec.exemplar ? ' · ' + tr('exemplar') : '' });
    }
    function load() { ui.title.value = rec.taskTitle; ui.unit.value = unitOf(rec.unit); ui.context.value = rec.context; renderFiles(); paintAll(); for (const k of ['a', 'b']) ui[k].savePane.hidden = true; }

    function build() {
        const rootEl = $('labRoot'); rootEl.textContent = '';
        const head = el('header', undefined, rootEl, 'plans-header');
        const h = el('h1', undefined, head); h.innerHTML = '<svg class="tk-ic" aria-hidden="true" focusable="false"><use href="#ic-test"></use></svg> '; h.append(tr('Test lab'), ' ');
        el('span', 'PRO', h, 'tag-chip');
        el('p', tr('Try proof criteria before you use them. Validate scores the wording; Test runs a real audit on your sample proof. Nothing here saves or locks a task. Both use credits.'), rootEl, 'plans-note');
        ui.locked = el('p', tr('The Test lab is a Taskitator Pro feature.'), rootEl, 'plans-notice'); ui.locked.hidden = true;
        const wb = ui.wb = el('div', undefined, rootEl, 'lab-bench');
        // Sticky switcher: change tests without scrolling.
        const top = el('div', undefined, wb, 'lab-topbar');
        const pl = el('label', undefined, top, 'lab-picker');
        el('span', tr('Test'), pl, 'lab-picker-label');
        ui.picker = el('select', undefined, pl); ui.picker.setAttribute('aria-label', tr('Saved tests'));
        ui.picker.addEventListener('change', () => switchTo(ui.picker.value));
        ui.count = el('span', undefined, top, 'lab-muted lab-count');
        ui.newBtn = el('button', tr('New test'), top, 'icon-btn lab-primary'); ui.newBtn.type = 'button';
        ui.newBtn.addEventListener('click', () => { if (busy) return; clearTimeout(timer); persist(); rec = newTest(); load(); renderHistory(known); });
        ui.delBtn = el('button', tr('Delete'), top, 'icon-btn lab-danger'); ui.delBtn.type = 'button';
        ui.delBtn.addEventListener('click', deleteCurrent);
        // Shared inputs, used by both versions.
        const inputs = el('details', undefined, wb, 'lab-inputs'); inputs.open = true;
        const sum = el('summary', undefined, inputs); el('span', tr('Test inputs'), sum, 'lab-inputs-title'); ui.inputsNote = el('span', undefined, sum, 'lab-muted');
        const grid = el('div', undefined, inputs, 'lab-inputs-grid');
        ui.title = field(tr('Task title (optional, helps the AI)'), grid); ui.title.maxLength = 160;
        ui.title.addEventListener('input', () => { rec.taskTitle = ui.title.value; later(); renderHistory(known); });
        ui.unit = field(tr('Unit number (used for {num} unless the title sets it)'), grid); ui.unit.type = 'number'; ui.unit.min = '1'; ui.unit.max = '9999'; ui.unit.step = '1'; ui.unit.value = '1';
        ui.unit.addEventListener('input', () => { rec.unit = unitOf(ui.unit.value); later(); });
        el('p', tr('Variables work as in tasks: write {name==value} in the title and {name} in the criteria.'), inputs, 'lab-muted');
        const proof = el('fieldset', undefined, inputs, 'lab-proof'); el('legend', tr('Test proof (shared by A and B)'), proof);
        const fl = el('label', tr('Proof photos or PDFs (up to 5)'), proof, 'lab-field'), fi = el('input', undefined, fl); fi.type = 'file'; fi.multiple = true; fi.accept = 'image/*,application/pdf';
        ui.fileList = el('div', undefined, proof, 'lab-chips');
        fi.addEventListener('change', () => {
            const files = Array.from(fi.files || []); fi.value = '';
            if (!files.length) return;
            const check = AE().validateProofFiles(files); if (!check.valid) { notify(check.error); return; }
            rec.files = files.map(f => ({ name: f.name, type: f.type, blob: f })); renderFiles(); later();
        });
        const ex = el('fieldset', undefined, inputs, 'lab-proof'); el('legend', tr('Exemplar (optional, shared by A and B)'), ex);
        const el2 = el('label', tr('Exemplar (optional)'), ex, 'lab-field'), ei = el('input', undefined, el2); ei.type = 'file'; ei.accept = 'image/*,application/pdf';
        ui.exName = el('span', undefined, ex, 'lab-muted'); ui.exClear = el('button', tr('Remove exemplar'), ex, 'icon-btn lab-small'); ui.exClear.type = 'button';
        ei.addEventListener('change', () => { const f = ei.files && ei.files[0]; ei.value = ''; if (!f) return; const check = AE().validateFile(f); if (!check.valid) { notify(check.error); return; } rec.exemplar = { name: f.name, type: f.type, blob: f }; renderFiles(); later(); });
        ui.exClear.addEventListener('click', () => { rec.exemplar = null; renderFiles(); later(); });
        ui.context = field(tr('Note to the auditor (optional)'), inputs); ui.context.maxLength = 500;
        ui.context.addEventListener('input', () => { rec.context = ui.context.value; later(); });
        // The two versions, side by side on wide screens.
        const cols = el('div', undefined, wb, 'lab-cols');
        ui.a = card('a', cols); ui.b = card('b', cols);
        ui.addB = el('button', tr('Add a second version (B) to compare'), wb, 'icon-btn lab-secondary'); ui.addB.type = 'button';
        ui.addB.addEventListener('click', () => { rec.b = rec.b || blank(); if (!rec.b.criteria) rec.b.criteria = rec.a.criteria; load(); later(); });
        const both = ui.both = el('div', undefined, wb, 'lab-actions lab-both');
        const vb = el('button', tr('Validate both'), both, 'icon-btn lab-secondary'), tb = el('button', tr('Test both'), both, 'icon-btn lab-primary');
        vb.type = tb.type = 'button';
        vb.addEventListener('click', () => act('validate', ['a', 'b']));
        tb.addEventListener('click', () => act('test', ['a', 'b']));
        ui.totals = el('p', undefined, wb, 'lab-muted'); ui.totals.setAttribute('role', 'status');
        const foot = el('footer', undefined, rootEl, 'lab-foot');
        el('p', tr('Tests and proofs are saved on this device only, in your browser. Clearing browser data or switching devices removes them.'), foot, 'lab-muted');
        ui.footNote = el('p', undefined, foot, 'lab-muted');
    }

    async function show() {
        if (!$('labRoot')) return;
        if (!mounted) {
            mounted = true; build();
            try { store = root.indexedDB ? idbAdapter(dbName(user())) : memoryAdapter(); await store.all(); }
            catch (_) { store = memoryAdapter(); ui.footNote.textContent = tr('Saving on this device is not available, so this test will be lost when you leave the page.'); }
            const all = await store.all(); rec = [...all].sort((x, y) => (y.updated || 0) - (x.updated || 0))[0] || newTest(); load(); renderHistory(all);
        }
        try { const s = await (root.TaskitatorPro && root.TaskitatorPro.getStatus && root.TaskitatorPro.getStatus()); isPro = Boolean(s && s.isPro); } catch (_) { isPro = false; }
        ui.locked.hidden = isPro; ui.wb.hidden = !isPro;
    }
    root.TaskitatorTestLabView = Object.freeze({ show, hide() { clearTimeout(timer); if (rec && mounted) persist(); } });
})(typeof window === 'undefined' ? globalThis : window);
