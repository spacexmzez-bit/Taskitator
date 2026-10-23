import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import './break-core.js';
import {evaluateStatus} from '../cloudflare/worker.js';
const B=globalThis.TaskitatorBreaks;
const source=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
function browser(time='2026-10-23T12:00:00Z',zone='Europe/London'){
    let now=Date.parse(time),dirty=0,pushes=0;const values=new Map();
    const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v))};
    storage.setItem('taskitator_settings',JSON.stringify({break_timezone:zone,day_start_hour:0}));
    class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
    const window={dispatchEvent(){},addEventListener(){},SyncEngine:{isConfigured:()=>true,markLocalModified:()=>dirty++,push:async()=>{pushes++;}}};
    const context=vm.createContext({window,localStorage:storage,Date:Clock,Intl,console,CustomEvent:class{},setTimeout,clearTimeout});
    vm.runInContext(source('pro/break-core.js'),context);vm.runInContext(source('audit-engine.js'),context);
    context.TaskitatorEngine=window.TaskitatorEngine;
    return {context,window,storage,values,engine:window.TaskitatorEngine.BreakEngine,advance:ms=>{now+=ms},dirty:()=>dirty,pushes:()=>pushes};
}

test('browser and Worker agree outside Riyadh, accept seconds, and use the same exclusive end',()=>{
    for(const zone of ['America/New_York','Asia/Tokyo','Europe/London']){
        const b=B.bounds({},Date.parse('2026-10-23T12:00:00Z'),zone);
        const valid=B.validate([{start:'14:00:00',end:'15:00:00'}],b);assert.equal(valid.valid,true);
        const record={timezone:zone,day_start_hour:0,breaks:valid.breaks};
        const snapshot={tasks:[{status:'active',due_date:'today'}],settings:{},today_breaks:{[b.dateStr]:record}};
        const start=Date.parse(valid.breaks[0].start_at),end=Date.parse(valid.breaks[0].end_at);
        assert.equal(evaluateStatus(snapshot,start).in_break,true,zone);assert.equal(evaluateStatus(snapshot,end-1).in_break,true);
        assert.equal(evaluateStatus(snapshot,end).in_break,false);
    }
});

test('midnight-crossing breaks total 60 minutes and remain active after the date changes',()=>{
    const bounds=B.bounds({},Date.parse('2026-10-23T12:00:00Z'),'Europe/London');
    const result=B.validate([{start:'23:30',end:'00:30'}],bounds);assert.equal(result.valid,true);assert.equal(result.totalMinutes,60);
    const data={[bounds.dateStr]:{timezone:'Europe/London',breaks:result.breaks}};
    assert.equal(B.active(data,{},Date.parse(result.breaks[0].start_at)+45*60000),true);
});

test('invalid, incomplete, overlapping and oversized break schedules are rejected without saving',()=>{
    const f=browser();assert.equal(f.engine.startPlanningWindow().success,true);
    for(const list of [[],[{start:'',end:''}],[{start:'12:00',end:''}],[{start:'14:00',end:'13:00'}],
        [{start:'10:00',end:'12:00'},{start:'11:00',end:'12:00'}],[{start:'10:00',end:'13:01'}],Array.from({length:4},()=>({start:'10:00',end:'10:10'}))]){
        assert.equal(f.engine.saveTodayBreaks(list,true).valid,false);
        assert.equal(f.engine.getPlanningStatus().isLocked,false);
    }
});

test('expiry seals the last valid schedule even if newer draft rows are invalid',()=>{
    const f=browser();f.engine.startPlanningWindow();assert.equal(f.engine.saveTodayBreaks([{start:'14:00',end:'14:30'}]).valid,true);
    assert.equal(f.engine.saveTodayBreaks([{start:'14:00',end:''}]).valid,false);
    f.advance(600001);const s=f.engine.getPlanningStatus();assert.equal(s.isLocked,true);assert.equal(s.record.breaks.length,1);
    assert.equal(s.record.breaks[0].end,'14:30');assert.ok(f.dirty()>=3);
});

test('empty expiry and old empty lockouts permit one valid repair without restarting the planning timer',()=>{
    const f=browser();f.engine.startPlanningWindow();const original=f.engine.getPlanningStatus().record.window_started_at;
    f.advance(600001);let s=f.engine.getPlanningStatus();assert.equal(s.isRepair,true);assert.equal(s.canEdit,true);assert.equal(s.canStart,false);
    assert.equal(f.engine.saveTodayBreaks([],true).valid,false);
    assert.equal(f.engine.saveTodayBreaks([{start:'14:00',end:'14:30'}],true).valid,true);
    s=f.engine.getPlanningStatus();assert.equal(s.isLocked,true);assert.equal(s.record.window_started_at,original);
    const other=browser();const b=other.engine.getLogicalDayBounds();
    other.storage.setItem('taskitator_daily_breaks',JSON.stringify({[b.dateStr]:{locked:true,breaks:[]}}));
    assert.equal(other.engine.getPlanningStatus().isRepair,true);
});

test('planning start and background expiry mark data dirty and trigger a sync push',async()=>{
    const f=browser();f.engine.startPlanningWindow();await Promise.resolve();assert.equal(f.pushes(),1);
    f.engine.saveTodayBreaks([{start:'14:00',end:'14:30'}]);f.advance(600001);f.engine.getPlanningStatus();
    await Promise.resolve();assert.equal(f.pushes(),2);
});

test('history pruning is bounded, accepts legacy arrays and ignores malformed dates',()=>{
    const now=Date.parse('2026-10-23T12:00:00Z'),raw={};
    for(let i=0;i<300;i++)raw[new Date(now-i*86400000).toISOString().slice(0,10)]={breaks:[]};
    raw['2026-99-99']={breaks:[]};assert.equal(Object.keys(B.normalize(raw,null,now)).length,91);
    assert.equal(B.normalize([{start:'14:00',end:'15:00'}],'2026-10-23',now)['2026-10-23'].breaks.length,1);
});

test('multi-device merging preserves the original timer, timezone and locked schedule',()=>{
    const now=Date.parse('2026-10-23T12:00:00Z'),date='2026-10-23';
    const original={[date]:{window_started_at:now-300000,timezone:'America/New_York',day_start_hour:0,locked:false,breaks:[{start:'14:00',end:'14:30'}]}};
    let merged=B.merge(original,{[date]:{window_started_at:now,timezone:'Asia/Tokyo',locked:false,breaks:[{start:'15:00',end:'15:30'}]}},{},now);
    assert.equal(merged[date].window_started_at,now-300000);assert.equal(merged[date].timezone,'America/New_York');
    merged[date].locked=true;
    const locked=B.merge(merged,{[date]:{window_started_at:now,timezone:'Asia/Tokyo',locked:false,breaks:[]}},{},now+10000);
    assert.deepEqual(locked[date],merged[date]);
});

test('DST gaps reject nonexistent times and valid dates use the correct timezone offset',()=>{
    const b=B.bounds({},Date.parse('2026-03-08T12:00:00Z'),'America/New_York');
    assert.equal(B.validate([{start:'02:15',end:'02:45'}],b).valid,false);
    const valid=B.validate([{start:'03:15',end:'03:45'}],b);assert.equal(valid.valid,true);
    assert.equal(valid.breaks[0].start_at,'2026-03-08T07:15:00.000Z');
});

test('statistics executes against dictionary breaks and counts an overnight break correctly',()=>{
    const f=browser();f.engine.startPlanningWindow();f.engine.saveTodayBreaks([{start:'23:30',end:'00:30'}],true);
    const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',style:{},innerHTML:'',appendChild(){},addEventListener(){}});return nodes.get(id)};
    f.context.navigator={};
    f.context.document={getElementById:node,createElement:()=>({style:{},appendChild(){},querySelector:()=>({addEventListener(){}}),replaceChildren(){}})};
    f.context.TaskitatorRecurrenceUI={state:()=>({history:[]})};
    f.context.TaskitatorSafety={escapeHtml:String,setProjectLabel(){}};
    const html=source('stats.html'),code=html.match(/<script type="text\/taskitator-script">([\s\S]*?)<\/script>/)[1];
    vm.runInContext(code+'\nrenderStats();',f.context);
    assert.equal(node('breakSlotsCount').textContent,'1 break window configured');assert.equal(node('totalBreakTime').textContent,'60m');
});

test('closing the planner keeps the countdown and the status pill remains visible outside Today',()=>{
    const f=browser(),code=source('app.js'),start=code.indexOf('    const BreakUI = {'),end=code.indexOf('\n    };',start)+7;
    let hidden=false,intervals=0;
    f.context.currentView='all';f.context.setInterval=()=>{intervals++;return intervals};f.context.clearInterval=()=>{throw Error('Closing must not cancel the deadline');};
    f.context.saveStorageAndPush=()=>{};f.context.getTodayBreaksSafe=()=>[];f.context.SoundFX={};
    vm.runInContext(code.slice(start,end)+'\nglobalThis.testBreakUI=BreakUI;',f.context);
    const ui=f.context.testBreakUI;ui.captureDraft=()=>{};ui.planningTimerInterval=123;ui.modal={classList:{remove:()=>{hidden=true}}};
    ui.closeModal();assert.equal(hidden,true);assert.equal(ui.planningTimerInterval,123);
    ui.pill={style:{},classList:{add(){}}};ui.pillText={};ui.pillIcon={};ui.updateStatusPill();
    assert.equal(ui.pill.style.display,'inline-flex');
});

test('Ari stats context reports the current dictionary break count',async()=>{
    const f=browser();f.engine.startPlanningWindow();f.engine.saveTodayBreaks([{start:'14:00',end:'14:30'}],true);
    f.window.location={pathname:'/stats.html'};f.context.document={readyState:'loading'};
    f.context.sessionStorage={getItem:()=>null,setItem(){},removeItem(){}};
    f.context.fetch=async()=>new Response('<!-- taskitator-system-prompt:v1 --> Taskitator Focus Copilot');
    let prompt='';f.window.TaskitatorVault={available:true,selection:()=>({provider:'gemini',primary:'gemini-3.5-flash-lite'}),generate:async(model,payload)=>{
        prompt=payload.systemInstruction.parts[0].text;
        return Response.json({candidates:[{content:{parts:[{text:'One break'}]}}]});
    }};
    vm.runInContext(source('agent-engine.js'),f.context);
    await f.window.TaskitatorAgent.sendMessage('How many breaks?');
    assert.match(prompt,/Scheduled Breaks Today: 1/);assert.doesNotMatch(prompt,/Scheduled Breaks Today: undefined/);
});

test('draft schedules become active only when confirmed or when their planning deadline expires',()=>{
    const f=browser('2026-10-23T12:00:00Z','Europe/London');f.engine.startPlanningWindow();
    f.engine.saveTodayBreaks([{start:'13:00',end:'13:30'}]);
    assert.equal(f.engine.isCurrentlyOnBreak(),false);
    f.advance(600001);assert.equal(f.engine.isCurrentlyOnBreak(),true);
});

test('legacy local schedules gain explicit timezone timestamps before uploading',()=>{
    const f=browser('2026-10-23T12:00:00Z','America/New_York');
    f.storage.setItem('taskitator_daily_breaks',JSON.stringify({'2026-10-23':{locked:true,breaks:[{start:'14:00',end:'14:30'}]}}));
    const record=f.engine.getAllBreakData()['2026-10-23'];assert.equal(record.timezone,'America/New_York');
    assert.equal(record.breaks[0].start_at,'2026-10-23T18:00:00.000Z');
    assert.equal(B.active(JSON.parse(f.storage.getItem('taskitator_daily_breaks')),{},Date.parse('2026-10-23T18:00:00Z')),true);
});

test('a cycle beginning in the spring DST gap starts at the next valid clock time',()=>{
    const b=B.bounds({day_start_hour:2},Date.parse('2026-03-08T12:00:00Z'),'America/New_York');
    assert.equal(b.start.toISOString(),'2026-03-08T07:00:00.000Z');assert.equal(b.end.toISOString(),'2026-03-09T06:00:00.000Z');
});

test('the break pill counts down a previous-cycle break after midnight',()=>{
    const f=browser('2026-10-23T12:00:00Z','Europe/London');f.engine.startPlanningWindow();f.engine.saveTodayBreaks([{start:'23:30',end:'00:30'}],true);
    f.advance(Date.parse('2026-10-23T23:00:00Z')-Date.parse('2026-10-23T12:00:00Z'));
    assert.equal(f.engine.getTodayBreaks().length,0);assert.ok(f.engine.getActiveBreak());
    const code=source('app.js'),start=code.indexOf('    const BreakUI = {'),end=code.indexOf('\n    };',start)+7;
    f.context.currentView='all';f.context.getTodayBreaksSafe=()=>[];
    vm.runInContext(code.slice(start,end)+'\nglobalThis.testBreakUI=BreakUI;',f.context);
    const ui=f.context.testBreakUI;ui.pill={style:{},classList:{add(){}}};ui.pillText={};ui.pillIcon={};ui.updateStatusPill();
    assert.equal(ui.pillText.textContent,'30m left');
});
