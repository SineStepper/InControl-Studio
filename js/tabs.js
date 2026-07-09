/* tabs.js — simple tab switcher with #hash deep-linking. */
(function () {
  'use strict';
  const VIEWS = ['customizer', 'studio', 'bridge'];

  function activate(name) {
    if (!VIEWS.includes(name)) name = 'customizer';
    VIEWS.forEach((v) => {
      const view = document.getElementById('view-' + v);
      const tab = document.querySelector('.tab[data-view="' + v + '"]');
      if (view) view.classList.toggle('active', v === name);
      if (tab) tab.classList.toggle('active', v === name);
    });
    if (history.replaceState) history.replaceState(null, '', '#' + name);
    else location.hash = name;
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tab').forEach((t) =>
      t.addEventListener('click', () => activate(t.dataset.view))
    );
    activate((location.hash || '').replace('#', '') || 'customizer');
  });
})();
