import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {POLICY} from './audit-policy.js';
const root=new URL('../',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,root),'utf8');
const html=read('pro/compare.html');
const text=html.replace(/<[^>]*>/g,' ');

test('public comparison describes actual hosted limits and charging rules without a price',()=>{
    assert.equal(POLICY.daily,45);assert.equal(POLICY.monthly,1000);
    for(const expected of [/45 daily credits/,/1,000 monthly credits/,/both limits apply/,/Asia\/Riyadh/,/×2 multiplier/,/25% per-task batch discount/,/Charges are dynamic/,/Unused held credits return/,/even when proof is rejected/,/will not exceed the quoted maximum/,/separate monthly hosted allowance/])assert.match(text,expected);
    assert.doesNotMatch(text,/[$€£]|\b(?:USD|SAR|price|pricing|buy now)\b/i);
    assert.doesNotMatch(html,/<script\b|auth-bootstrap|TaskitatorAuth|Clerk|login\.html|http-equiv="refresh"/i);
    assert.match(text,/Anyone can read this page/);
});

test('comparison distinguishes manual creation, Pro convenience, personal key mode and hosted batch reviews',()=>{
    for(const expected of [/Tasks, manual subtasks, projects, tags, and priorities/,/including numbers/,/Automatically advance \{num==X\}/,/Create Task and Task Details/,/If Pro expires, existing subtasks and their numbering stay intact/,/manual creation remains available/,/Personal API-key reviews are separate from hosted credits/,/provider’s usage limits and charges apply/,/Switching modes does not reset hosted credit balances or limits/,/Hosted batch reviews require hosted mode/,/up to five proof files/,/eligible completions still require your confirmation/])assert.match(text,expected);
    assert.doesNotMatch(text,/unlimited|priority support|collaboration|team workspace/i);
    // The features and restrictions documented here have concrete implementation paths.
    assert.match(read('components.js'),/canCreateConsecutive/);
    assert.match(read('pro/pro-backend.js'),/personalReview\(identity,body\)/);
    assert.match(read('pro/pro-client.js'),/batchReview/);
    for(const prefix of ['create','detail'])assert.match(read('index.html'),new RegExp('id="'+prefix+'ConsecutiveToggle"[^>]*aria-describedby="'+prefix+'ConsecutiveToggleHelp"'));
});

test('comparison has accessible responsive table, Settings entry and valid relative navigation',()=>{
    assert.match(html,/<meta name="viewport"/);assert.match(html,/<html lang="en"/);
    assert.match(html,/<caption>[^<]+<\/caption>/);assert.match(html,/scope="row"/);assert.match(html,/scope="col"/);
    assert.match(html,/role="region"[^>]+aria-label="[^"]+"[^>]+tabindex="0"/);
    assert.match(html,/href="#main"/);
    for(const [,href] of html.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)){
        const relative=href.split('?')[0];assert.ok(fs.existsSync(new URL('pro/'+relative,root)),relative);
    }
    assert.match(read('pro/pro-ui.js'),/href="pro\/compare\.html">Compare Free and Pro/);
    assert.match(read('settings.html'),/id="pro-settings-container"/);
    assert.match(read('pro/pro.css'),/\.pro-comparison[\s\S]*overflow-x: auto/);
    assert.match(read('pro/pro.css'),/@media \(max-width: 480px\)/);
});

test('release cache handshake versions agree and comparison is cached',()=>{
    const sw=read('sw.js'),bootstrap=read('auth-bootstrap.js');
    const version=/const CACHE_NAME = '([^']+)'/.exec(sw)[1];
    assert.notEqual(version,'taskitator-security-breaks-v5');assert.ok(bootstrap.includes("event.data?.version === '"+version+"'"));
    assert.match(sw,/'\.\/pro\/compare\.html'/);
});
