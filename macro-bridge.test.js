import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = { window: {}, document: {} };
vm.runInNewContext(fs.readFileSync('macro-bridge.js', 'utf8'), sandbox);
const window = sandbox.window;
const { injectToken } = window.TaskitatorMacro;

const bridge = fs.readFileSync('macros/Taskitator_Cloud_Bridge.macro', 'utf8');
const blocker = fs.readFileSync('macros/App_Blocker.macro', 'utf8');
const TOKEN = 'tkp_' + 'ab12'.repeat(16);

test('token goes into the user token variable and nothing else changes', () => {
    const out = injectToken(bridge, TOKEN);
    assert.equal(out.length, bridge.length + TOKEN.length);
    assert.equal(out.replace(TOKEN, ''), bridge);
    assert.ok(out.includes('"m_name":"user token","m_stringValue":"' + TOKEN + '"'));
});

test('64-bit macro ids survive byte for byte', () => {
    const out = injectToken(bridge, TOKEN);
    for (const id of ['-5915731454437670570', '-6285268589153395576', '-8954806164334760814']) {
        assert.ok(out.includes(id), id);
    }
});

test('bad tokens and bad templates are rejected', () => {
    for (const bad of ['', 'tkp_short', 'Bearer ' + TOKEN, TOKEN + 'x', 'TKP_' + 'ab12'.repeat(16), null]) {
        assert.throws(() => injectToken(bridge, bad), /valid Taskitator phone token/);
    }
    assert.throws(() => injectToken('{}', TOKEN), /no single empty/);
    assert.throws(() => injectToken(injectToken(bridge, TOKEN), TOKEN), /no single empty/);
    assert.throws(() => injectToken('', TOKEN), /template is missing/);
});

test('shipped templates are valid and wired together', () => {
    const b = JSON.parse(bridge).macro, a = JSON.parse(blocker).macro;
    assert.equal(a.m_name, 'App Blocker');
    assert.equal(b.m_name, 'Taskitator Cloud Bridge');
    assert.equal(b.localVariables.find(v => v.m_name === 'user token').m_stringValue, '', 'template ships with no token');
    assert.ok(b.localVariables.find(v => v.m_name === 'user token').isSecure);
    assert.ok(bridge.includes('Bearer {lv\\u003duser token}'));
    assert.ok(bridge.includes('"m_GUID":-6285268589153395576') && blocker.includes('"m_GUID":-6285268589153395576'));
    assert.ok(!/tkp_[a-f0-9]{64}/.test(bridge + blocker), 'no real token in templates');
});

test('settings, guide and service worker are wired', () => {
    const settings = fs.readFileSync('settings.html', 'utf8');
    const guide = fs.readFileSync('components.html', 'utf8');
    const sw = fs.readFileSync('sw.js', 'utf8');
    assert.match(settings, /src="macro-bridge\.js"/);
    assert.match(settings, /setBridgeToken\(data\.token\)/);
    assert.match(settings, /setBridgeToken\(null\)/);
    assert.match(settings, /id="downloadBridgeBtn"[^>]*disabled/);
    assert.match(settings, /Download didn't work\? Add the token by hand/);
    assert.match(guide, /href="macros\/Taskitator_Cloud_Bridge\.macro"/);
    assert.match(guide, /href="macros\/App_Blocker\.macro"/);
    assert.match(guide, /Do not change the macro's title/);
    assert.match(guide, /Import\/Export<\/strong> section/);
    assert.match(guide, /three dots<\/strong>, then <strong>Save macro/);
    assert.doesNotMatch(guide, /data:application\/octet-stream;base64/);
    assert.match(sw, /\.\/macro-bridge\.js/);
});
