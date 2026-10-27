(() => {
 const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 const link=(p,label,href)=>{const a=el('a',label);a.href=href;p.append(a);return a;};
 const button=(p,label,fn)=>{const b=el('button',label);b.type='button';b.addEventListener('click',fn);p.append(b);return b;};
 let state='connected',label=null;const dirty=()=>[...document.querySelectorAll('#universeWorkspace form')].some(f=>f.dataset.dirty==='true');
 window.UniverseShell={
 connection(s){state=s;if(label){label.dataset.state=s;label.textContent={connected:'Connected',saving:'Saving…',offline:'Offline',attention:'Attention needed'}[s];}},
 canLeave(){if(!dirty())return true;if(!window.confirm('Discard unsaved changes?'))return false;for(const f of document.querySelectorAll('#universeWorkspace form')){f.dataset.dirty='false';f.dispatchEvent(new Event('universe-discard'));}return true;},
 reset(){document.body.classList.remove('universe-active');label=null;},
 create(root,g,username,onExit,onRefresh){
 document.body.classList.add('universe-active');const shell=el('div');shell.className='uni-shell';root.append(shell);
 const header=el('header');header.className='uni-header';shell.append(header);const menu=button(header,'☰',()=>{aside.hidden=!aside.hidden;menu.setAttribute('aria-expanded',String(!aside.hidden));});menu.setAttribute('aria-label','Universe navigation');menu.setAttribute('aria-expanded','false');
 const brand=el('div');brand.append(el('small','YOUR UNIVERSE'),el('h2',g.title));header.append(brand);const identity=el('div');identity.className='uni-identity';identity.append(el('span',username),el('span',g.role));header.append(identity);label=el('span');label.className='uni-connection';label.setAttribute('role','status');header.append(label);this.connection(navigator.onLine===false?'offline':state);
 link(header,'Back to Tasks','index.html?view=today');button(header,'All Universes',()=>{if(this.canLeave())onExit();});
 const aside=el('nav');aside.className='uni-sidebar';aside.hidden=true;aside.setAttribute('aria-label','Universe sidebar');shell.append(aside);const tabs=el('nav');tabs.className='uni-tabs';tabs.setAttribute('aria-label','Universe tabs');shell.append(tabs);
 const content=el('main');content.className='uni-content';shell.append(content);const panes={},buttons=[];
 const items=[['dashboard','My dashboard'],['projects','Projects'],['community','Community'],...( ['owner','admin'].includes(g.role)?[['controls','Controls']]:[]),['settings','Settings']];
 const show=id=>{if(dirty()&&!this.canLeave())return;for(const [key,pane]of Object.entries(panes))pane.hidden=key!==id;for(const [key,b]of buttons){b.setAttribute('aria-current',key===id?'page':'false');b.classList.toggle('selected',key===id);}aside.hidden=true;menu.setAttribute('aria-expanded','false');};
 for(const [id,title]of items){const pane=el('section');pane.className='uni-pane';pane.dataset.pane=id;panes[id]=pane;content.append(pane);for(const nav of [aside,tabs])buttons.push([id,button(nav,title,()=>show(id))]);}
 button(aside,'Refresh Universe',()=>{if(this.canLeave())onRefresh();});const footer=el('footer');footer.className='uni-footer';link(footer,'Back to Tasks','index.html?view=today');button(footer,'All Universes',()=>{if(this.canLeave())onExit();});shell.append(footer);show('dashboard');
 shell.addEventListener('input',e=>{const form=e.target.closest('form');if(form)form.dataset.dirty='true';});shell.addEventListener('submit',()=>{});
 shell.addEventListener('click',e=>{const a=e.target.closest('a');if(a&&dirty()&&!this.canLeave())e.preventDefault();});
 return {panes,show};
 }};
 window.addEventListener('offline',()=>window.UniverseShell.connection('offline'));window.addEventListener('online',()=>window.UniverseShell.connection('attention'));
})();
