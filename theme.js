(() => {
  const storageKey = 'takken-theme';
  const root = document.documentElement;
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  let preference;
  let toggle;

  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {
    // The switch still works when the browser blocks storage.
  }

  function applyTheme() {
    const theme = preference ?? (systemTheme?.matches ? 'dark' : 'light');
    root.dataset.theme = theme;
    toggle?.setAttribute('aria-checked', String(theme === 'dark'));
  }

  applyTheme();
  systemTheme?.addEventListener?.('change', applyTheme);

  document.addEventListener('DOMContentLoaded', () => {
    toggle = document.getElementById('themeToggle');
    if (!toggle) return;

    applyTheme();
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      try {
        window.localStorage.setItem(storageKey, preference);
      } catch {
        // Keep the choice for the current page.
      }
    });
  }, {once: true});
})();
