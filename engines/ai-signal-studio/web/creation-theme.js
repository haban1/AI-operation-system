(() => {
  const apply = () => {
    let theme = 'day';
    try { theme = localStorage.getItem('ui-theme') === 'night' ? 'night' : 'day'; } catch {}
    document.documentElement.dataset.theme = theme;
  };
  apply();
  window.addEventListener('storage', event => { if (event.key === 'ui-theme') apply(); });
})();
