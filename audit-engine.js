// File: audit-engine.js
/**
 * audit-engine.js
 * Taskitator Core Engine
 * Manages BYOK Gemini Verification Cascade, Multimodal Pre-Flight Criteria Validation,
 * Emergency Bypass Tokens, and Break Limits
 */

const TaskitatorEngine = {
    STORAGE_KEY_SETTINGS: 'taskitator_settings',
    STORAGE_KEY_EMERGENCY: 'taskitator_emergency_state',
    STORAGE_KEY_BREAKS: 'taskitator_daily_breaks',

    PRIMARY_MODEL: 'gemini-3.5-flash-lite',
    FALLBACK_MODEL: 'gemini-3.1-flash-lite',

    // Enforced upload limit across files (Photos, Gallery, PDFs)
    MAX_FILE_SIZE_MB: 5,

    // In-memory cache for pre-flight criteria validations to prevent duplicate API hits
    _criteriaValidationCache: new Map(),

    // =========================================================================
    // 1. Break Engine (10m Floating Window, Day-Start Offset, 6h Cutoff Buffer)
    // =========================================================================
    BreakEngine: {
        PLANNING_WINDOW_MS:600000,
        core(){if(!globalThis.TaskitatorBreaks)throw new Error('Refresh Taskitator to load break scheduling.');return globalThis.TaskitatorBreaks;},
        settings(){try{return JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS)||'{}');}catch{return {}; }},
        getDayStartHour(){return Math.max(0,Math.min(4,Number(this.settings().day_start_hour)||0));},
        getLogicalDayBounds(dayStartHour=null){
            const settings=this.settings();if(dayStartHour!==null)settings.day_start_hour=dayStartHour;
            const raw=this.getAllBreakData(),now=Date.now();
            const pinned=Object.values(raw).find(r=>r.cycle_start<=now&&now<r.cycle_end);
            return this.core().bounds({...settings,day_start_hour:pinned?.day_start_hour??settings.day_start_hour},now,pinned?.timezone||settings.break_timezone||Intl.DateTimeFormat().resolvedOptions().timeZone);
        },
        getAllBreakData(){try{
            const key=TaskitatorEngine.STORAGE_KEY_BREAKS,raw=localStorage.getItem(key)||'{}',settings=this.settings();
            const data=this.core().migrate(JSON.parse(raw),settings,settings.break_timezone||Intl.DateTimeFormat().resolvedOptions().timeZone);
            const normalized=JSON.stringify(data);
            if(raw!==normalized){localStorage.setItem(key,normalized);if(window.SyncEngine?.isConfigured?.())window.SyncEngine.markLocalModified();}
            return data;
        }catch{return {}; }},
        getBreakRecord(date){return {date,window_started_at:null,locked:false,breaks:[],...this.getAllBreakData()[date]};},
        saveBreakRecord(date,record){
            const data=this.getAllBreakData(),settings=this.settings(),b=this.getLogicalDayBounds();
            const previous=data[date];
            data[date]={...record,date,timezone:record.timezone||b.timezone,day_start_hour:b.dayStartHour,cycle_start:+b.start,cycle_end:+b.end};
            const value=JSON.stringify(this.core().normalize(data));
            if(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_BREAKS)!==value){
                localStorage.setItem(TaskitatorEngine.STORAGE_KEY_BREAKS,value);
                if(window.SyncEngine?.isConfigured?.())window.SyncEngine.markLocalModified();
                window.dispatchEvent?.(new CustomEvent('taskitator-breaks-changed'));
                if(window.SyncEngine?.isConfigured?.() && (previous?.window_started_at!==record.window_started_at||previous?.locked!==record.locked))
                    Promise.resolve().then(()=>window.SyncEngine.push()).catch(()=>{});
            }
        },
        getPlanningStatus(){
            const bounds=this.getLogicalDayBounds(),record=this.getBreakRecord(bounds.dateStr),now=Date.now();
            const expired=record.window_started_at&&now-record.window_started_at>=this.PLANNING_WINDOW_MS;
            const valid=this.core().validate(record.breaks,bounds);
            if((expired||record.locked)&&!valid.valid){
                if(!record.repair_required||record.locked){record.repair_required=true;record.locked=false;this.saveBreakRecord(bounds.dateStr,record);}
            }else if(expired&&!record.locked){record.locked=true;this.saveBreakRecord(bounds.dateStr,record);}
            const repair=!!record.repair_required&&!valid.valid;
            const running=!!record.window_started_at&&!expired&&!record.locked;
            const buffer=now>=+bounds.cutoff6h;
            return {bounds,record,isRepair:repair,isRunning:running,isLocked:record.locked,isInBuffer:buffer&&!repair,
                canStart:!record.window_started_at&&!record.locked&&!buffer&&!repair,canEdit:running||repair,
                remainingWindowMs:running?Math.max(0,this.PLANNING_WINDOW_MS-(now-record.window_started_at)):0,
                reason:repair?'The planning window ended without a valid schedule. Enter valid breaks once to repair and lock it.':
                    record.locked?'The break schedule is locked until the next day cycle.':buffer?'Planning is closed during the final 6 hours of this cycle.':''};
        },
        startPlanningWindow(){const s=this.getPlanningStatus();if(!s.canStart)return {success:false,error:s.reason};
            s.record.window_started_at=Date.now();s.record.locked=false;this.saveBreakRecord(s.bounds.dateStr,s.record);return {success:true,record:s.record};},
        lockTodayBreaks(){const s=this.getPlanningStatus();const result=this.core().validate(s.record.breaks,s.bounds);if(!result.valid)return {success:false,error:result.error};s.record.locked=true;this.saveBreakRecord(s.bounds.dateStr,s.record);return {success:true,record:s.record};},
        isSelectionWindowOpen(){const s=this.getPlanningStatus();return s.canStart||s.canEdit;},
        getTodayBreaks(){const b=this.getLogicalDayBounds();return this.getBreakRecord(b.dateStr).breaks;},
        getBreakTimestamps(b,bounds){return this.core().interval(b,bounds);},
        saveTodayBreaks(list,lockImmediately=false){
            const status=this.getPlanningStatus();if(status.isLocked||!status.canEdit)return {valid:false,error:status.reason||'Start the planning window first.'};
            const result=this.core().validate(list,status.bounds);if(!result.valid)return result;
            status.record.breaks=result.breaks;status.record.locked=!!lockImmediately||status.isRepair;status.record.repair_required=false;
            this.saveBreakRecord(status.bounds.dateStr,status.record);return {valid:true,record:status.record};
        },
        getActiveBreak(){return this.core().activeBreak(this.getAllBreakData(),{...this.settings(),break_timezone:this.getLogicalDayBounds().timezone});},
        isCurrentlyOnBreak(){return !!this.getActiveBreak();}
    },

    // =========================================================================
    // 2. Emergency Manager (4 Uses Per Cycle, 15m Unlock Window)
    // =========================================================================
    EmergencyManager: {
        getState() {
            let state = {};
            try {
                state = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_EMERGENCY) || '{}');
            } catch (e) {
                state = {};
            }

            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }

            const weekendEnd = settings.weekend_end !== undefined ? Number(settings.weekend_end) : 6;
            const now = new Date();
            const currentCycleId = this.getCycleIdentifier(now, weekendEnd);

            if (!state.server_managed && (!state.cycle_id || state.cycle_id !== currentCycleId)) {
                state = {
                    cycle_id: currentCycleId,
                    uses_left: 4,
                    active_until: null
                };
                localStorage.setItem(TaskitatorEngine.STORAGE_KEY_EMERGENCY, JSON.stringify(state));
            }

            if(!state.server_managed)state.active_until=null;
            return state;
        },

        getCycleIdentifier(date, weekendEndDay) {
            const resetDay = (weekendEndDay + 1) % 7;
            const d = new Date(date);
            const day = d.getDay();
            const diff = (day < resetDay) ? (7 - resetDay + day) : (day - resetDay);
            d.setDate(d.getDate() - diff);
            return `${d.getFullYear()}-W${Math.ceil((d.getDate() + (6 - d.getDay())) / 7)}-start-${d.toISOString().split('T')[0]}`;
        },

        isBypassActive() {
            const state = this.getState();
            if (!state.active_until) return false;
            return new Date().getTime() < new Date(state.active_until).getTime();
        },

        getRemainingWindowSeconds() {
            const state = this.getState();
            if (!state.active_until) return 0;
            const diff = Math.floor((new Date(state.active_until).getTime() - new Date().getTime()) / 1000);
            return diff > 0 ? diff : 0;
        },

        async activateBypass() {
            try { return await window.TaskitatorPro.activateBypass(); }
            catch(error) { return {success:false,error:error.message}; }
        }
    },

    // =========================================================================
    // 3. AI Verification Cascade (Forensic Auditor & Failover)
    // =========================================================================
    AuditEngine: {
        selection(){return window.TaskitatorVault?.selection?.()||{provider:'gemini',primary:TaskitatorEngine.PRIMARY_MODEL,fallback:TaskitatorEngine.FALLBACK_MODEL};},
        validateFile(file, maxMb = TaskitatorEngine.MAX_FILE_SIZE_MB) {
            if (!file) {
                return { valid: false, error: 'No file attached.' };
            }

            const maxBytes = maxMb * 1024 * 1024;
            if (file.size > maxBytes) {
                return {
                    valid: false,
                    error: `File size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds the ${maxMb} MB upload limit.`
                };
            }

            const allowedTypes = [
                'image/jpeg',
                'image/png',
                'image/webp',
                'image/heic',
                'application/pdf'
            ];

            const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
            const isAllowed = allowedTypes.includes(file.type) || isPdf;

            if (!isAllowed) {
                return { valid: false, error: 'Unsupported file type. Please upload a photo (JPG, PNG, WebP) or PDF document.' };
            }

            return { valid: true };
        },

        async fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const base64Data = reader.result.split(',')[1];
                    let mimeType = file.type || 'image/jpeg';
                    if (file.name.toLowerCase().endsWith('.pdf')) {
                        mimeType = 'application/pdf';
                    }
                    resolve({
                        inline_data: {
                            data: base64Data,
                            mime_type: mimeType
                        }
                    });
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        },

        async callGeminiWithParts(modelName, apiKey, partsArray, format='proof', selection=this.selection()) {
            const payload = {
                taskitatorFormat:format,
                contents: [{
                    // Older saved exemplars contain the blob fields directly.
                    // Gemini requires those fields inside an inline_data Part.
                    parts: partsArray.map(part => {
                        if (part && !part.inline_data && !part.inlineData &&
                            typeof part.mime_type === 'string' && typeof part.data === 'string') {
                            return { inline_data: { mime_type: part.mime_type, data: part.data } };
                        }
                        return part;
                    })
                }],
                generationConfig: {
                    temperature: 0.1,
                    responseMimeType: 'application/json'
                }
            };

            return await window.TaskitatorVault.generate(modelName,payload,selection);
        },

        async callGemini(modelName, apiKey, inlineDataPart, promptText) {
            return await this.callGeminiWithParts(modelName, apiKey, [{ text: promptText }, inlineDataPart]);
        },

        async callGeminiTextOnly(modelName, apiKey, promptText) {
            return await this.callGeminiWithParts(modelName, apiKey, [{ text: promptText }]);
        },

        async validateCriteria(criteriaText, taskTitle = '', exemplarFile = null) {
            const selection=this.selection();
            const trimmedCriteria = (criteriaText || '').trim();
            const trimmedTitle = (taskTitle || '').trim();

            if (!trimmedCriteria) {
                return {
                    success: false,
                    score: 0,
                    passed: false,
                    critique: 'Proof criteria cannot be empty.',
                    suggested_rewrite: ''
                };
            }

            const fileSignature = exemplarFile ? `${exemplarFile.name}_${exemplarFile.size}` : 'nofile';
            const cacheKey = `${selection.provider}:${selection.keyVersion||''}:::${trimmedTitle}:::${trimmedCriteria}:::${fileSignature}`;
            if (TaskitatorEngine._criteriaValidationCache.has(cacheKey)) {
                return TaskitatorEngine._criteriaValidationCache.get(cacheKey);
            }

            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem(TaskitatorEngine.STORAGE_KEY_SETTINGS) || '{}');
            } catch (e) {
                settings = {};
            }

            const apiKey = Boolean(window.TaskitatorVault?.available);
            if (!apiKey) {
                return {
                    success: false,
                    error: 'Save a key for the active AI provider in Settings → Account.'
                };
            }

            let inlineExemplarPart = null;
            if (exemplarFile) {
                const check = this.validateFile(exemplarFile, TaskitatorEngine.MAX_FILE_SIZE_MB);
                if (!check.valid) {
                    return { success: false, error: check.error };
                }
                inlineExemplarPart = await this.fileToBase64(exemplarFile);
            }

            let prompt = `You are a forensic proof auditor for a task execution system.
Evaluate whether this task acceptance criterion can be objectively verified using submitted evidence.

TASK TITLE: "${trimmedTitle || 'Untitled Task'}"
PROPOSED CRITERIA: "${trimmedCriteria}"

Evaluation Rules:
1. Objectivity: Does it require a tangible, visual artifact (e.g., handwritten page with date, terminal output diff, completed checklist, cleared workspace)?
2. Disqualify Subjective Action: Strongly penalize unprovable internal states ("read", "understand", "study", "learn", "plan") unless tied to an explicit physical proof artifact.
3. Ambiguity: Reject criteria with vague or non-falsifiable boundaries.
4. Pass Threshold: Score on a strict 1 to 10 scale. A score >= 7 means acceptable for automated AI audit.`;

            if (inlineExemplarPart) {
                prompt += `
5. MANDATORY REFERENCE CROSS-CHECK: An exemplar reference document/image is attached. You MUST inspect whether the PROPOSED CRITERIA explicitly mentions, explains, and references this attachment (e.g. how the submitted proof must match or follow this exemplar). If an exemplar is attached without direct explanatory context in the text, you MUST rate the criteria below 7/10 and reject it.`;
            }

            prompt += `

Return strictly valid JSON with this exact schema:
{
  "score": <integer 1 to 10>,
  "passed": <boolean, true if score >= 7, false otherwise>,
  "critique": "<maximum 15 words explaining the flaw or confirming validity>",
  "suggested_rewrite": "<a concrete, artifact-based rewrite if score < 7, else empty string>"
}`;

            const parts = [{ text: prompt }];
            if (inlineExemplarPart) {
                parts.push(inlineExemplarPart);
            }

            try {
                let usedModel = selection.primary;
                let res = await this.callGeminiWithParts(usedModel, apiKey, parts, 'criteria', selection);

                if (selection.fallback && (res.status === 429 || res.status === 503)) {
                    console.warn(`[AuditEngine] Model ${usedModel} hit ${res.status}. Cascading to ${TaskitatorEngine.FALLBACK_MODEL}...`);
                    usedModel = selection.fallback;
                    res = await this.callGeminiWithParts(usedModel, apiKey, parts, 'criteria', selection);
                }

                if (!res.ok) {
                    const errJson = await res.json().catch(() => ({}));
                    return {
                        success: false,
                        status: res.status,
                        code: res.status,
                        error: errJson.error?.message || `Gemini API HTTP ${res.status}`
                    };
                }

                const data = await res.json();
                let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
                rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

                const parsed = JSON.parse(rawText);
                const score = typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5;
                const passed = parsed.passed !== undefined ? Boolean(parsed.passed) : score >= 7;

                const result = {
                    success: true,
                    score,
                    passed,
                    critique: String(parsed.critique || '').slice(0, 120),
                    suggested_rewrite: String(parsed.suggested_rewrite || '').slice(0, 300),
                    model_used: usedModel
                };

                TaskitatorEngine._criteriaValidationCache.set(cacheKey, result);
                return result;
            } catch (err) {
                return {
                    success: false,
                    status: 0,
                    error: `Validation parsing error: ${err.message}`
                };
            }
        },

        async verifyProof({ taskId, file, files, taskTitle, criteria, userContext, exemplarPart = null }) {
            const fileList = Array.isArray(files) && files.length ? files : (file ? [file] : []);
            if (fileList.length > 5) {
                return { success: false, status: 400, error: 'Maximum 5 evidence files allowed per task.' };
            }

            // Taskitator Pro Hosted Claude Haiku 5.5 Hook (when active Pro & not in BYOK mode)
            if (window.TaskitatorPro) {
                let hostedSelected = false;
                try {
                    const proStatus = await window.TaskitatorPro.getStatus();
                    hostedSelected = proStatus && proStatus.isPro && !proStatus.use_byok;
                    if (proStatus && proStatus.isPro && !proStatus.use_byok) {
                        const encodedFiles = [];
                        for (const f of fileList) {
                            const check = this.validateFile(f, TaskitatorEngine.MAX_FILE_SIZE_MB);
                            if (!check.valid) return { success: false, status: 400, error: check.error };
                            const part = await this.fileToBase64(f);
                            encodedFiles.push({
                                mimeType: part.inline_data.mime_type,
                                data: part.inline_data.data
                            });
                        }
                        const combinedCriteria = (criteria || '') + (userContext ? (' - Note: ' + userContext) : '');
                        const proRes = await window.TaskitatorPro.reviewProof({
                            taskId: taskId || ('task_' + Date.now()),
                            title: taskTitle,
                            criteria: combinedCriteria,
                            files: encodedFiles,
                            exemplar: exemplarPart ? {mime_type:(exemplarPart.inline_data || exemplarPart).mime_type, data:(exemplarPart.inline_data || exemplarPart).data} : null
                        });
                        return {
                            success: true,
                            approved: proRes.verdict === 'approved',
                            verdict: proRes.verdict,
                            confidence: proRes.confidence,
                            critique: proRes.critique,
                            job_id:proRes.job_id,
                            model_used: proRes.model_used || 'claude-haiku-5-5'
                        };
                    }
                } catch (proErr) {
                    return {success:false,status:proErr.status||503,error:proErr.message};
                }
            }
            try {
                const encoded=[];
                for(const f of fileList){
                    const check=this.validateFile(f);if(!check.valid)return {success:false,status:400,error:check.error};
                    const part=(await this.fileToBase64(f)).inline_data;encoded.push({mime_type:part.mime_type,data:part.data});
                }
                const result=await window.TaskitatorPro.personalReview({task_id:taskId,files:encoded});
                return {success:true,approved:result.verdict==='approved',...result};
            } catch(error){return {success:false,status:error.status||0,error:error.message};}

        }
    }
};

window.TaskitatorEngine = TaskitatorEngine;
