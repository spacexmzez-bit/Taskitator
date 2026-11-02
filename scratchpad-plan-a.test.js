import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('./app.js',import.meta.url),'utf8');
const part=source.slice(source.indexOf('    function scratchpadBlocked()'),source.indexOf('    window.TaskitatorScratchpadBlocked='));
function blocked(tasks){const c={localStorage:{getItem:()=>JSON.stringify(tasks)},window:{TaskitatorEngine:{BreakEngine:{getLogicalDayBounds:()=>({dateStr:'2026-11-02'})}}},Date};vm.runInNewContext(part,c);return c.scratchpadBlocked();}
const t=(id,due_date,status='active',is_bonus=false,parent_id=null)=>({id,due_date,status,is_bonus,parent_id});
test('scratchpad blocks required tasks today and overdue, but not future, bonus or addressed work',()=>{assert.equal(blocked([t('a','2026-11-02')]),true);assert.equal(blocked([t('a','2026-11-01')]),true);for(const x of [t('a','2026-11-03'),t('a','2026-11-01','active',true),t('a','2026-11-01','completed'),t('a','2026-11-01','trash')])assert.equal(blocked([x]),false);});
test('scratchpad uses nearest ancestor due date for undated descendants',()=>{assert.equal(blocked([t('p','2026-11-01','completed'),t('c','','active',false,'p')]),true);assert.equal(blocked([t('p','2026-11-03','completed'),t('c','','active',false,'p')]),false);});
