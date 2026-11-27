/* Phase 6.9: Help → "Try it live" guides, and the highlight when the Help index jumps to a section.
   A live guide opens the real screen (Today unless it says otherwise) and uses the tour engine's live steps
   (tutorial-spotlight.js v3): everything outside the highlighted part fades and ignores taps; the highlighted part
   stays usable, and the guide moves on when the person does what the step asks. Controls that already explain
   themselves (the ? and ! buttons in the task panel, the break panel's ? help) are pointed at, not re-explained.
   What the person does during a guide is real; nothing is saved unless they press the app's own Save button.
   Settings tours and the older guided tours run through TaskitatorTutorials. */
(() => {
  'use strict';
  if (typeof document === 'undefined') return;
  const $ = s => document.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isOpen = id => !!document.getElementById(id)?.classList.contains('open');
  const shown = n => !!n && !!n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
  const box = id => '#' + id + ' .modal-box';
  const group = id => () => document.getElementById(id)?.closest('.form-group') || null;
  const click = sel => () => { const n = typeof sel === 'function' ? sel() : $(sel); n?.click(); };
  const firstRow = () => [...document.querySelectorAll('#taskListContainer .task-row:not(.early-group-row)')].find(shown) || null;
  const firstTitle = () => firstRow()?.querySelector('.task-title') || null;
  const firstCircle = () => firstRow()?.querySelector('.check-circle') || null;
  const barOpen = () => !!$('#batchActionBar')?.classList.contains('open');
  const plusBtn = (title = 'Tap + New task') => ({
    selector: '#openRootAddModalBtn', live: true, until: () => isOpen('addTaskModal'), act: click('#openRootAddModalBtn'),
    icon: 'add', title, text: 'This button opens **Create New Task**. Tap it now.'
  });
  const done = (from, text) => ({
    kind: 'center', icon: 'completed', title: 'That’s it', text: text || 'You can keep using this screen, or go back to the guide.',
    visual: { type: 'checklist', items: [{ icon: 'help', label: 'Back to Help', sub: 'Return to this section', href: '#' + from }] }
  });
  const noTasks = from => [{ kind: 'center', icon: 'nav-today', title: 'Nothing on Today yet', text: 'This guide needs a task on **Today**. Create one first with **Try it live: create a task**, then come back.' }, done(from)];

  const LIVE = {
    create: {
      steps: from => [
        plusBtn(),
        { selector: box('addTaskModal'), live: true, lost: 1, icon: 'notes', title: 'The panel is yours', text: 'Type a **Task Title**: it’s the only required field. Description, Project, Priority, Tags and Due Date are optional. The Due Date starts as today because you opened the panel from Today.', note: 'Tags: type one and press **+ Add**. You can add several.' },
        { selector: box('addTaskModal'), live: true, lost: 2, icon: 'help', title: 'Options explain themselves', text: 'Further down are Shield, Bonus, Dynamic options, AI proof, Repeat and Quick Subtasks. The **?** buttons next to them explain each one right there, so tap them when you want the details.', why: 'Shield and AI proof can’t be undone once you save, so read their notes first.' },
        { selector: box('addTaskModal'), live: true, until: () => !isOpen('addTaskModal'), act: click('#closeAddTaskModalBtn'), actLabel: 'Close without saving', icon: 'save', dock: 'top', title: 'Save it', text: 'Press **Save Task** to create it, **Draft** to keep it for later, or **Cancel** to drop it.' },
        { selector: '#taskListContainer', icon: 'nav-today', title: 'Find it on Today', text: 'A task due today shows here. Tap its **title** to open Task Details, or its **circle** to complete it. A task with no due date never shows on Today.' },
        done(from)
      ]
    },
    details: {
      steps: from => !firstTitle() ? noTasks(from) : [
        { selector: '#taskListContainer', live: true, until: () => isOpen('taskDetailModal'), act: click(firstTitle), icon: 'notes', title: 'Open a task', text: 'Tap a task’s **title** (not its circle). **Task Details** opens.' },
        { selector: box('taskDetailModal'), live: true, lost: 1, icon: 'notes', title: 'Task Details', text: 'Change any field. Nothing applies until you press **Save Changes**. Here you also find **Hierarchy / Parent Task → Change** (move it under another task), **Early task**, the AI Audit card and **Subtasks Under This Task**.', note: 'Locked or shielded parts stay disabled and say why.' },
        { selector: box('taskDetailModal'), live: true, until: () => !isOpen('taskDetailModal'), act: click('#closeDetailModalBtn'), actLabel: 'Close without saving', icon: 'save', dock: 'top', title: 'Finish', text: '**Save Changes** applies your edits. **Draft** keeps them for later without changing the task. **Delete Task** moves it and its subtasks to Trash. **Cancel** drops your edits.' },
        done(from)
      ]
    },
    complete: {
      steps: from => !firstCircle() ? noTasks(from) : [
        { selector: () => firstCircle(), live: true, icon: 'completed', title: 'The circle completes', text: 'Tapping a task’s circle completes it and all its subtasks. **Undo** shows for 10 seconds. An AI-locked task opens the proof dialog instead.', note: 'This is real. Only tap a task you’ve actually finished, or press **Undo** straight after.' },
        { selector: '#openCompletedModalBtn', live: true, until: () => isOpen('completedModal'), act: click('#openCompletedModalBtn'), icon: 'completed', title: 'Completed', text: 'Tap **Completed** to see what you finished today.' },
        { selector: box('completedModal'), live: true, until: () => !isOpen('completedModal'), act: click('#closeCompletedModalBtn'), actLabel: 'Close it', icon: 'completed', dock: 'top', title: 'Reopen from here', text: 'Tap a finished task’s circle to reopen it. A top-level task can be reopened until its day ends. Close the panel to continue.' },
        { kind: 'center', icon: 'trash', title: 'What happens to unfinished subtasks', text: 'When you complete a **top-level** task, its unfinished subtasks that aren’t protected (bonus, AI-audited or shielded work) move to **Trash**. Reopening the task brings them back.' },
        done(from)
      ]
    },
    subtasks: {
      steps: from => [
        plusBtn(),
        { selector: group('createQuickSubtaskInput'), live: true, lost: 1, icon: 'notes', title: 'Quick Subtasks', text: 'Type a step and press **Enter** (or **+**). Put `$$` in the text to make it a bonus subtask. The **?** beside the heading explains Consecutive and Auto create (Pro).' },
        { selector: '#prerequisiteBoxContainer', live: true, lost: 2, icon: 'shield', title: 'Shield', text: 'With **Require all subtasks first**, this task can’t be completed until every required subtask under it is done.', note: 'Irreversible: once saved, the Shield can’t be turned off.' },
        { selector: '#bonusTaskContainer', live: true, lost: 3, icon: 'bonus', title: 'Bonus', text: 'Ticking **Bonus** makes this task optional work. A bonus task never blocks its parent, even under a Shield.' },
        { selector: '#createDynSection', live: true, lost: 4, icon: 'sliders', title: 'Dynamic options', text: 'Tap the **?** here to read what Dynamic Priority and Dynamic Bonus do.' },
        { selector: box('addTaskModal'), live: true, until: () => !isOpen('addTaskModal'), act: click('#closeAddTaskModalBtn'), actLabel: 'Close without saving', icon: 'save', dock: 'top', title: 'Save it', text: '**Save Task** creates the task with its subtasks. **Cancel** drops everything.' },
        done(from)
      ]
    },
    drafts: {
      steps: from => [
        plusBtn(),
        { selector: group('taskTitleInput'), live: true, lost: 1, icon: 'notes', title: 'Type a title', text: 'A draft only needs a title. Fill in anything else you already know.' },
        { selector: '#saveTaskDraftBtn', live: true, lost: 2, until: () => !isOpen('addTaskModal'), act: click('#saveTaskDraftBtn'), icon: 'nav-drafts', title: 'Press Draft', text: 'Press **Draft**. Nothing is created or locked and no AI is used. A draft isn’t on Today and doesn’t affect your phone lock.' },
        { selector: () => [...document.querySelectorAll('[data-open-drafts]')].find(shown) || null, live: true, until: () => !!document.getElementById('draftsListModal'), act: click('[data-open-drafts]'), icon: 'nav-drafts', title: 'Your drafts', text: 'Menu (☰) → **Drafts** lists them.' },
        { selector: box('draftsListModal'), live: true, until: () => !document.getElementById('draftsListModal'), act: () => [...document.querySelectorAll('#draftsListModal button')].find(b => b.textContent.trim() === 'Close')?.click(), actLabel: 'Close it', icon: 'nav-drafts', dock: 'top', title: 'Open or delete', text: '**Open** refills the task form. Press **Save Task** there to publish it, which removes the draft. **Delete** removes the draft. Close the list to continue.' },
        done(from)
      ]
    },
    multi: {
      steps: from => !firstRow() ? noTasks(from) : [
        { selector: '#toggleSelectModeBtn', live: true, until: barOpen, act: click('#toggleSelectModeBtn'), icon: 'completed', title: 'Multiselect', text: 'Tap **Multiselect** to start choosing tasks.' },
        { selector: '#taskListContainer', live: true, lost: 1, icon: 'completed', title: 'Tick tasks', text: 'Tap tasks to tick them. **Select all** in the bar ticks everything shown.' },
        { selector: '#batchActionBar', live: true, lost: 2, icon: 'sliders', title: 'Batch actions', text: 'Pick an action for every ticked task: **Tags** (replaces their tags), **Priority**, **Due** (also Early task), **Bonus**, **Delete** and, on Pro, **Batch review**.', note: 'Delete shows **Apply · delete N** first. Nothing is deleted until you press it.' },
        { selector: '#toggleSelectModeBtn', live: true, until: () => !barOpen(), act: click('#toggleSelectModeBtn'), icon: 'completed', title: 'Leave selection mode', text: 'Tap **Multiselect** again when you’re done.' },
        done(from)
      ]
    },
    filter: {
      steps: from => [
        { selector: '#openFilterModalBtn', live: true, until: () => isOpen('filterModal'), act: click('#openFilterModalBtn'), icon: 'search', title: 'Filter', text: 'Tap **Filter**.' },
        { selector: box('filterModal'), live: true, until: () => !isOpen('filterModal'), act: click('#closeFilterModalBtn'), actLabel: 'Close it', icon: 'search', dock: 'top', title: 'Choose what to show', text: 'Pick **Projects**, **Priorities** and **Tags**, and **Match** all (AND) or any (OR). Then **Apply Filters**, or **Clear All** to reset. The parents of matching tasks stay visible. Close the panel to continue.' },
        { selector: '#taskSortButton', live: true, until: () => shown($('#taskSortMenu')), act: click('#taskSortButton'), icon: 'sliders', title: 'Sort', text: 'Tap **⇅** to change the order.' },
        { selector: ['#taskSortMenu', '#taskSortButton'], live: true, icon: 'sliders', title: 'Sort order', text: '**Priority**, **Alphabetical** (numbers sort as numbers, so Chapter 2 comes before Chapter 10) or **Required, then priority**. Your choice is saved on this device.' },
        done(from)
      ]
    },
    overdue: {
      steps: from => !shown($('#openRescheduleModalBtn')) ? [
        { kind: 'center', icon: 'warning', title: 'No overdue tasks', text: 'When a task passes its due date, a banner appears at the top of Today with **Reschedule to date…**. Come back to this guide then.' }, done(from)] : [
        { selector: '#openRescheduleModalBtn', live: true, until: () => isOpen('bulkRescheduleModal'), act: click('#openRescheduleModalBtn'), icon: 'warning', title: 'Reschedule', text: 'Tap **Reschedule to date…** in the overdue banner.' },
        { selector: box('bulkRescheduleModal'), live: true, until: () => !isOpen('bulkRescheduleModal'), act: click('#cancelBulkRescheduleBtn'), actLabel: 'Close it', icon: 'calendar', dock: 'top', title: 'Pick a date', text: 'Choose a **Target Due Date** (today or later), then **Reschedule Tasks**. Locked tasks don’t move. If AI-checked tasks are overdue, the button becomes **Bring AI Tasks to Today**. Close the panel to continue.' },
        done(from)
      ]
    },
    projects: {
      view: '#projects', shell: 'projects',
      steps: from => [
        { selector: '#openCreateProjectModalBtn', live: true, until: () => isOpen('projectModal'), act: click('#openCreateProjectModalBtn'), icon: 'folder', title: 'New project', text: 'Every account has an **Inbox**. The **+** chip creates another project. Tap it.' },
        { selector: box('projectModal'), live: true, until: () => !isOpen('projectModal'), act: click('#closeProjectModalBtn'), actLabel: 'Close it', icon: 'folder', dock: 'top', title: 'Name, icon and colour', text: 'Fill them in and press **Save Project**, or close the panel to continue without one.' },
        { selector: '#projectsHeaderStrip', icon: 'folder', title: 'Switch projects', text: 'Tap a chip to open that project. **✎** edits the open project (not the Inbox). Deleting a project asks whether its tasks go to the Inbox, move to another project or are deleted too.' },
        { selector: '#openProjectTaskAddModalBtn', icon: 'add', title: 'Tasks in this project', text: '**+ New task** here creates the task inside the open project.' },
        done(from)
      ]
    },
    calendar: {
      view: '#calendar', shell: 'calendar',
      steps: from => [
        { selector: '#calendarGridBody', live: true, icon: 'calendar', title: 'Pick a day', text: 'Tap a date. **‹ ›** change the month; **Today** jumps back.' },
        { selector: ['#agendaListContainer:not(:empty)', '.agenda-header'], live: true, icon: 'notes', title: 'Agenda', text: 'The **Agenda** lists that day’s tasks. Tap one to open it. Tasks can’t be completed from the calendar.' },
        { selector: '#unscheduledCard', live: true, icon: 'inbox', title: 'Unscheduled Tasks', text: 'Tasks without a date, each with **Assign to Today**.' },
        done(from)
      ]
    },
    breakpanel: {
      steps: from => [
        { selector: '#breakStatusPill', live: true, until: () => isOpen('breakModal'), act: click('#breakStatusPill'), icon: 'breaks', title: 'Open the break panel', text: 'Tap the **Breaks** pill.' },
        { selector: box('breakModal'), live: true, lost: 1, icon: 'help', title: 'Two systems', text: 'The panel has **Scheduled** and **Flexible**. Each has a **?** that explains its rules: tap it.', note: 'Pressing **Start planning**, **Lock Scheduled for Today** or a Flexible length is real: it uses today’s allowance and locks the other system until the day resets.' },
        { selector: box('breakModal'), live: true, until: () => !isOpen('breakModal'), act: click('#closeBreakModalBtn'), actLabel: 'Close it', icon: 'breaks', dock: 'top', title: 'Close when done', text: 'Close the panel to continue. The pill always shows today’s break state.' },
        done(from)
      ]
    },
    scratch: {
      steps: from => [
        { selector: '#openDistractionDumpBtn', live: true, until: () => isOpen('distractionDumpModal'), act: click('#openDistractionDumpBtn'), icon: 'scratchpad', title: 'Open the Scratchpad', text: 'Tap **Scratchpad** when a thought distracts you.' },
        { selector: box('distractionDumpModal'), live: true, until: () => !isOpen('distractionDumpModal'), act: click('#closeDumpModalBtn'), actLabel: 'Close it', icon: 'notes', dock: 'top', title: 'Dump it', text: 'Type the thought, then **Dump & Return**. It also saves when the timer runs out.', note: 'Notes expire after 48 hours. **View notes** opens once today’s required tasks are done.' },
        done(from)
      ]
    },
    proof: {
      steps: from => [
        plusBtn(),
        { selector: group('aiLockCheckbox'), live: true, lost: 1, until: () => !!$('#aiLockCheckbox')?.checked, act: () => { const c = $('#aiLockCheckbox'); if (c && !c.checked && !c.disabled) c.click(); }, actLabel: 'Tick it for me', icon: 'camera', title: 'Require AI proof', text: 'Tick **Require AI Proof Verification (Irrevocable)**. The **?** beside it explains AI usage. Nothing locks until you press **Save Task**.', note: 'Greyed out? Add an AI key in Settings → AI & Pro (Free), or check your connection.' },
        { selector: '#criteriaBoxContainer', live: true, lost: 2, icon: 'notes', title: 'Proof Criteria', text: 'Write what the proof must show, in a way a photo can prove (“2 handwritten pages with the full outline”). **Recommended** opens templates and your saved criteria. **Attach Reference Exemplar** adds one example file.' },
        { selector: '#criteriaBoxContainer', live: true, lost: 3, icon: 'test', title: 'Validate and test', text: '**Validate Criteria** scores the wording out of 10 (7 needed when strict checking is on). **Test your criteria** runs a real audit on a sample proof without saving anything.', note: 'Both use AI usage, even when the result is a fail.' },
        { selector: box('addTaskModal'), live: true, until: () => !isOpen('addTaskModal'), act: click('#closeAddTaskModalBtn'), actLabel: 'Close without saving', icon: 'lock', dock: 'top', title: 'Lock it or leave', text: '**Save Task** locks it after you confirm a warning. **Cancel** drops everything.' },
        { kind: 'center', icon: 'camera', title: 'Completing it later', text: 'Tap its circle, upload **1–5 files** (8 MB per photo, 30 MB per PDF), add an optional note and press **Submit Proof**. **7/10** passes.', visual: { type: 'pips', total: 10, on: 7, label: '7 to pass' } },
        done(from)
      ]
    },
    copilot: {
      steps: from => window.TaskitatorOffline?.active ? [
        { kind: 'center', icon: 'copilot', title: 'Copilot needs a connection', text: 'You’re offline right now, so Copilot can’t open. Try this guide again once you’re back online.' }, done(from)] : [
        { selector: ['#openCopilotFabBtn', '#openCopilotNavBtn'], live: true, until: () => !!$('#copilotDrawer')?.classList.contains('open'), act: () => ($('#openCopilotFabBtn') && shown($('#openCopilotFabBtn')) ? $('#openCopilotFabBtn') : $('#openCopilotNavBtn'))?.click(), icon: 'copilot', title: 'Open Copilot', text: 'Tap **Copilot**.' },
        { selector: '#copilotDrawer', live: true, until: () => !$('#copilotDrawer')?.classList.contains('open'), act: click('#closeCopilotBtn'), actLabel: 'Close it', icon: 'copilot', title: 'Ask it', text: 'Press **Start Conversation** and type, for example “What should I do first today?”. It can create and change ordinary tasks, but never AI-locked work or a bypass. Free needs your own AI key; Pro works without one. Close it to continue.' },
        done(from)
      ]
    }
  };
  // Older guided tours that run on Today.
  const INDEX_TOURS = new Set(['account', 'breaks']);

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (fn()) return true; } catch { /* keep waiting */ } await sleep(100); }
    return false;
  }
  let busy = false;
  async function run(key, from) {
    const S = window.TaskitatorSpotlight;
    if (busy || !S || S.isActive()) return false;
    const def = LIVE[key];
    if (!def && !INDEX_TOURS.has(key)) { window.TaskitatorTutorials?.launch(key); return true; }
    busy = true;
    try {
      const hash = def?.view || '#today', shell = def?.shell || 'tasks';
      if (location.hash !== hash) location.hash = hash;
      await waitFor(() => window.TaskitatorShell?.current() === shell, 3000);
      await sleep(350);
      for (let i = 0; i < 12; i++) {
        const ok = def ? S.start({ steps: def.steps(from), chapter: 'Help · Try it live' }) : window.TaskitatorTutorials?.start(key);
        if (ok) return true;
        await sleep(300); // start() waits for any open panel to close
      }
      return false;
    } finally { busy = false; }
  }

  // ---- index highlight ----
  function flash(id) {
    const node = id && document.getElementById(id);
    if (!node || !node.closest('.hp')) return;
    const sec = node.classList.contains('hp-alias') ? node.parentElement : node;
    sec.classList.remove('hp-flash');
    void sec.offsetWidth; // restart the animation when the same link is used twice
    sec.classList.add('hp-flash');
    clearTimeout(sec._hpFlash);
    sec._hpFlash = setTimeout(() => sec.classList.remove('hp-flash'), 2000);
  }
  const helpAnchor = () => { const h = decodeURIComponent(location.hash.slice(1)).toLowerCase(); return h.startsWith('help-') ? h : ''; };
  const afterScroll = fn => requestAnimationFrame(() => requestAnimationFrame(fn));

  document.addEventListener('click', e => {
    const tour = e.target.closest?.('[data-help-tour]');
    if (tour) { e.preventDefault(); run(tour.dataset.helpTour, tour.dataset.helpFrom || 'help'); return; }
    const a = e.target.closest?.('.hp a[href^="#help-"]');
    if (!a) return;
    const id = a.getAttribute('href').slice(1);
    if (location.hash.slice(1).toLowerCase() === id) {
      // Same link again: the hash doesn't change, so scroll here.
      e.preventDefault();
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
      afterScroll(() => flash(id));
    }
  });
  window.addEventListener('hashchange', () => { const id = helpAnchor(); if (id) afterScroll(() => flash(id)); });
  window.addEventListener('taskitator-auth-ready', () => { const id = helpAnchor(); if (id) setTimeout(() => flash(id), 400); });

  window.TaskitatorHelpTours = Object.freeze({ run, flash, keys: () => Object.keys(LIVE) });
})();
