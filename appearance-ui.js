/* Settings -> General: Language, Colour theme + Appearance cards. Per device only: writes go to
   TaskitatorAppearance (localStorage 'taskitator_appearance'), never to synced settings,
   so these controls do not mark the settings page as unsaved. */
(function () {
    'use strict';
    const reg = window.TaskitatorThemes, app = window.TaskitatorAppearance;
    const options = document.getElementById('themeOptions');
    if (!reg || !app || !options) return;
    const note = document.getElementById('themeProNote');
    const fx = () => window.TaskitatorFX;
    const icons = window.TaskitatorIcons;

    function openProTab(e) {
        e.preventDefault();
        const tab = document.getElementById('tabbtn-ai');
        if (tab) { tab.click(); tab.scrollIntoView({ block: 'nearest' }); } else location.hash = 'ai';
    }
    function showLocked(theme, target, text) {
        const out = target || note;
        if (!out) return;
        out.replaceChildren(document.createTextNode(text || theme.label + ' is a Pro theme. '));
        const link = document.createElement('a');
        link.href = 'settings.html#ai';
        link.textContent = 'See AI & Pro';
        link.addEventListener('click', openProTab);
        out.append(link);
        out.hidden = false;
        fx()?.deny?.();
    }

    // Phase 6.7.1: a theme or Icon mix pick waits for "Save changes" (settings.html). Nothing is applied, stored or
    // synced until then; Discard or leaving the page drops it. { theme: id|null, mix: [ids]|null }
    let pending = null;
    const markDirty = () => window.dispatchEvent(new CustomEvent('taskitator-settings-dirty'));
    const shownTheme = state => pending?.theme ?? state.effective;
    const shownMix = state => pending?.mix ?? state.mix;
    const packsShown = state => {
        const main = shownTheme(state);
        return [main, ...shownMix(state).filter(id => id !== main && app.isAllowed(id))];
    };

    function renderThemes() {
        const state = app.read();
        const allowed = app.allowed();
        const current = shownTheme(state);
        options.replaceChildren(...reg.live().map(theme => {
            const locked = !allowed.includes(theme.id);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tk-theme-option' + (locked ? ' is-locked' : '');
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', String(current === theme.id && !locked));
            if (current === theme.id) btn.classList.add('is-on');
            if (pending?.theme === theme.id) btn.classList.add('is-pending');
            btn.dataset.theme = theme.id;
            const sw = document.createElement('span');
            sw.className = 'tk-swatch';
            sw.setAttribute('aria-hidden', 'true');
            theme.swatch.forEach(c => { const i = document.createElement('i'); i.style.background = c; sw.append(i); });
            const label = document.createElement('span');
            label.className = 'tk-theme-label';
            label.textContent = theme.label;
            btn.append(sw, label);
            if (theme.tier !== 'free') {
                const badge = document.createElement('span');
                badge.className = 'tk-pro-badge';
                if (locked && icons) badge.append(icons.node('lock'));
                badge.append(document.createTextNode('Pro'));
                btn.append(badge);
            }
            if (locked) {
                btn.setAttribute('aria-disabled', 'true');
                btn.setAttribute('aria-label', theme.label + ', Pro theme, locked');
            }
            btn.addEventListener('click', () => {
                if (locked) { showLocked(theme); return; }
                if (note) note.hidden = true;
                if (theme.id === current) return;
                pending = { theme: theme.id, mix: pending?.mix ?? null };
                fx()?.tap?.();
                markDirty();
                renderThemes();
                renderMix();
            });
            return btn;
        }));
    }

    // Phase 6.7 Icon mix (Pro): one box per theme pack. The current theme's pack is always on and cannot be unticked;
    // each box shows the share of tasks it gets now (WEIGHTS in icons.js).
    const mixBox = document.getElementById('iconMixOptions');
    const mixNote = document.getElementById('iconMixNote');
    function renderMix() {
        if (!mixBox || !icons?.PACKS) return;
        const state = app.read();
        const pro = app.mixAllowed();
        const inUse = packsShown(state);
        const share = icons.WEIGHTS[inUse.length] || [100];
        const mainId = shownTheme(state);
        mixBox.replaceChildren(...reg.live().filter(t => icons.PACKS[t.id]).map(theme => {
            const main = theme.id === mainId;
            const idx = inUse.indexOf(theme.id);
            const on = main || idx > -1;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tk-mix-option' + (on ? ' is-on' : '') + (main ? ' is-main' : '') + (!pro && !main ? ' is-locked' : '');
            btn.setAttribute('role', 'checkbox');
            btn.setAttribute('aria-checked', String(on));
            btn.dataset.pack = theme.id;
            if (main || !pro) btn.setAttribute('aria-disabled', 'true');
            const art = icons.node('animal-' + icons.PACKS[theme.id][0], 'tk-mix-art');
            const label = document.createElement('span');
            label.className = 'tk-theme-label';
            label.textContent = theme.label;
            const meta = document.createElement('span');
            meta.className = 'tk-mix-share';
            meta.textContent = main ? 'Theme' : (on ? share[idx] + '%' : '');
            if (on) meta.title = share[idx] + '%';
            btn.append(art, label, meta);
            btn.addEventListener('click', () => {
                if (main) return;
                if (!pro) { showLocked(theme, mixNote, 'Icon mix is a Pro feature. '); return; }
                if (mixNote) mixNote.hidden = true;
                const extras = shownMix(state).filter(id => id !== mainId);
                const next = extras.includes(theme.id) ? extras.filter(id => id !== theme.id) : [...extras, theme.id];
                pending = { theme: pending?.theme ?? null, mix: next };
                fx()?.tap?.();
                markDirty();
                renderMix();
            });
            return btn;
        }));
    }

    const toggles = [...document.querySelectorAll('#appearanceCard input[data-fx]')];
    const modeBoxes = [...document.querySelectorAll('#fxModes .fx-mode')];
    const MODE_LABEL = { static: 'Static', reduced: 'Reduced', normal: 'Normal', custom: 'Custom' };
    // Phase 6.6: the four mode boxes and the effect switches. Switches only act in Normal and Custom; Normal shows them all on.
    function renderAppearance() {
        const state = app.read();
        const mode = state.anim.mode;
        const eff = app.effective();
        const locked = mode === 'static' || mode === 'reduced';
        modeBoxes.forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
        const summary = document.getElementById('fxModeSummary');
        if (summary) summary.textContent = MODE_LABEL[mode] || '';
        toggles.forEach(t => {
            t.checked = Boolean(eff[t.dataset.fx]);
            t.disabled = locked;
            t.closest('.setting-row')?.classList.toggle('is-muted', locked);
        });
    }
    modeBoxes.forEach(b => b.addEventListener('click', () => {
        if (app.setMode(b.dataset.mode)) fx()?.tap?.();
        renderAppearance();
    }));
    toggles.forEach(t => t.addEventListener('change', () => {
        app.setAnim(t.dataset.fx, t.checked);
        fx()?.tap?.();
        renderAppearance();
    }));

    // Language + time format (i18n.js, localStorage 'taskitator_lang'). Device only, never synced.
    const i18n = window.TaskitatorI18n;
    const langSelect = document.getElementById('langSelect');
    const clockSelect = document.getElementById('clockSelect');
    if (i18n && langSelect && clockSelect) {
        langSelect.value = i18n.lang;
        clockSelect.value = i18n.clock;
        langSelect.addEventListener('change', () => {
            if (!i18n.setLang(langSelect.value)) langSelect.value = i18n.lang;
        });
        clockSelect.addEventListener('change', () => {
            if (!i18n.setClock(clockSelect.value)) clockSelect.value = i18n.clock;
            fx()?.tap?.();
        });
    }

    // Save changes applies the waiting pick; Discard / a reload of the settings drops it (events fired by settings.html).
    window.addEventListener('taskitator-settings-commit', () => {
        if (!pending) return;
        const p = pending;
        pending = null;
        if (p.theme) app.setTheme(p.theme);
        if (p.mix) app.setMix(p.mix);
        renderThemes(); renderMix();
    });
    window.addEventListener('taskitator-settings-reset', () => {
        if (!pending) return;
        pending = null;
        renderThemes(); renderMix();
    });
    window.addEventListener('taskitator-appearance', () => { renderThemes(); renderMix(); renderAppearance(); });
    renderThemes();
    renderMix();
    renderAppearance();
})();
