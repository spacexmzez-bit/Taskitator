import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const esc=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const inline=text=>esc(text).replace(/https:\/\/[^\s<]+/g,url=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
const css=fs.readFileSync(root+'/PHASE-2-SETUP.html','utf8').match(/<style>([\s\S]*?)<\/style>/)[1]+`
@media(max-width:760px){aside nav,aside .nav-label{display:block}aside nav{display:grid;grid-template-columns:1fr 1fr;gap:4px}aside nav a{font-size:11px}.sidebar-foot{display:none}}
.step .number{display:grid;place-items:center;flex-shrink:0;width:30px;height:30px;border:1px solid #cbdde0;background:#f5faf9;border-radius:9px;font-size:12px;font-weight:800}.overview-table{overflow-x:auto}.route a{font-weight:650}
`;
const lines=fs.readFileSync(root+'/PHASE-3-SETUP.txt','utf8').split('\n');
const sections=[];let current={id:'overview',letter:'◎',title:'The short version',lines:[]};
const titles={A:'Keep your existing security setup',B:'Upload and deploy',C:'Continue with Gemini',D:'Get a Claude API key',E:'Save, test and switch',F:'Check the app and policy links',G:'Fix a setup problem',H:'Limits and sources'};
for(let i=2;i<lines.length;i++){
    if(lines[i].trim() && /^-{3,}$/.test(lines[i+1]||'')){
        sections.push(current);const letter=lines[i][0];current={id:'section-'+letter.toLowerCase(),letter,title:titles[letter]||lines[i],lines:[]};i++;
    }else current.lines.push(lines[i]);
}sections.push(current);
function blocks(lines){
    let result='';
    for(let i=0;i<lines.length;){
        if(!lines[i].trim()){i++;continue;}
        const match=lines[i].match(/^(\d+)\. (.*)/),text=[match?match[2]:lines[i]];i++;
        while(i<lines.length && lines[i].trim() && !/^\d+\. /.test(lines[i]))text.push(lines[i++].trim());
        result+=match?`<div class="step"><span class="number">${match[1]}</span><p>${inline(text.join(' '))}</p></div>`:`<p class="paragraph">${inline(text.join(' '))}</p>`;
    }
    return result;
}
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; script-src-attr 'none'; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>Taskitator Phase 3 · Gemini and Claude setup</title><style>${css}</style></head><body><a class="skip" href="#main">Skip to instructions</a><div class="layout"><aside><div class="brand"><span class="mark" aria-hidden="true">✓</span>Taskitator</div><p class="sidebar-sub">Phase 3 · Gemini + Claude</p><p class="nav-label">UPLOAD → DEPLOY → CHOOSE AI</p><nav aria-label="Setup guide">${sections.map(s=>`<a href="#${s.id}"><span>${s.letter}</span>${esc(s.title)}</a>`).join('')}</nav><div class="sidebar-foot">Keep your vault secret.<br>Keep your existing Worker.<br>Keys stay separate.<p>This guide has no scripts or generator buttons. It remains readable in HTML previews. Use your browser’s Print menu to save a PDF.</p></div></aside><main class="main" id="main"><div class="topbar"><span class="edition">Phase 3 · Upload guide · October 18, 2026</span><a class="button" href="#section-b">Go to upload steps ↓</a></div><header><p class="eyebrow">YOUR AI. YOUR KEY. YOUR CHOICE.</p><h1>Gemini or Claude.<br>Ready when you are.</h1><p class="lead">Add a second AI provider, keep both keys protected, and find privacy and terms under System. If Phase 2 works, deployment is an upload plus the existing GitHub Actions workflow.</p><div class="chips"><span class="chip">Separate encrypted keys</span><span class="chip">Same password / Google checks</span><span class="chip">No new vault secret</span></div></header><div class="route"><strong>Already configured Phase 2?</strong>Keep your encryption secret and go to <a href="#section-b">B · Upload and deploy</a>. Then use <a href="#section-e">E · Save, test and switch</a> only if you want Claude. This cumulative update also covers Phase 2; no separate earlier upload is required.</div><section class="card"><div class="section-top"><span class="section-marker">AI</span><div><p class="eyebrow">SUPPORTED IN FREE TASKITATOR</p><h2>What each selection uses</h2></div></div><div class="overview-table"><table><thead><tr><th>Provider</th><th>Models</th><th>Saved key</th></tr></thead><tbody><tr><td>Gemini</td><td>3.5 Flash-Lite<br>3.1 Flash-Lite fallback</td><td>Your Gemini key</td></tr><tr><td>Claude</td><td>Haiku 5.5</td><td>Your separate Claude key</td></tr></tbody></table></div><p class="paragraph">The dropdown browses a provider’s saved key. The “Use … for AI” button activates it. No automatic fallback crosses providers.</p></section>${sections.map(s=>`<section class="card ${s.letter==='A'?'warning':''}" id="${s.id}" aria-labelledby="${s.id}-title"><div class="section-top"><span class="section-marker">${s.letter}</span><div><p class="eyebrow">PHASE 3 · SETUP</p><h2 id="${s.id}-title">${esc(s.title)}</h2></div></div>${blocks(s.lines)}</section>`).join('')}<footer class="footer"><span>Taskitator by Mazendev · <a href="mailto:info@mazendev.com">info@mazendev.com</a><br>Keep passwords, API keys and the vault keyring private.</span><a href="#main">Back to top ↑</a></footer></main></div></body></html>`;
fs.writeFileSync(root+'/PHASE-3-SETUP.html',html);
console.log('Built a script-free Phase 3 HTML guide with '+sections.length+' sections.');
