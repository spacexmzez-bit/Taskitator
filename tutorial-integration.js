/* Taskitator tours: content, progress and the Help & tutorials hub. Engine: tutorial-spotlight.js */
(() => {
  'use strict';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const owner = () => window.TaskitatorAuth?.userId || '';
  const onIndex = () => /(^|\/)(index\.html)?$/.test(location.pathname);
  const onSettings = () => /settings\.html$/.test(location.pathname);

  // ---- progress (synced inside taskitator_settings) ----
  function state() { try { return JSON.parse(localStorage.getItem('taskitator_settings') || '{}'); } catch { return {}; } }
  const progress = key => state().tutorial_progress?.[key] || '';
  function mark(key, result) {
    const s = state();
    s.tutorial_progress = { ...(s.tutorial_progress || {}), [key]: result };
    localStorage.setItem('taskitator_settings', JSON.stringify(s));
    window.SyncEngine?.scheduleAutoPush();
    window.dispatchEvent(new CustomEvent('taskitator-tutorial-progress', { detail: { key, result } }));
  }

  // ---- helpers for steps on the Settings page ----
  async function tab(id) {
    const btn = document.querySelector(`.settings-tab[data-tab="${id}"]`);
    if (!btn || btn.classList.contains('active')) return;
    btn.click(); await sleep(450);
  }
  const currentTab = () => document.querySelector('.settings-tab.active')?.dataset.tab || '';
  const tierName = () => { try { return window.TaskitatorTier?.get().tier === 'pro' ? 'pro' : 'free'; } catch { return 'free'; } };

  // ---- tour content ----
  const TOURS = {
    account: {
      page: 'index', icon: '🚀', title: 'Getting started', chapter: 'Getting started',
      summary: 'The main screen: tasks, breaks, notes, sync and Copilot.',
      steps: () => [
        { kind: 'center', icon: '👋', title: 'Welcome to Taskitator', text: 'Taskitator helps you finish what you planned **before** you get to relax. This quick tour shows the controls you’ll use every day. It takes about two minutes.', why: 'You can skip any time, and replay it later from **Settings → General → Help & tutorials**.' },
        { selector: '#pageViewHeading', icon: '🎯', title: 'Today’s Focus', text: 'This list is everything you committed to for today. Finish it and your day counts as done.', why: 'Seeing only today’s work keeps the list short enough to actually start.' },
        { selector: '#openRootAddModalBtn', icon: '➕', title: 'Add a task', text: 'Tap here to add a task. Pick a date, add subtasks, and set how it will be checked when you finish.' },
        { selector: '#openDrawerBtn', icon: '☰', title: 'The menu', text: 'Projects, the calendar, Universe and Settings all live in this menu.' },
        { selector: '#breakStatusPill', icon: '☕', title: 'Breaks', text: 'This shows whether you’re on a break and how today’s breaks are set up. Breaks have their own short tour.' },
        { selector: '#openDistractionDumpBtn', icon: '📝', title: 'Scratchpad for distractions', text: 'Thinking about something else? Jot it down here, then get back to work. It saves and closes by itself after a short timer.', why: 'Writing it down is faster than acting on it, and it stops the thought from nagging you.' },
        { selector: '#emergencyTriggerBtn', icon: '🚨', title: 'Emergency bypass', text: 'For real emergencies only. It lifts your restrictions for **15 minutes**, and you get **4 per week**. They refill after the weekend.', visual: { type: 'pips', total: 4, on: 4, label: 'uses per week' } },
        { selector: '#syncStatusDot', icon: '🔄', title: 'Sync status', text: 'This dot shows whether your changes are saved to your account.', visual: { type: 'legend', items: [{ color: '#94a3b8', label: 'This device only' }, { color: '#3b82f6', label: 'Syncing' }, { color: '#22c55e', label: 'Up to date' }, { color: '#ef4444', label: 'Needs attention' }] } },
        { selector: ['#openCopilotFabBtn', '#openCopilotNavBtn'], icon: '✨', title: 'Copilot', text: 'Ask Copilot to plan, reschedule or review your tasks. It needs an AI key first, which you add in Settings.' },
        { kind: 'center', icon: '✅', title: 'You’re set. What next?', text: 'These three take a few minutes each and unlock the rest of the app:', visual: { type: 'checklist', items: [
          { icon: '🤖', label: 'Connect an AI provider', sub: 'Needed for Copilot and proof checks', href: 'settings.html#ai' },
          { icon: '📱', label: 'Link your phone', sub: 'So breaks and rules reach your phone', href: 'settings.html#phone' },
          { icon: '🗓️', label: 'Set your day & week', sub: 'When your day starts, your weekend and break limits', href: 'settings.html#schedule' }] } }
      ]
    },
    breaks: {
      page: 'index', icon: '☕', title: 'Breaks & emergencies', chapter: 'Breaks',
      summary: 'Scheduled and Flexible breaks, daily locks, allowance and emergency bypass.',
      steps: () => [
        { selector: '#breakStatusPill', icon: '☕', title: 'Your break button', text: 'Tap it to open today’s break panel. It always shows what’s happening right now.' },
        { selector: '#breakStatusPill', icon: '🗂️', title: 'Two break systems', text: 'The panel has two tabs. Each day you use **one** of them:', visual: { type: 'list', items: [{ icon: '📅', text: '**Scheduled**: plan your breaks ahead of time' }, { icon: '☕', text: '**Flexible**: start a break when you need it' }] } },
        { selector: '#breakStatusPill', icon: '⏳', title: 'One daily allowance', text: 'Both systems share the same **3 hours of breaks per day**. It resets when your day resets.', why: 'Tip: you can lower this maximum in **Settings → Day & week**.' },
        { selector: '#breakStatusPill', icon: '🔒', title: 'Your choice is locked for the day', text: 'Looking at a tab changes nothing. Once you pick a system, the other one is unavailable **until the day resets** — this can’t be undone.', visual: { type: 'list', items: [{ icon: '💾', text: 'Saving a schedule locks **Scheduled**' }, { icon: '▶️', text: 'Starting a break locks **Flexible**' }, { icon: '🔒', text: '**Lock for Today** locks a tab without starting anything' }] } },
        { selector: '#breakStatusPill', icon: '📅', title: 'Scheduled planning', text: 'Start a **10-minute planning window** before the cutoff, 6 hours before your day ends.', visual: { type: 'list', items: [{ icon: '✏️', text: 'Editing rows doesn’t save them' }, { icon: '✕', text: 'Closing without saving cancels the window' }, { icon: '💾', text: 'Your **first save** locks Scheduled, even if you later remove every break' }, { icon: '⏱️', text: 'You can edit until the **original** 10 minutes end' }] } },
        { selector: '#breakStatusPill', icon: '☕', title: 'Flexible breaks', text: 'Pick **30 min**, **45 min**, **1 hour**, a custom length, or **until your allowance ends**.', why: 'You can’t end a Flexible break in its first **10 minutes** (or your strict minimum), so it can’t be used as a quick unlock.' },
        { selector: '#breakStatusPill', icon: '⏲️', title: 'How time is counted', text: 'Each started minute counts as a full minute: 30 minutes 1 second uses 31 minutes. A break stops by itself at its length, when the allowance runs out, or at the day reset, and never continues into the next day.' },
        { selector: '#breakStatusPill', icon: '🚦', title: 'Button colors', text: 'With Flexible selected, the button shows how much allowance is left and says **On break** while one is running:', visual: { type: 'list', items: [{ icon: '🟢', text: 'More than **35%** left' }, { icon: '🟡', text: '**10–35%** left' }, { icon: '🔴', text: 'Less than **10%** left' }] } },
        { selector: '#breakStatusPill', icon: '🛡️', title: 'Strict modes (optional)', text: 'In Settings → Day & week you can make breaks stricter:', visual: { type: 'list', items: [{ icon: '☕', text: '**Flexible Strict Mode**: every Flexible break lasts at least 30–60 minutes, and the same time must pass before the next one' }, { icon: '📅', text: '**Scheduled Strict Mode**: if you haven’t chosen by your deadline, Scheduled locks with that weekday’s plan' }, { icon: '0️⃣', text: 'Forget to plan on a covered day with no plan and you get **zero breaks**. Days marked “Not covered” keep the normal rules' }, { icon: '🔒', text: 'Break settings can only be changed once today’s required tasks are done, or during an emergency bypass' }] } },
        { selector: '#breakStatusPill', icon: '📱', title: 'Breaks and phone locks', text: 'Phone rules can only be changed in three situations:', visual: { type: 'list', items: [{ icon: '✅', text: 'Today’s tasks are **all done**' }, { icon: '☕', text: 'You’re **on a break** — this also lifts Universe locks, but **not Sleep Lock**' }, { icon: '🚨', text: 'An **emergency bypass** is active' }] } },
        { selector: '#emergencyTriggerBtn', icon: '🚨', title: 'Emergency bypass', text: 'Lifts restrictions for **15 minutes**. You get **4 per week**, refilled after the weekend. It’s separate from breaks: it never ends a break or changes your allowance.', visual: { type: 'pips', total: 4, on: 4, label: 'uses per week' } },
        { kind: 'center', icon: '🗓️', title: 'Change when your day starts', text: 'Day start, weekend, your daily break maximum and strict modes are on the Day & week tab in Settings. Changes can’t reset today’s break lock or allowance.', visual: { type: 'checklist', items: [{ icon: '🗓️', label: 'Open Day & week', sub: 'Settings', href: 'settings.html#schedule' }] } }
      ]
    },
    ai: {
      page: 'settings', icon: '🤖', title: 'Set up AI', chapter: 'AI setup',
      summary: 'Add a key, test it, and see what strict checking does.',
      steps: () => [
        { selector: '#aiProviderSelect', before: () => tab('tab-ai'), icon: '🔀', title: 'Pick a provider', text: 'Choose **Gemini** or **Claude**. Each has its own saved key, so you can add both and switch whenever you like.' },
        { selector: '#vaultSaveBtn', before: () => tab('tab-ai'), icon: '🔑', title: 'Add your key', text: 'Paste a key from Google AI Studio (Gemini) or the Claude Console. It’s encrypted before it’s saved, and you confirm with your password or Google first.', why: 'The key is how Taskitator pays for AI on your behalf. Nobody else can use it.' },
        { selector: '#vaultTestBtn', before: () => tab('tab-ai'), icon: '🧪', title: 'Test it', text: 'Run a quick check to make sure the key works. If it fails, re-copy the key and try again.' },
        { selector: '#vaultUseProviderBtn', before: () => tab('tab-ai'), icon: '✔️', title: 'Choose the active one', text: 'This button makes the selected provider the one Copilot and proof checks use.' },
        { selector: '#strictCriteriaToggle', before: () => tab('tab-tasks'), icon: '🛡️', title: 'Strict criteria', text: 'When on, the AI checks your proof against the task’s criteria before the task locks as done.' },
        { kind: 'center', icon: '📸', title: 'How proof is judged', text: 'You submit proof (a photo or text). The AI scores it against your criteria, and it needs **7 out of 10** to pass.', visual: { type: 'pips', total: 10, on: 7, label: '7 to pass' } }
      ]
    },
    phone: {
      page: 'settings', icon: '📱', title: 'Link your phone', chapter: 'Phone',
      summary: 'Connect your phone so your rules follow your day.',
      steps: () => [
        { selector: '.guide-banner-card', before: () => tab('tab-phone'), icon: '📖', title: 'Follow the guide', text: 'This guide walks through setting up the automation app on your phone. Do it once.' },
        { selector: '#phoneAccessStatus', before: () => tab('tab-phone'), icon: '📶', title: 'Connection status', text: 'Shows whether your phone is currently allowed to use things. Check here if something feels off.' },
        { selector: '#macroEndpointUrl', before: () => tab('tab-phone'), icon: '🔗', title: 'The status URL', text: 'Your phone automation asks this address “is anything allowed right now?”. Copy it into step 1 of the guide.' },
        { selector: '#generatePhoneTokenBtn', before: () => tab('tab-phone'), icon: '🎫', title: 'Create a token', text: 'The token proves the request comes from your phone. If it ever leaks, revoke it and create a new one.' },
        { kind: 'center', icon: '📏', title: 'The rule', text: 'Phone changes are only allowed in these cases:', visual: { type: 'list', items: [{ icon: '✅', text: 'Today’s tasks are **done**' }, { icon: '☕', text: 'You’re **on a break**' }, { icon: '🚨', text: 'An **emergency bypass** is active' }] } }
      ]
    },
    pro: {
      page: 'settings', icon: '◆', title: 'Taskitator Pro', chapter: 'Pro',
      summary: 'What Pro adds and where to manage it.',
      steps: () => tierName() === 'pro' ? [
        { selector: '#pro-settings-container', before: () => tab('tab-ai'), icon: '◆', title: 'You have Pro', text: 'Your plan and expiry show here.', visual: { type: 'list', items: [{ icon: '📚', text: 'Study plans and **Smart Study**' }, { icon: '🔢', text: 'Consecutive subtask numbering' }, { icon: '🧾', text: 'Batch review: one proof for several tasks' }, { icon: '🌌', text: 'Create a **Universe** for shared work' }] } },
        { selector: '.pro-quota-grid', before: () => tab('tab-ai'), icon: '📊', title: 'Hosted credits', text: 'Your included AI usage and what’s left of it.' },
        { selector: '.pro-byok-box', before: () => tab('tab-ai'), icon: '🔑', title: 'Or use your own key', text: 'You can still use your own Gemini or Claude key alongside hosted credits.' },
        { selector: '#proComparePageLink', before: () => tab('tab-ai'), icon: '⚖️', title: 'Compare plans', text: 'See exactly what Free and Pro include.' }
      ] : [
        { selector: '#pro-settings-container', before: () => tab('tab-ai'), icon: '◇', title: 'You’re on Free', text: 'Free covers tasks, breaks, phone rules and Copilot with your own key. Pro adds:', visual: { type: 'list', items: [{ icon: '📚', text: 'Study plans and **Smart Study**' }, { icon: '🔢', text: 'Consecutive subtask numbering' }, { icon: '🧾', text: 'Batch review: one proof for several tasks' }, { icon: '🌌', text: 'Create a **Universe** for shared work' }] } },
        { selector: '#pro-activation-form', before: () => tab('tab-ai'), icon: '🎟️', title: 'Activate a code', text: 'Have a Pro code? Enter it here.' },
        { selector: '#proComparePageLink', before: () => tab('tab-ai'), icon: '⚖️', title: 'Compare plans', text: 'See what Free and Pro include side by side.' }
      ]
    }
  };
  const ORDER = ['account', 'breaks', 'ai', 'phone', 'pro'];

  // ---- Universe tour (follows the redesigned layout; role-aware) ----
  const uniTabBtn = id => document.querySelector(`.uni-tabs button[aria-controls="uni-pane-${id}"]`);
  async function uniTab(id) {
    const btn = uniTabBtn(id);
    if (!btn || btn.classList.contains('selected')) return;
    btn.click(); await sleep(380);
  }
  const uniCurrentTab = () => document.querySelector('.uni-tabs button.selected')?.getAttribute('aria-controls')?.replace('uni-pane-', '') || '';
  const ROLE_LINE = {
    owner: 'You’re the **owner**, so you see every tab, including Controls.',
    admin: 'You’re an **admin**, so you can manage people and labels.',
    reviewer: 'You’re a **reviewer**. Your role decides which actions you see.',
    member: 'You’re a **member**. Your role decides which actions you see.'
  };

  function universeSteps(g) {
    const manager = ['owner', 'admin'].includes(g.role);
    const steps = [
      { selector: '.uni-brand', before: () => uniTab('dashboard'), icon: '🌌', title: 'Your Universe', text: `A shared workspace for your group. ${ROLE_LINE[g.role] || 'Your role decides which actions you see.'}`, why: 'The server checks your role on every action, so a button you can’t see is one you can’t use.' },
      { selector: '.uni-sync', icon: '🔄', title: 'Sync and connection', text: 'Universe needs an internet connection, and changes are **not** queued offline. Tap sync to pull the latest from other members. The label beside it shows the state:', visual: { type: 'list', items: [
        { icon: '🟢', text: '**Connected**: up to date' },
        { icon: '💾', text: '**Saving…**: a change is on its way' },
        { icon: '📴', text: '**Offline**: reconnect, then retry' },
        { icon: '⚠️', text: '**Attention**: sync again to check' }] } },
      { selector: '.uni-tabs', icon: '🧭', title: 'Move around', text: `Switch between My dashboard, Projects, My stats${manager ? ', Controls' : ''} and Settings. The glowing bar follows the tab you’re on. Arrow keys also move between tabs.` },
      { selector: ['.uni-ring', '#uni-pane-dashboard'], before: () => uniTab('dashboard'), icon: '📋', title: 'Your dashboard', text: 'The ring shows how much of **your** assigned work is done. The date pills under it narrow the list to what’s due soon.' },
      { selector: ['.uni-group', '#uni-pane-dashboard'], before: () => uniTab('dashboard'), icon: '🗂️', title: 'Work, grouped by date', text: 'Tasks sit in groups: **Overdue**, **Today**, **Upcoming**, **No date** and **Complete**. The coloured stripe on a card is its priority. Open one to see where it stands:', visual: { type: 'list', items: [
        { icon: '1️⃣', text: '**Open**: waiting for you' },
        { icon: '2️⃣', text: '**Submitted**: you sent your proof' },
        { icon: '3️⃣', text: '**In review**: a reviewer is checking' },
        { icon: '✅', text: '**Approved**, or **Needs changes** to fix and resubmit' }] } },
      { selector: ['.uni-project-head', '.uni-project-tabs', '#uni-pane-projects'], before: () => uniTab('projects'), icon: '📁', title: 'Projects', text: 'Pick a project to see its progress bar and tasks. Subtasks fold under their parent, so tap a parent to show or hide them.' }
    ];
    if (manager) steps.push({ selector: '#uni-pane-projects .uni-fab', before: () => uniTab('projects'), icon: '➕', title: 'Create work', text: 'Use **＋** to add a task. Task editors pick tags and priorities from your Universe’s labels. If you have no project yet, create one first.', note: 'An unsaved editor shows a small “unsaved” marker, and you’re asked before leaving it.' });
    steps.push({ selector: ['.uni-stat-grid', '#uni-pane-stats'], before: () => uniTab('stats'), icon: '📊', title: 'My stats', text: 'Counts of your own assignments by state, plus your Universe AI credit use. Only your numbers appear here.' });
    if (manager) steps.push({ selector: ['.uni-subtabs', '#uni-pane-controls'], before: () => uniTab('controls'), icon: '🛠️', title: 'Controls', text: 'Three sections: **People** (roles and removal under “Manage”), **Invitations** (single-use links that reserve a seat until accepted, cancelled or expired) and **Labels** (tags and priorities).' });
    steps.push(
      { selector: '#uni-pane-settings', before: () => uniTab('settings'), icon: '⚙️', title: 'Settings', text: g.role === 'owner'
        ? 'Preferences, review standards, ownership transfer and exports. Export and import now live here per Universe. From **All Universes**, the **Backups** button on a Universe you created opens this tab.'
        : 'Your preferences and the Universe options your role allows.' },
      { selector: '.uni-danger-zone', before: () => uniTab('settings'), icon: '🚪', title: g.role === 'owner' ? 'Delete Universe' : 'Leave Universe', text: g.role === 'owner'
        ? 'Deleting removes access for every member, so export first. A red confirmation always asks before anything is deleted.'
        : 'Leaving ends your access and history. A red confirmation always asks first.' },
      { selector: '.uni-tour-replay', before: () => uniTab('settings'), icon: '🔁', title: 'Replay this tour', text: 'Run it again here whenever you like. **All Universes** switches Universe, and **Back to Tasks** returns to your day.' }
    );
    return steps;
  }

  // ---- running tours ----
  function run(key, steps, chapter, theme = '') {
    const o = owner();
    if (!o || !steps?.length || !window.TaskitatorSpotlight) return false;
    const back = onSettings() ? currentTab() : '';
    const uniBack = theme === 'universe' ? uniCurrentTab() : '';
    return window.TaskitatorSpotlight.start({
      steps, chapter, theme,
      onFinish: async result => {
        if (owner() === o) mark(key, result);
        if (back && currentTab() !== back) { await sleep(60); document.querySelector(`.settings-tab[data-tab="${back}"]`)?.click(); }
        if (uniBack && uniCurrentTab() !== uniBack) { await sleep(60); uniTabBtn(uniBack)?.click(); }
      }
    });
  }
  function start(key, list) {
    if (list) return run(key, list, 'Universe', 'universe');
    const t = TOURS[key]; if (!t) return false;
    return run(key, t.steps(), t.chapter);
  }
  function attempt(fn, n = 0) { if (fn() || n >= 20) return; setTimeout(() => attempt(fn, n + 1), 500); }

  function launch(key) {
    const t = TOURS[key]; if (!t) return;
    if (t.page === 'index' && !onIndex()) {
      sessionStorage.setItem('taskitator_tutorial_next', JSON.stringify({ owner: owner(), key }));
      location.href = 'index.html';
    } else start(key);
  }

  // ---- Help & tutorials hub (Settings → General) ----
  function renderHub() {
    const host = document.getElementById('tutorialHub'); if (!host) return;
    host.replaceChildren();
    ORDER.forEach(key => {
      const t = TOURS[key], p = progress(key);
      const row = document.createElement('div'); row.className = 'tour-row';
      const ic = document.createElement('span'); ic.className = 'tour-ic'; ic.textContent = t.icon; ic.setAttribute('aria-hidden', 'true');
      const txt = document.createElement('div'); txt.className = 'tour-text';
      const b = document.createElement('b'); b.textContent = t.title;
      const s = document.createElement('small'); s.textContent = `${t.summary} · ${t.steps().length} steps`;
      txt.append(b, s);
      const chip = document.createElement('span');
      chip.className = 'tour-chip ' + (p === 'completed' ? 'ok' : p === 'skipped' ? 'skip' : 'new');
      chip.textContent = p === 'completed' ? 'Done' : p === 'skipped' ? 'Skipped' : 'New';
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'icon-btn btn-md';
      btn.textContent = p ? 'Replay' : 'Start';
      btn.setAttribute('aria-label', `${p ? 'Replay' : 'Start'} tutorial: ${t.title}`);
      btn.addEventListener('click', () => launch(key));
      row.append(ic, txt, chip, btn);
      host.append(row);
    });
  }

  window.TaskitatorTutorials = {
    start,
    launch,
    renderHub,
    openUniverse(g) {
      if (!g?.id) return;
      const key = 'universe:' + g.id;
      const pane = document.querySelector('#uni-pane-settings');
      if (pane && !pane.querySelector('.uni-tour-replay')) {
        const box = document.createElement('section'); box.className = 'uni-settings-section uni-tour-replay';
        const head = document.createElement('div'); head.className = 'uni-section-heading';
        const h = document.createElement('h3'); h.textContent = 'Help';
        const d = document.createElement('p'); d.textContent = 'A short walkthrough of this Universe for your role.';
        head.append(h, d);
        const replay = document.createElement('button'); replay.type = 'button'; replay.className = 'icon-btn';
        replay.textContent = 'Replay Universe tutorial';
        replay.addEventListener('click', () => start(key, universeSteps(g)));
        box.append(head, replay); pane.append(box);
      }
      if (!progress(key)) setTimeout(() => attempt(() => progress(key) ? true : start(key, universeSteps(g))), 1000);
    },
    proActivated() { if (onSettings()) setTimeout(() => attempt(() => start('pro')), 300); }
  };

  function init() {
    renderHub();
    if (!onIndex()) return;
    // Explicit request from the hub or the legacy replay flag
    let key = '';
    try {
      const next = JSON.parse(sessionStorage.getItem('taskitator_tutorial_next') || 'null');
      if (next?.owner === owner() && TOURS[next.key]) key = next.key;
      sessionStorage.removeItem('taskitator_tutorial_next');
    } catch { /* ignore */ }
    if (!key && sessionStorage.getItem('taskitator_tutorial_replay') === owner()) { sessionStorage.removeItem('taskitator_tutorial_replay'); key = 'account'; }
    if (key) { setTimeout(() => attempt(() => start(key)), 500); return; }
    // New accounts only
    if (sessionStorage.getItem('taskitator_new_tutorial') === owner() && !progress('account')) {
      setTimeout(() => attempt(() => { const ok = start('account'); if (ok) sessionStorage.removeItem('taskitator_new_tutorial'); return ok; }), 500);
    }
  }
  window.addEventListener('taskitator-auth-ready', init);
  window.addEventListener('taskitator-synced', renderHub);
  window.addEventListener('taskitator-settings-changed', renderHub);
  window.addEventListener('taskitator-tutorial-progress', renderHub);
})();
