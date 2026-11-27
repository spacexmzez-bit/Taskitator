// Phase 6.5: Auto create ({num==1-15}) under Consecutive, Pro-gated, with a "?" help panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const comp = read('components.js'), html = read('index.html'), css = read('style.css');
const E = vm.runInNewContext(comp.slice(comp.indexOf('const SmartCriteriaEngine = {'), comp.indexOf('window.TaskitatorSmartCriteria')) + '; SmartCriteriaEngine', { window: { TaskitatorNotify() {} } });
const nums = r => Array.from(r.items, t => Number(/\{num==(\d+)\}/.exec(t)[1]));

test('range expands to one title per number, keeping the surrounding text', () => {
    const r = E.expandConsecutiveRange('Lesson {num==1-15} review');
    assert.equal(r.ok, true); assert.equal(r.count, 15);
    assert.deepEqual(nums(r), Array.from({ length: 15 }, (_, i) => i + 1));
    assert.equal(r.items[0], 'Lesson {num==1} review'); assert.equal(r.items[14], 'Lesson {num==15} review');
});

test('skips after underscores are removed; out-of-range and first/last skips are ignored', () => {
    assert.deepEqual(nums(E.expandConsecutiveRange('{num==1-15_5_7_17}')), [1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.deepEqual(nums(E.expandConsecutiveRange('{num==1-15_1_15}')), Array.from({ length: 15 }, (_, i) => i + 1));
    assert.deepEqual(nums(E.expandConsecutiveRange('{num==3-6_4_4_0}')), [3, 5, 6]);
    assert.deepEqual(nums(E.expandConsecutiveRange('{num==5-5}')), [5]);
});

test('reversed range, malformed syntax and oversize ranges create nothing', () => {
    assert.equal(E.expandConsecutiveRange('{num==15-1}').ok, false);
    assert.equal(E.expandConsecutiveRange('{num==1-15_a}').ok, false);
    assert.equal(E.expandConsecutiveRange('{num==1 - 15}').ok, false);
    assert.equal(E.expandConsecutiveRange('{num==1-101}').ok, false);
    assert.equal(E.expandConsecutiveRange('{num==1-100}').ok, true, 'exactly 100 is allowed');
    assert.equal(E.expandConsecutiveRange('{num==1-102_2_3}').count, 100, 'skips count against the cap');
    assert.equal(E.expandConsecutiveRange('{num==1-99999999999999999999}').ok, false);
});

test('range detection: only ranges, never a plain {num==5}', () => {
    assert.equal(E.hasRangePattern('Lesson {num==1-7}'), true);
    assert.equal(E.hasRangePattern('{num==1 - 7_3}'), true);
    assert.equal(E.hasRangePattern('Lesson {num==5}'), false);
    assert.equal(E.hasRangePattern('{title==a-b}'), false);
    assert.equal(E.incrementConsecutiveNum('x {num==5}'), 'x {num==6}', 'single numbering is unchanged');
});

// Run the real autoCreateRange with stubs.
const fnSrc = comp.slice(comp.indexOf('const AUTO_CONFIRM_OVER = 20;'), comp.indexOf('const buildDetailSubtask'));
function harness({ allowed = true, confirm = true } = {}) {
    const calls = { grant: 0, confirm: [], made: null };
    const ctx = {
        SmartCriteriaEngine: E,
        grantConsecutive: async () => { calls.grant++; return allowed ? { allowed: true } : { allowed: false, status: 'denied', message: 'Pro only' }; },
        window: { TaskitatorConfirm: async o => { calls.confirm.push(o); return confirm; } }
    };
    vm.createContext(ctx);
    vm.runInContext(fnSrc + '; this.run = autoCreateRange;', ctx);
    const mk = () => ({ value: '', _quickGeneration: 1, focus() {}, checked: true });
    const notice = { style: {}, textContent: '' };
    const run = (raw, o = {}) => {
        const input = mk(), cons = { checked: o.consecutive ?? true }, auto = { checked: o.auto ?? true };
        return ctx.run({ input, raw, generation: 1, noticeEl: notice, consecutiveCb: cons, autoCb: auto, create: items => { calls.made = items; } }).then(() => ({ input, auto, notice }));
    };
    return { run, calls };
}

test('Auto create: one Pro check, no confirm up to 20, one batch', async () => {
    const h = harness();
    await h.run('Lesson {num==1-20}');
    assert.equal(h.calls.grant, 1); assert.equal(h.calls.confirm.length, 0); assert.equal(h.calls.made.length, 20);
});

test('Auto create: more than 20 asks first; declining creates nothing and restores the text', async () => {
    const h = harness({ confirm: false });
    const r = await h.run('Lesson {num==1-21}');
    assert.equal(h.calls.confirm.length, 1); assert.match(h.calls.confirm[0].title, /21/);
    assert.equal(h.calls.made, null); assert.equal(r.input.value, 'Lesson {num==1-21}');
});

test('Auto create: off, or Consecutive off, shows a hint and creates nothing (never a literal subtask)', async () => {
    const h = harness();
    const a = await h.run('Lesson {num==1-7}', { auto: false });
    assert.equal(h.calls.made, null); assert.equal(h.calls.grant, 0);
    assert.match(a.notice.textContent, /Turn on Auto create/); assert.equal(a.input.value, 'Lesson {num==1-7}');
    const b = await h.run('Lesson {num==1-7}', { consecutive: false, auto: false });
    assert.match(b.notice.textContent, /Tick Consecutive/); assert.equal(h.calls.made, null);
});

test('Auto create: Pro denied unticks it, shows the message and creates nothing', async () => {
    const h = harness({ allowed: false });
    const r = await h.run('Lesson {num==1-7}');
    assert.equal(h.calls.made, null); assert.equal(r.auto.checked, false); assert.equal(r.notice.textContent, 'Pro only');
});

test('Auto create: invalid range shows the reason and keeps the text for fixing', async () => {
    const h = harness();
    const r = await h.run('Lesson {num==9-2}');
    assert.equal(h.calls.made, null); assert.equal(h.calls.grant, 0); assert.match(r.notice.textContent, /go up/); assert.equal(r.input.value, 'Lesson {num==9-2}');
});

test('both quick inputs route ranges through Auto create before any literal creation', () => {
    for (const [name, create] of [['detail', 'createDetailBatch(items, parentTask)'], ['create', 'items.forEach(addBuilderItem)']]) {
        const input = name === 'detail' ? 'detailQuickSubtaskInput' : 'createQuickSubtaskInput';
        const i = comp.indexOf('await autoCreateRange({\n                                input: ' + input);
        assert.ok(i > 0, name + ' calls autoCreateRange');
        assert.ok(comp.slice(i, i + 700).includes(create), name + ' batch creator');
    }
    assert.match(comp, /const check = await grantConsecutive\(\);\s+if \(!autoCb\.checked\)/, 'Auto create reads the held Pro grant');
});

test('batch creation: one save and one refresh, unique ids, created_at keeps the order', () => {
    const body = comp.slice(comp.indexOf('const createDetailBatch'), comp.indexOf('const addBuilderItem'));
    assert.equal((body.match(/host\.tasks\.save\(\)/g) || []).length, 1);
    assert.equal((body.match(/refreshDetailAfterAdd\(\)/g) || []).length, 1);
    assert.match(body, /used\.has\(id\)/); assert.match(body, /new Date\(base \+ i\)/);
});

test('markup: Auto create row in both panels, "?" buttons, help panels, Pro pill', () => {
    for (const p of ['create', 'detail']) {
        assert.match(html, new RegExp('id="' + p + 'AutoCreateToggle"'));
        assert.match(html, new RegExp('id="' + p + 'ConsecHelpBtn"[^>]*aria-expanded="false"[^>]*aria-controls="' + p + 'ConsecHelp"'));
        assert.match(html, new RegExp('id="' + p + 'ConsecHelp" hidden'));
    }
    assert.equal((html.match(/class="auto-create-wrap"/g) || []).length, 2);
    assert.match(html, /<label class="subtask-head-title">Subtasks Under This Task<\/label>\s*<button[^>]*id="detailConsecHelpBtn"/, 'button sits right of the label');
    assert.match(html, /Auto create \{num==1-15\}<\/span>\s*<span class="pro-feature-pill">PRO<\/span>/);
});

test('toggle behaviour: Pro check on tick, off when Consecutive changes, locked without Pro', () => {
    assert.match(comp, /consecutiveEl\.addEventListener\('change', \(\) => \{ autoEl\.checked = false; \}\)/);
    assert.match(comp, /for\(const id of \['createConsecutiveToggle','detailConsecutiveToggle','createAutoCreateToggle','detailAutoCreateToggle'\]\)\{const e=document\.getElementById\(id\);if\(e\)\{e\.disabled=!allowed;if\(!allowed\)e\.checked=false;\}\}/);
    assert.match(comp, /'\.subtask-head-tools', '\.auto-create-wrap'/, 'locked with the rest of the subtask tools when the task is done');
});

test('CSS: pop-down is driven by the Consecutive checkbox, animated, reduced-motion safe, RTL-safe', () => {
    assert.match(css, /\.form-group:has\(#createConsecutiveToggle:checked\) > \.auto-create-wrap/);
    assert.match(css, /\.form-group:has\(#detailConsecutiveToggle:checked\) > \.auto-create-wrap/);
    assert.match(css, /\.auto-create-wrap \{\s*grid-template-rows: 0fr;[\s\S]*?transition: grid-template-rows \.2s/);
    assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.auto-create-wrap \{ transition: none !important; \}/);
    assert.match(css, /html\[data-motion="reduced"\] \*/, 'Phase 6.6 motion modes collapse the pop-down transition globally');
    assert.match(css, /\.auto-create-label \{ padding-inline-start: 10px; border-inline-start/);
});

test('help: Pro help section and README describe Auto create; cache moved', () => {
    assert.match(html, /id="help-p-auto">\s*<h3>[^\n]*Auto create <span class="hp-pro">PRO<\/span><\/h3>/); // Phase 6.9 Help: its own section
    assert.match(read('README.md'), /Auto create \(Phase 6\.5\)/);
    assert.match(read('sw.js'), /CACHE_NAME = 'taskitator-phase4-v75'/);
});
