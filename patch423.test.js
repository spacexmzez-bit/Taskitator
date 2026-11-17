// Phase 4.2.3: Test lab layout (Validation / Testing sections) and title variables.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = f => fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const lab = read('test-lab.js'), comp = read('components.js'), ar = read('locales/ar.js');
const ctx = { window: {} }; ctx.window = ctx; vm.createContext(ctx); vm.runInContext(lab, ctx);
const L = ctx.TaskitatorTestLab;
// The real engine from components.js
const eng = comp.slice(comp.indexOf('const SmartCriteriaEngine = {'), comp.indexOf('window.TaskitatorSmartCriteria'));
const E = vm.runInNewContext(eng + '; SmartCriteriaEngine', { window: { TaskitatorNotify() {} } });
const rec = (title, unit = 1) => ({ taskTitle: title, unit });

test('Phase 4.2.3: the engine is exposed to the Test lab', () => {
  assert.match(comp, /window\.TaskitatorSmartCriteria = SmartCriteriaEngine/);
  assert.match(lab, /root\.TaskitatorSmartCriteria/);
});

test('Phase 4.2.3: title variables fill the criteria and the AI gets the clean title', () => {
  const p = L.prepare(rec('Chapter {title==water} test'), 'Show the {title} proof', E);
  assert.equal(p.title, 'Chapter water test');
  assert.equal(p.text, 'Show the water proof');
});

test('Phase 4.2.3: {num} comes from the title if set, otherwise from the unit field', () => {
  assert.equal(L.prepare(rec('Lesson {num==5}', 9), 'Sample {num}', E).text, 'Sample 5');
  assert.equal(L.prepare(rec('Lesson', 9), 'Sample {num}', E).text, 'Sample 9');
  assert.equal(L.prepare(rec('', 1), 'plain text', E).text, 'plain text');
});

test('Phase 4.2.3: an undefined variable blocks instead of reaching the AI literally', () => {
  const p = L.prepare(rec('Lesson'), 'Show {topic}', E);
  assert.deepEqual(JSON.parse(JSON.stringify(p.missing)), ['topic']);
  assert.match(lab, /Unresolved variable\(s\)/);
});

test('Phase 4.2.3: layout has separate Validation and Testing sections with the requested placement', () => {
  const build = lab.slice(lab.indexOf('function build()'));
  const iV = build.indexOf("tr('Validation')"), iT = build.indexOf("tr('Testing')");
  assert.ok(iV > 0 && iT > iV);
  const col = lab.slice(lab.indexOf('function column('), lab.indexOf('function paint('));
  assert.ok(col.indexOf("'Copy'") > col.indexOf("field(tr('Proof criteria')") && col.indexOf("'Copy'") < col.indexOf("'Validate'"), 'Copy sits next to the box');
  assert.ok(col.indexOf("'Confirm'") > col.indexOf('vOut'), 'Confirm is below the validation result');
  assert.ok(!/'Test'/.test(col.slice(0, col.indexOf("const t = el('section'"))), 'Test button is not in the validation half');
  assert.ok(build.indexOf("tr('Exemplar (optional)')") > iV && build.indexOf("tr('Exemplar (optional)')") < iT, 'exemplar is in Validation');
  assert.ok(build.indexOf("tr('Unit number") > iT, 'unit number is in Testing');
  assert.ok(build.indexOf("tr('Test proof (shared by A and B)')") > iT, 'proof upload is in Testing');
});

test('Phase 4.2.3: Arabic strings exist for the new labels, no duplicate keys', () => {
  for (const k of ['Validation', 'Testing', 'Exemplar (optional, shared by A and B)', 'Unit number (used for {num} unless the title sets it)']) assert.ok(ar.includes('"' + k + '":'), k);
  const keys = [...ar.matchAll(/^\s{8}"((?:[^"\\]|\\.)+)":/gm)].map(m => m[1]);
  assert.equal(keys.length, new Set(keys).size);
});
