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
    function showLocked(theme) {
        if (!note) return;
        note.replaceChildren(document.createTextNode(theme.label + ' is a Pro theme. '));
        const link = document.createElement('a');
        link.href = 'settings.html#ai';
        link.textContent = 'See AI & Pro';
        link.addEventListener('click', openProTab);
        note.append(link);
        note.hidden = false;
        fx()?.deny?.();
    }

    function renderThemes() {
        const state = app.read();
        const allowed = app.allowed();
        options.replaceChildren(...reg.live().map(theme => {
            const locked = !allowed.includes(theme.id);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tk-theme-option' + (locked ? ' is-locked' : '');
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', String(state.theme === theme.id && !locked) );
            if (state.effective === theme.id) btn.classList.add('is-on');
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
                if (app.setTheme(theme.id)) fx()?.tap?.();
                renderThemes();
            });
            return btn;
        }));
    }

    const toggles = [...document.querySelectorAll('#appearanceCard input[data-fx]')];
    function renderAppearance() {
        const state = app.read();
        toggles.forEach(t => {
            t.checked = Boolean(state.anim[t.dataset.fx]);
            if (t.dataset.fx !== 'reduce') t.closest('.setting-row')?.classList.toggle('is-muted', state.anim.reduce);
        });
    }
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

    window.addEventListener('taskitator-appearance', () => { renderThemes(); renderAppearance(); });
    renderThemes();
    renderAppearance();
})();
