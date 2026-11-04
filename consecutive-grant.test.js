import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const components = fs.readFileSync(new URL('components.js', import.meta.url), 'utf8');
const pro = fs.readFileSync(new URL('pro.js', import.meta.url), 'utf8');

test('the Pro check is a single shared promise, dropped on denial or error and lapsing at its expiry', () => {
    assert.match(components, /if\(held&&!\(held\.expires_at!==null&&held\.expires_at<=Date\.now\(\)\)\)return held\.promise;/);
    assert.match(components, /if\(check\.allowed\)grant\.expires_at=check\.expires_at\?\?null;/);
    assert.match(components, /grant\.promise\.then\(check=>\{if\(!check\.allowed\)drop\(\);\},drop\);/);
    // Only the grant helper reaches the server check; the tick and both quick-subtask handlers use it.
    assert.equal((components.match(/checkConsecutiveEntitlement\(\)/g) || []).length, 1);
    assert.equal((components.match(/await grantConsecutive\(\)/g) || []).length, 3);
});

test('opening an editor makes no Pro check', () => {
    const start = components.indexOf('function refreshConsecutive(');
    const line = components.slice(start, components.indexOf('\n', start));
    assert.doesNotMatch(line, /checkConsecutiveEntitlement|await|async/);
    assert.match(line, /e\.disabled=false/);
});

test('the held result is cleared on Save Changes, on discard, and when the account changes', () => {
    assert.match(components, /function discardDraft\(\)\{[^}]*draft=null;clearConsecutiveGrant\(\);/);
    assert.match(components, /draft=null;window\.TaskitatorEditorDraft=null;clearConsecutiveGrant\(\);liveHost\.tasks\.save\(\);return true;/);
    assert.match(components, /if\(draft&&draft\.session!==localStorage\.getItem\('taskitator_session_id'\)\)\{draft=null;clearConsecutiveGrant\(\);/);
});

test('the Pro client returns the subscription expiry so a held result cannot outlive it', () => {
    assert.match(pro, /return \{ allowed: true, status: 'active', message: '', expires_at: status\.expires_at \?\? null \};/);
});
