// Phase 4.2.2: the Test lab fills {num} before sending criteria to the AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('./test-lab.js', import.meta.url), 'utf8');
const ctx = { window: {}, globalThis: {} }; ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
const L = ctx.TaskitatorTestLab;

test('Phase 4.2.2: {num} is replaced with the unit number everywhere it appears', () => {
  assert.equal(L.fillNum('Sample {num}, again {num}', 14), 'Sample 14, again 14');
  assert.equal(L.fillNum('no placeholder', 3), 'no placeholder');
  assert.equal(L.fillNum('Sample {other}', 3), 'Sample {other}');
});

test('Phase 4.2.2: invalid unit numbers fall back to 1; new tests start at 1', () => {
  for (const bad of ['', 'x', 0, -5, 20000, null, undefined]) assert.equal(L.unitOf(bad), 1);
  assert.equal(L.unitOf('14'), 14);
  assert.equal(L.unitOf(7.9), 7);
  assert.equal(L.newTest().unit, 1);
});

test('Phase 4.2.2: validate and test send the filled text; the stored criteria keeps {num}', () => {
  assert.match(src, /sent = prepared\[k\]\.text/);
  assert.match(src, /validateCriteria\(sent,/);
  assert.match(src, /criteria: sent, userContext/);
  assert.match(src, /side\[kind\] = \{ criteria: text,/);
  assert.match(src, /ui\.unit\.type = 'number'/);
});
