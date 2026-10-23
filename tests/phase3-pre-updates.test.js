import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('creation and edit dialogs retain independent bonus, shield and AI-proof controls',()=>{
    const html=fs.readFileSync('index.html','utf8');
    const create=html.slice(html.indexOf('id="taskCreateForm"'),html.indexOf('<!-- Modal: Templates'));
    const edit=html.slice(html.indexOf('id="taskDetailModal"'),html.indexOf('<!-- Modal: Emergency'));
    for(const id of ['bonusTaskCheckbox','strictPrereqCheckbox','aiLockCheckbox'])assert.ok(create.includes('id="'+id+'"'));
    for(const id of ['editBonusTaskCheckbox','editStrictPrereqCheckbox','editAiLockCheckbox'])assert.ok(edit.includes('id="'+id+'"'));
});

test('paid-review confirmation explains the charge on rejection and unused held credits',()=>{
    const ui=fs.readFileSync('pro/pro-ui.js','utf8');
    assert.match(ui,/Unused held credits return to your balance/);
    assert.match(ui,/A completed review is charged even when proof is rejected/);
    assert.match(ui,/>Cancel<\/button>/);assert.match(ui,/>Start review<\/button>/);
});

test('Settings hosted AI description uses plain language',()=>{
    const ui=fs.readFileSync('pro/pro-ui.js','utf8');
    assert.ok(!ui.includes('Hosted Personal AI:'));
    assert.ok(ui.includes('No personal API key required.'));
});

test('credit help is collapsed by default and explains dynamic charges without old fixed file tariffs',()=>{
    const ui=fs.readFileSync('pro/pro-ui.js','utf8');
    assert.ok(ui.includes('<details class="pro-credit-help" id="pro-credit-help-details">'));
    assert.ok(!ui.includes('<details class="pro-credit-help" id="pro-credit-help-details" open>'));
    assert.match(ui,/Larger files and longer reviews use more credits/);
    assert.match(ui,/25% off/);assert.match(ui,/doubles that task’s charge/);
});

test('API key connection tests retain their visible success/error feedback',()=>{
    const client=fs.readFileSync('vault-client.js','utf8'),css=fs.readFileSync('style.css','utf8');
    assert.match(client,/vault-test-popup/);assert.match(css,/\.vault-test-popup\.success/);assert.match(css,/\.vault-test-popup\.error/);
});
