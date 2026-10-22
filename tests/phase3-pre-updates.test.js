import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('UI layout: bonus task toggle is below subtask shield in creation and edit modals', () => {
    const html = fs.readFileSync('index.html', 'utf-8');
    
    // Check Creation Modal
    const prereqCreateIdx = html.indexOf('id="prerequisiteBoxContainer"');
    const bonusCreateIdx = html.indexOf('id="bonusTaskContainer"');
    assert.ok(prereqCreateIdx > 0, 'prerequisiteBoxContainer must exist');
    assert.ok(bonusCreateIdx > 0, 'bonusTaskContainer must exist');
    assert.ok(bonusCreateIdx > prereqCreateIdx, 'bonusTaskContainer must be below prerequisiteBoxContainer in creation modal');

    // Check Details / Edit Modal
    const prereqEditIdx = html.indexOf('id="editPrerequisiteBoxContainer"');
    const bonusEditIdx = html.indexOf('id="editBonusTaskContainer"');
    assert.ok(prereqEditIdx > 0, 'editPrerequisiteBoxContainer must exist');
    assert.ok(bonusEditIdx > 0, 'editBonusTaskContainer must exist');
    assert.ok(bonusEditIdx > prereqEditIdx, 'editBonusTaskContainer must be below editPrerequisiteBoxContainer in edit modal');
});

test('UI elements: AI audit checkbox has info trigger button with token warning and no pre-audit discount mention', () => {
    const html = fs.readFileSync('index.html', 'utf-8');
    assert.ok(html.includes('id="createAiAuditInfoBtn"'), 'createAiAuditInfoBtn must exist');
    assert.ok(html.includes('id="editAiAuditInfoBtn"'), 'editAiAuditInfoBtn must exist');
    assert.ok(html.includes('id="createAiAuditInfoBox"'), 'createAiAuditInfoBox must exist');
    assert.ok(html.includes('id="editAiAuditInfoBox"'), 'editAiAuditInfoBox must exist');

    // Warning text must warn about token consumption and no refund on rejection
    assert.match(html, /Submitting proof consumes your AI usage/);
    assert.match(html, /rejected because it fails the task criteria or is invalid, token usage is still calculated and consumed/);
    assert.match(html, /no refunds are issued/);

    // Crucial requirement: Must NOT mention 50% discount pre-audit
    const createBox = html.slice(html.indexOf('id="createAiAuditInfoBox"'), html.indexOf('id="createAiAuditInfoBox"') + 500);
    assert.doesNotMatch(createBox, /50%|discount/i, 'Pre-audit warning must not disclose the 50% discount');
});

test('Settings Pro block: specified Hosted Personal AI phrase is removed', () => {
    const proUi = fs.readFileSync('pro/pro-ui.js', 'utf-8');
    assert.ok(!proUi.includes('Hosted Personal AI: Pro accounts receive automated single, multi-file, and batch proof audits powered by personal'),
        'The specified Hosted Personal AI phrase must be removed from pro-ui.js');
});

test('Settings Pro block: How credits work is a roll-down details menu closed by default', () => {
    const proUi = fs.readFileSync('pro/pro-ui.js', 'utf-8');
    assert.ok(proUi.includes('<details class="pro-credit-help" id="pro-credit-help-details">'),
        'How credits work must be a <details> element');
    assert.ok(!proUi.includes('<details class="pro-credit-help" id="pro-credit-help-details" open>'),
        'How credits work must be closed by default');
    assert.ok(proUi.includes('Document Page Count:'), 'Must explain page count system');
    assert.ok(proUi.includes('Photo Quality & Resolution:'), 'Must explain photo resolution system');
});

test('Vault: API key connection test displays green/red popup box', () => {
    const vaultClient = fs.readFileSync('vault-client.js', 'utf-8');
    assert.ok(vaultClient.includes('vault-test-popup'), 'vault-client.js must apply vault-test-popup class');
    assert.ok(vaultClient.includes('showTestPopup') || vaultClient.includes('isTest'), 'vault-client.js must distinguish test status');

    const styleCss = fs.readFileSync('style.css', 'utf-8');
    assert.ok(styleCss.includes('.vault-test-popup.success'), 'style.css must include success popup style');
    assert.ok(styleCss.includes('.vault-test-popup.error'), 'style.css must include error popup style');
});
