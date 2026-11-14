/* Phase 3.0: old page addresses keep working. Calendar, Projects, Stats, Trash, the phone blocker guide,
   Study plans, Sleep Lock and Help are views of index.html now; the legal pages and Free vs Pro live in legal.html.
   Loaded first in the <head> of components.html and of the old page stubs, so nothing else runs before the redirect. */
(function () {
    'use strict';
    var page = (location.pathname.split('/').pop() || '').toLowerCase(), hash = location.hash || '';
    var params = new URLSearchParams(location.search);
    var view = String(params.get('view') || '').toLowerCase();
    var to = null, shell = ['calendar', 'projects', 'stats', 'trash', 'blocker-guide'];
    if (page === 'components.html') {
        if (view === 'universe') return;
        if (view === 'legal' || view === 'privacy') to = 'legal.html' + hash;
        else if (view === 'terms') to = 'legal.html' + (hash || '#legalTermsSection');
        else if (view === 'compare') to = 'legal.html?view=compare' + hash;
        else {
            if (view === 'guide' || view === 'blocker_guide') view = 'blocker-guide';
            params.delete('view');
            var query = params.toString();
            var anchor = ['#bridge-download', '#bridge-manual', '#app-blocker-manual'].includes(hash.toLowerCase()) ? hash : '#blocker-guide';
            to = 'index.html' + (query ? '?' + query : '') + (view === 'blocker-guide' ? anchor : '#' + (shell.includes(view) ? view : 'projects'));
        }
    } else if (page === 'sleep.html') to = 'index.html#sleep';
    else if (page === 'study-plans.html') to = 'index.html#study-plans';
    else if (page === 'help.html') to = 'index.html#' + (hash.length > 1 ? 'help-' + hash.slice(1) : 'help');
    if (to) location.replace(to);
})();
