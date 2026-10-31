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
        { selector: '#breakStatusPill', icon: '☕', title: 'Breaks', text: 'This shows whether you’re on a break and when the next one can start. Break planning is covered in its own short tour.' },
        { selector: '#openDistractionDumpBtn', icon: '📝', title: 'Scratchpad for distractions', text: 'Thinking about something else? Jot it down here, then get back to work. It saves and closes by itself after a short timer.', why: 'Writing it down is faster than acting on it, and it stops the thought from nagging you.' },
        { selector: '#emergencyTriggerBtn', icon: '🚨', title: 'Emergency bypass', text: 'For real emergencies only. It lifts your restrictions for **15 minutes**, and you get **4 per week**. They refill after the weekend.', visual: { type: 'pips', total: 4, on: 4, label: 'uses per week' } },
        { selector: '#syncStatusDot', icon: '🔄', title: 'Sync status', text: 'This dot shows whether your changes are saved to your account.', visual: { type: 'legend', items: [{ color: '#94a3b8', label: 'This device only' }, { color: '#3b82f6', label: 'Syncing' }, { color: '#22c55e', label: 'Up to date' }, { color: '#ef4444', label: 'Needs attention' }] } },
        { selector: ['#openCopilotFabBtn', '#openCopilotNavBtn'], icon: '✨', title: 'Copilot', text: 'Ask Copilot to plan, reschedule or review your tasks. It needs an AI key first, which you add in Settings.' },
        { kind: 'center', icon: '✅', title: 'You’re set. What next?', text: 'These three take a few minutes each and unlock the rest of the app:', visual: { type: 'checklist', items: [
          { icon: '🤖', label: 'Connect an AI provider', sub: 'Needed for Copilot and proof checks', href: 'settings.html#ai' },
          { icon: '📱', label: 'Link your phone', sub: 'So breaks and rules reach your phone', href: 'settings.html#phone' },
          { icon: '🗓️', label: 'Set your day & week', sub: 'When your day starts and your weekend', href: 'settings.html#schedule' }] } }
      ]
    },
    breaks: {
      page: 'index', icon: '☕', title: 'Breaks & emergencies', chapter: 'Breaks',
      summary: 'How break windows, locks and emergency bypass work.',
      steps: () => [
        { selector: '#breakStatusPill', icon: '☕', title: 'Your break status', text: 'Tap the pill to plan or view today’s break. It always shows what’s happening right now.' },
        { selector: '#breakStatusPill', icon: '⏱️', title: 'One 10-minute window', text: 'Each day has a **single 10-minute break window**. Plan it before the planning cutoff, which is **6 hours before your day ends**.', why: 'A fixed window means you decide on a break ahead of time, not in the middle of a craving.' },
        { selector: '#breakStatusPill', icon: '🔒', title: 'What stays locked', text: 'Phone rules can only be changed in three situations:', visual: { type: 'list', items: [{ icon: '✅', text: 'Today’s tasks are **all done**' }, { icon: '☕', text: 'You’re **on a break**' }, { icon: '🚨', text: 'An **emergency bypass** is active' }] } },
        { selector: '#emergencyTriggerBtn', icon: '🚨', title: 'Emergency bypass', text: 'Lifts restrictions for **15 minutes**. You get **4 per week**, refilled after the weekend.', visual: { type: 'pips', total: 4, on: 4, label: 'uses per week' } },
        { kind: 'center', icon: '🗓️', title: 'Change when your day starts', text: 'Day start and weekend settings are on the Day & week tab in Settings.', visual: { type: 'checklist', items: [{ icon: '🗓️', label: 'Open Day & week', sub: 'Settings', href: 'settings.html#schedule' }] } }
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

  function universeSteps(g) {
    const list = [
      { selector: '.uni-brand', icon: '🌌', title: 'Your Universe', text: 'A shared workspace. Your role decides which actions you see.' },
      { selector: '.uni-tabs', icon: '🧭', title: 'Move around', text: 'Tabs for your dashboard, projects, statistics and settings.' },
      { selector: '#uni-pane-dashboard', icon: '📋', title: 'Your work', text: 'Work assigned to you and the review status of each item.' },
      { selector: '.uni-sync', icon: '🔄', title: 'Refresh', text: 'Pull the latest changes from other members.' }
    ];
    if (['owner', 'admin'].includes(g.role)) list.push({ selector: '.uni-tabs', icon: '🛠️', title: 'Manage work', text: 'Use **Controls** to manage the people and labels your role can change.' });
    return list;
  }

  // ---- running tours ----
  function run(key, steps, chapter) {
    const o = owner();
    if (!o || !steps?.length || !window.TaskitatorSpotlight) return false;
    const back = onSettings() ? currentTab() : '';
    return window.TaskitatorSpotlight.start({
      steps, chapter,
      onFinish: async result => {
        if (owner() === o) mark(key, result);
        if (back && currentTab() !== back) { await sleep(60); document.querySelector(`.settings-tab[data-tab="${back}"]`)?.click(); }
      }
    });
  }
  function start(key, list) {
    if (list) return run(key, list, 'Universe');
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
      const replay = document.createElement('button'); replay.type = 'button'; replay.className = 'icon-btn'; replay.textContent = 'Replay Universe tutorial';
      replay.addEventListener('click', () => start(key, universeSteps(g)));
      document.querySelector('#uni-pane-settings')?.append(replay);
      if (!progress(key)) setTimeout(() => attempt(() => start(key, universeSteps(g))), 1000);
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
