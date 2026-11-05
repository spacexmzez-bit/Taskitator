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
    assert.match(guide, /id="blocker-offline-sync"/);
    assert.match(guide, /Nothing is uploaded until you press Apply/);
    assert.match(guide, /Import\/Export<\/strong> section/);
    assert.match(guide, /three dots<\/strong>, then <strong>Save macro/);
    assert.doesNotMatch(guide, /data:application\/octet-stream;base64/);
    assert.match(sw, /\.\/macro-bridge\.js/);
});

// Audit F05: walk the shipped action list for every task/sleep combination.
// App Blocker must end ENABLED (-1) unless the device is unlocked AND it is not sleep time.
test('bridge macro makes one correct final blocking decision for every task/sleep combination', () => {
    const macro = JSON.parse(fs.readFileSync(new URL('./macros/Taskitator_Cloud_Bridge.macro', import.meta.url), 'utf8')).macro;
    const run = response => {
        let state = null; const stack = [];
        const active = () => stack.every(f => f.on);
        const test = a => { const c = a.m_constraintList[0]; assert.equal(c.m_variable.isLocalVar, true, 'conditions read the local response'); return response.includes(c.m_stringValue); };
        for (const a of macro.m_actionList) {
            if (a.m_classType === 'IfConditionAction') { const hit = test(a); stack.push({ on: hit, done: hit }); }
            else if (a.m_classType === 'ElseIfConditionAction') { const f = stack.at(-1); f.on = !f.done && test(a); f.done ||= f.on; }
            else if (a.m_classType === 'ElseAction') { const f = stack.at(-1); f.on = !f.done; f.done = true; }
            else if (a.m_classType === 'EndIfAction') stack.pop();
            else if (a.m_classType === 'DisableMacroAction' && active()) state = a.m_state;
        }
        return state;
    };
    for (const unlocked of [true, false]) for (const sleep of [true, false]) {
        const expected = unlocked && !sleep ? 1 : -1;
        assert.equal(run(`device_unlocked = ${unlocked}\nsleep = ${sleep}`), expected, `unlocked=${unlocked} sleep=${sleep}`);
    }
    assert.equal(run(''), -1, 'an empty/failed response blocks');
    const vars = macro.localVariables.find(v => v.m_name === 'http_response');
    assert.equal(vars.m_stringValue, '', 'no shipped default "unlocked" response');
});
