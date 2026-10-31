/* Taskitator tutorial presentation. Call start({steps, onFinish}) after the page is ready. */
(() => {
  'use strict';
  let active = null;
  const visible = el => !!el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  function start({steps, onFinish = () => {}}) {
    if (active || !Array.isArray(steps) || !steps.length) return false;
    // Never cover a modal or sign-in screen. The caller can retry later.
    if (document.querySelector('dialog[open], .modal-overlay.open, #authLoadingStatus')) return false;
    const previous = document.activeElement;
    const veil = document.createElement('div');
    veil.className = 'tt-tour-veil';
    const ring = document.createElement('div'); ring.className = 'tt-tour-ring'; ring.setAttribute('aria-hidden', 'true');
    const dialog = document.createElement('section');
    dialog.className = 'tt-tour-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'tt-tour-title'); dialog.setAttribute('aria-describedby', 'tt-tour-description');
    const count = document.createElement('p'); count.className = 'tt-tour-count';
    const title = document.createElement('h2'); title.id = 'tt-tour-title';
    const description = document.createElement('p'); description.id = 'tt-tour-description';
    const note = document.createElement('p'); note.className = 'tt-tour-note';
    const actions = document.createElement('div'); actions.className = 'tt-tour-actions';
    const back = document.createElement('button'), next = document.createElement('button'), skip = document.createElement('button');
    back.textContent = 'Back'; skip.textContent = 'Skip'; [back,next,skip].forEach(b => { b.type='button'; actions.append(b); });
    dialog.append(count,title,description,note,actions); veil.append(ring,dialog); document.body.append(veil);
    let index = 0, target = null, pending = 0;
    const finish = result => { if (!active) return; active = null; cancelAnimationFrame(pending); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); document.removeEventListener('keydown', keydown, true); veil.remove(); if (previous?.isConnected) previous.focus(); onFinish(result); };
    function reposition() {
      cancelAnimationFrame(pending); pending=requestAnimationFrame(() => {
        if (!active) return;
        target = document.querySelector(steps[index].selector || ':not(*)');
        if (!visible(target)) { veil.classList.add('tt-tour-no-target'); ring.hidden=true; note.textContent='This control is not available on this screen. You can continue.'; return; }
        veil.classList.remove('tt-tour-no-target'); note.textContent=''; const r=target.getBoundingClientRect();
        const left=Math.max(0,r.left-6), top=Math.max(0,r.top-6), right=Math.min(innerWidth,r.right+6), bottom=Math.min(innerHeight,r.bottom+6);
        if (right<=left || bottom<=top) { veil.classList.add('tt-tour-no-target'); ring.hidden=true; return; }
        ring.hidden=false; Object.assign(ring.style,{left:left+'px',top:top+'px',width:(right-left)+'px',height:(bottom-top)+'px'});
      });
    }
    function show() {
      const step=steps[index]; count.textContent=`${index+1} of ${steps.length}`; title.textContent=step.title; description.textContent=step.text;
      back.disabled=index===0; next.textContent=index===steps.length-1?'Done':'Next';
      target=document.querySelector(step.selector || ':not(*)'); if (visible(target)) target.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});
      reposition(); next.focus();
    }
    function keydown(e) { if(e.key==='Escape'){e.preventDefault();finish('skipped');} else if(e.key==='Tab') { const buttons=[back,next,skip].filter(b=>!b.disabled); const i=buttons.indexOf(document.activeElement); if(e.shiftKey && i<=0){e.preventDefault();buttons.at(-1).focus();} else if(!e.shiftKey && i===buttons.length-1){e.preventDefault();buttons[0].focus();} } }
    back.onclick=()=>{if(index>0){index--;show();}}; next.onclick=()=>{if(index===steps.length-1)finish('completed');else{index++;show();}}; skip.onclick=()=>finish('skipped');
    active={finish}; window.addEventListener('resize',reposition); window.addEventListener('scroll',reposition,true); document.addEventListener('keydown',keydown,true); show(); return true;
  }
  window.TaskitatorSpotlight = Object.freeze({start, stop:()=>active?.finish('skipped')});
})();
