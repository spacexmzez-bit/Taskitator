// File: recurrence-ui.js
(function () {
    'use strict';
    const Core = window.TaskitatorRecurrence;
    const KEY = 'taskitator_recurrence_state';
    const empty = () => ({ series: [], history: [] });
    const state = () => JSON.parse(localStorage.getItem(KEY) || JSON.stringify(empty()));
    const tasks = () => window.TaskitatorApp?.getTasks() || JSON.parse(localStorage.getItem('taskitator_tasks') || '[]');
    const settings = () => JSON.parse(localStorage.getItem('taskitator_settings') || '{}');
    const today = () => Core.today(Date.now(), Number(settings().day_start_hour) || 0);
    function persist(snapshot) {
        const beforeState=localStorage.getItem(KEY),beforeTasks=localStorage.getItem('taskitator_tasks');
        try {
            localStorage.setItem(KEY,JSON.stringify(snapshot.recurrence_state));
            localStorage.setItem('taskitator_tasks',JSON.stringify(snapshot.tasks));
        } catch(err) {
            localStorage.removeItem(KEY);localStorage.removeItem('taskitator_tasks');
            if(beforeState!==null)localStorage.setItem(KEY,beforeState);
            if(beforeTasks!==null)localStorage.setItem('taskitator_tasks',beforeTasks);
            alert('Could not save recurring data. The previous saved copy was kept. If storage is full, reduce reference-file sizes or export a backup before cleaning old data.');
            throw err;
        }
    }
    function save(data, list = tasks()) {
        const result = Core.reconcile({ tasks: list, recurrence_state: data, settings: settings() });
        persist(result.snapshot);
        window.SyncEngine?.markLocalModified();
        window.TaskitatorApp?.loadStorage(); window.TaskitatorApp?.renderUnifiedView();
        window.dispatchEvent(new CustomEvent('taskitator-tasks-updated'));
    }
    function element(tag, text, parent) {
        const e = document.createElement(tag); if (text !== undefined) e.textContent = text;
        if (parent) parent.append(e); return e;
    }
    function button(text, parent, fn) {
        const e = element('button', text, parent); e.type = 'button'; e.className = 'icon-btn'; e.style.margin = '6px 4px 6px 0'; e.onclick = fn; return e;
    }
    function input(label, type, value, parent) {
        const wrap = element('label', label, parent); wrap.style.cssText = 'display:block;margin:12px 0;color:var(--text-color)';
        const e = element('input', undefined, wrap); e.type = type; e.value = value || ''; e.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px'; return e;
    }
    function dialog(title) {
        const d = document.createElement('dialog'); d.className = 'recurrence-dialog';
        d.style.cssText = 'width:min(90vw,560px);box-sizing:border-box;max-height:88vh;overflow:auto;background:var(--card-bg,#0f1d3a);color:var(--text-color,#fff);border:1px solid #456;border-radius:14px;padding:22px;z-index:20000';
        element('h2', title, d); button('Close', d, () => d.close()); d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); return d;
    }
    function scheduleForm(parent, initial = { kind: 'daily', start: today(), end: '' }, optional = false) {
        const label = element('label', 'Repeat', parent); label.style.display = 'block';
        const select = element('select', undefined, label); select.style.cssText = 'display:block;padding:9px;width:100%;margin:6px 0';
        const kinds = [['daily','Daily'],['weekdays','Selected weekdays'],['monthly','Monthly - start-date day'],['month_day','Date of month'],['half_yearly','Every six months'],['yearly','Yearly']];
        if (optional) kinds.unshift(['none','Does not repeat']);
        kinds.forEach(([value,text]) => { const o = element('option', text, select); o.value = value; }); select.value = optional ? 'none' : initial.kind;
        const box = element('div', undefined, parent);
        const start = input('Start date', 'date', initial.start, box), end = input('End date (optional)', 'date', initial.end, box);
        const day = input('Day of month (1-31)', 'number', initial.day || 1, box); day.min = '1'; day.max = '31';
        const weekdays = element('div', undefined, box); element('p','Repeat on these days:', weekdays);
        const checks = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((name, index) => {
            const label = element('label', name, weekdays); label.style.cssText = 'display:inline-flex;gap:4px;margin:7px';
            const cb = element('input', undefined, label); cb.type = 'checkbox'; cb.checked = (initial.weekdays || [1]).includes(index); return cb;
        });
        const change = () => { box.hidden = select.value === 'none'; day.parentElement.hidden = select.value !== 'month_day'; weekdays.hidden = select.value !== 'weekdays'; };
        select.onchange = change; change();
        return { get: () => select.value === 'none' ? null : Core.schedule({ kind: select.value, start: start.value, end: end.value, day: Number(day.value), weekdays: checks.flatMap((cb,i) => cb.checked ? [i] : []) }), reset: () => { select.value = 'none'; start.value = today(); end.value = ''; change(); } };
    }
    async function captureReferences(list, id) {
        for (const t of Core.subtree(list, id)) {
            if (!t.ai_locked || t.reference_inline_data) continue;
            const rec = await window.ExemplarStore?.getExemplar(t.id);
            if (rec?.inline_data) t.reference_inline_data = { inline_data: rec.inline_data };
        }
    }
    let createControl;
    async function attachCreated(id, list) {
        const config = createControl?.get(); if (!config) return;
        const session=localStorage.getItem('taskitator_session_id');
        await captureReferences(list, id);
        if(session!==localStorage.getItem('taskitator_session_id'))throw new Error('Account changed while preparing recurrence.');
        const data = state(); Core.start(list, data, id, config, 'repeat_' + crypto.randomUUID().replace(/-/g,''));
        persist({tasks:list,recurrence_state:data});
    }
    function validCreate(parentId) {
        const config = createControl?.get(); if (!config) return;
        if (parentId) {
            let p = tasks().find(t => t.id === parentId); const seen = new Set();
            while (p && !seen.has(p.id)) { seen.add(p.id); if (p.recurrence_series_id) throw new Error('This subtask uses its parent’s repeat schedule.'); p = tasks().find(t => t.id === p.parent_id); }
        }
    }
    function bindTask(id) {
        const form = document.getElementById('taskEditForm') || document.getElementById('taskDetailForm');
        const task = tasks().find(t => t.id === id); if (!task) return;
        let wrap = document.getElementById('recurrenceTaskControls');
        const parent = form || document.getElementById('taskDetailModal')?.querySelector('.modal-box'); if (!parent) return;
        if (!wrap) { wrap = element('div', undefined, parent); wrap.id = 'recurrenceTaskControls'; wrap.style.cssText='margin:16px 0;padding:12px;border:1px solid var(--border-color);border-radius:8px'; }
        const actions=document.getElementById('saveTaskDetailsBtn')?.parentElement;if(actions?.parentElement===parent)parent.insertBefore(wrap,actions);
        wrap.replaceChildren();
        const series = Core.seriesFor(state(), task);
        element('p', series ? (series.enabled ? 'Repeating branch: '+series.schedule.kind.replace(/_/g,' ') : 'Repetition stopped. You can still finish the current task.') : 'This task does not repeat.', wrap);
        button(series ? 'Recurrence & future criteria' : 'Set up recurrence', wrap, () => open(id));
        if (series) {
            const label = element('label', 'Apply ordinary task edits to:', wrap);
            const scope = element('select', undefined, label); scope.id = 'recurrenceEditScope'; scope.style.cssText='display:block;padding:8px;margin:6px 0;width:100%';
            [['one','This occurrence'],['future','This and future occurrences']].forEach(([v,t]) => { const o = element('option',t,scope);o.value=v; });
            element('small','Due-date changes apply to this occurrence. Use “Recurrence & future criteria” to change future dates or requirements.',wrap);
        }
    }
    async function applyEdit(task) {
        const data = state(), s = Core.seriesFor(data, task); if (!s) return;
        if (document.getElementById('recurrenceEditScope')?.value === 'future') {
            // Keep future-only validated criteria intact when ordinary fields are edited.
            const {title,raw_title,description,tags,priority_id,project_id,is_bonus,strict_prerequisites} = task;
            const fields={title,raw_title,description,tags,priority_id,project_id,is_bonus,strict_prerequisites};
            const node=s.nodes.find(n=>n.key===task.recurrence_node_id);
            if(task.ai_locked && !node.task.ai_locked){
                Object.assign(fields,{ai_locked:true,proof_criteria:task.proof_criteria,raw_proof_criteria:task.raw_proof_criteria});
                const ref=await window.ExemplarStore?.getExemplar(task.id);
                if(ref?.inline_data){data.reference_files ||= {};const key='ref_'+crypto.randomUUID().replace(/-/g,'');data.reference_files[key]={inline_data:ref.inline_data};task.reference_id=key;fields.reference_id=key;}
            }
            Core.updateNode(data,task,fields);
        }
        localStorage.setItem(KEY,JSON.stringify(data));
    }
    function open(id) {
        const list = tasks(), task = list.find(t => t.id === id); if (!task) return;
        const data = state(), s = Core.seriesFor(data, task);
        const d = dialog('Recurring task'); const feedback = element('p','',d); feedback.style.color='#ffbc65';
        if (!s) {
            const form = scheduleForm(d); button('Start repeating this branch',d,async () => {
                try { const config=form.get(); await captureReferences(list,id); Core.start(list,data,id,config,'repeat_'+crypto.randomUUID().replace(/-/g,'')); save(data,list);d.close();bindTask(id); } catch(e){feedback.textContent=e.message;}
            }); return;
        }
        const isRoot = s.current_root_id === id;
        element('p', isRoot ? 'This task and its subtasks repeat together.' : 'This subtask repeats with its parent. Complete the whole repeating task to start the next occurrence.',d);
        if (isRoot) {
            const form = scheduleForm(d,s.schedule);
            button('Save schedule for future occurrences',d,() => {
                try { s.schedule=form.get();save(data,list);d.close();bindTask(id); }catch(e){feedback.textContent=e.message;}
            });
            if (s.enabled) button('Stop future repetition',d,() => {
                if (!confirm('Stop future occurrences? The current task and its proof requirements stay active.')) return;
                s.enabled=false;s.stopped_reason='Stopped by user';save(data,list);d.close();bindTask(id);
            });
            else if (task.status==='active') button('Resume future repetition',d,() => {s.enabled=true;delete s.stopped_reason;save(data,list);d.close();bindTask(id);});
        }
        const node=s.nodes.find(n=>n.key===task.recurrence_node_id);
        if (task.ai_locked && node) {
            element('h3','Proof criteria - future occurrences only',d);
            const area=element('textarea',undefined,d);area.value=node.task.proof_criteria||'';area.rows=5;area.style.cssText='width:100%;box-sizing:border-box;padding:9px';
            element('p','Changes apply to future occurrences. Criteria must pass a new check with a score of at least 7/10.',d);
            const file=input('Replace future reference (optional, photo or PDF, up to 5 MB)','file','',d);file.accept='image/jpeg,image/png,image/webp,image/heic,application/pdf';
            const removeLabel=element('label','Remove future reference',d);const remove=element('input',undefined,removeLabel);remove.type='checkbox';
            const saveButton=button('Validate & save future criteria',d,async () => {
                const text=area.value.trim();if (!text || /\{[^}]+\}|\[[^\]]+\]/.test(text)){feedback.textContent='Enter concrete criteria with all placeholders filled in.';return;}
                const user=window.SyncEngine?.getConfig().username, session=localStorage.getItem('taskitator_session_id'), revision=localStorage.getItem('taskitator_local_revision');
                saveButton.disabled=true;
                try {
                    let exemplar=file.files[0]||null;
                    if (exemplar) {const check=TaskitatorEngine.AuditEngine.validateFile(exemplar);if(!check.valid)throw new Error(check.error);}
                    if (!exemplar && !remove.checked && (node.task.reference_inline_data || data.reference_files?.[node.task.reference_id])) {
                        const ref=(node.task.reference_inline_data || data.reference_files[node.task.reference_id]).inline_data;
                        const bytes=Uint8Array.from(atob(ref.data),c=>c.charCodeAt(0));exemplar=new File([bytes],'reference',{type:ref.mime_type});
                    }
                    const engine=TaskitatorEngine.AuditEngine;
                    // This is deliberately a fresh validation, including replacement reference content.
                    TaskitatorEngine._criteriaValidationCache.clear();
                    feedback.textContent='Validating future criteria…';
                    const result=await engine.validateCriteria(text,node.task.title,exemplar);
                    if(!result.success||!result.passed||result.score<7)throw new Error(result.error||result.critique||'Criteria must score at least 7/10.');
                    if (user!==window.SyncEngine?.getConfig().username || session!==localStorage.getItem('taskitator_session_id') || revision!==localStorage.getItem('taskitator_local_revision')) throw new Error('Account or tasks changed during validation. Reopen this dialog and try again.');
                    node.task.proof_criteria=text;node.task.raw_proof_criteria=text;
                    if(remove.checked){delete node.task.reference_inline_data;delete node.task.reference_id;}
                    if(file.files[0]){data.reference_files ||= {};const refId='ref_'+crypto.randomUUID().replace(/-/g,'');data.reference_files[refId]=await engine.fileToBase64(file.files[0]);node.task.reference_id=refId;delete node.task.reference_inline_data;}
                    if (user!==window.SyncEngine?.getConfig().username || session!==localStorage.getItem('taskitator_session_id') || revision!==localStorage.getItem('taskitator_local_revision')) throw new Error('Account or tasks changed. Reopen this dialog.');
                    save(data,list);feedback.textContent='Validated '+result.score+'/10. Saved for future occurrences. Current criteria unchanged.';
                }catch(e){feedback.textContent=e.message;}finally{saveButton.disabled=false;}
            });
        }
    }
    function overview() {
        const d=dialog('Recurring tasks & history'),data=state();
        if(!data.series.length)element('p','Open a task’s details to set up recurrence, or choose Repeat when creating a task.',d);
        for(const s of data.series){const root=tasks().find(t=>t.id===s.current_root_id);element('h3',root?.title||s.nodes[0]?.task.title||'Recurring task',d);element('p',(s.enabled?'Repeating':'Stopped')+' · '+s.schedule.kind.replace(/_/g,' ')+' · Current date: '+s.current_date,d);if(root)button('Manage branch',d,()=>{d.close();open(root.id);});}
        element('h3','Occurrence history (latest 500)',d);
        for(const h of [...data.history].reverse()){element('p',h.title+' · '+h.due_date+' · '+h.outcome+' · '+new Date(h.ended_at).toLocaleString(),d);}
        if(!data.history.length)element('p','No recurring-task history yet.',d);
    }
    window.addEventListener('taskitator-auth-ready',()=>{
        const form=document.getElementById('taskCreateForm');if(form){const wrap=element('fieldset',undefined,form);wrap.style.cssText='margin:14px 0;border:1px solid var(--border-color);border-radius:8px;padding:12px';element('legend','Recurrence',wrap);const actions=document.getElementById('submitTaskCreateBtn')?.parentElement;if(actions?.parentElement===form)form.insertBefore(wrap,actions);createControl=scheduleForm(wrap,undefined,true);}
        const nav=document.querySelector('.sidebar nav')||document.querySelector('nav');if(nav)button('↻ Recurring tasks',nav,overview);
    });
    window.TaskitatorRecurrenceUI={state,save,persist,attachCreated,validCreate,bindTask,applyEdit,resetCreate:()=>createControl?.reset(),overview};
})();
