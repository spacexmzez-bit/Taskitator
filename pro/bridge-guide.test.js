import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = new URL('../', import.meta.url);

test('downloadable bridge is disabled, has no real token or saved response, and uses one local response variable', () => {
    const template = JSON.parse(fs.readFileSync(new URL('pro/taskitator-cloud-bridge.macro', root), 'utf8'));
    const macro = template.macro;
    assert.equal(template.macroExportVersion, 1);
    assert.equal(macro.m_enabled, false);
    const request = macro.m_actionList.find(action => action.m_classType === 'HttpRequestAction');
    assert.deepEqual(request.requestConfig.headerParams, [{paramName:'Authorization',paramValue:'Bearer REPLACE_WITH_YOUR_PHONE_TOKEN'}]);
    assert.equal(request.requestConfig.urlToOpen, 'https://taskitator-sync.spacexmzez.workers.dev/?action=status&format=text');
    assert.equal(request.requestConfig.blockNextAction, true);
    assert.equal(request.requestConfig.allowAnyCertificate, false);
    assert.equal(request.disableLogging, true);
    const variable = macro.localVariables.find(item => item.m_name === request.requestConfig.responseVariableName);
    assert.equal(variable.isLocalVar, true);
    assert.equal(variable.m_type, 2);
    assert.equal(variable.m_stringValue, '');
    const condition = macro.m_actionList.find(action => action.m_classType === 'IfConditionAction').m_constraintList[0];
    assert.equal(condition.m_variable.m_name, variable.m_name);
    assert.equal(condition.m_variable.isLocalVar, true);
    assert.equal(condition.m_variable.m_type, variable.m_type);
    assert.equal(condition.m_stringValue, 'device_unlocked = true');
    assert.deepEqual(template.globalVariables, []);
    assert.deepEqual(macro.m_actionList.map(action => action.m_classType), ['HttpRequestAction','IfConditionAction','DisableMacroAction','ElseAction','DisableMacroAction','EndIfAction']);
    assert.equal(macro.m_actionList.filter(action => action.m_classType === 'DisableMacroAction').length, 2);
    assert.equal(macro.m_triggerList.find(trigger => trigger.m_classType === 'RegularIntervalTrigger').m_seconds, 300);
    assert.equal(macro.m_triggerList.find(trigger => trigger.m_classType === 'ScreenOnOffTrigger').m_screenOn, true);
});

test('guide offers a same-origin macro download and manual alternative while retaining the existing checkpoints', () => {
    const guide = fs.readFileSync(new URL('blocker-guide.html', root), 'utf8');
    assert.match(guide, /href="pro\/taskitator-cloud-bridge\.macro" download="Taskitator-Cloud-Bridge\.macro"/);
    assert.match(guide, /id="bridge-download"/);
    assert.match(guide, /href="#bridge-manual"/);
    assert.match(guide, /id="bridge-manual"/);
    assert.match(guide, /id="change-blocked-apps"/);
    assert.match(guide, /Re-select it even if/);
    assert.match(guide, /local String/);
    assert.match(guide, /Build the App Blocker manually first/);
    for (let number=1;number<=6;number++) assert.ok(guide.includes('id="p1-sub-'+number+'"'));
    for (let number=1;number<=26;number++) assert.ok(guide.includes('id="sub-'+number+'"'));
    assert.ok(fs.existsSync(new URL('pro/taskitator-cloud-bridge.macro', root)));
    assert.doesNotMatch(guide, /\sonclick=/i);
});
