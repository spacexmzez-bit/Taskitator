/* components.html is the Universe page since Phase 3.0 (its other views moved into the index.html shell;
   legacy-redirect.js sends old ?view= addresses there). Shows the Universe pane once the app files have run. */
(function () {
    'use strict';
    const pane = document.getElementById('componentView-universe');
    if (pane) pane.style.display = 'block';
    const title = document.getElementById('componentPageTitle');
    if (title) title.textContent = 'Universe';
    window.dispatchEvent(new Event('taskitator-universe-view'));
})();
