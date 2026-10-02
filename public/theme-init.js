// Runs before styles and the application so the first painted frame uses the saved theme.
(() => {
  let preference = 'auto';
  try {
    const saved = localStorage.getItem('lily-theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {
    // Private browsing and restricted storage still follow the device theme.
  }
  let systemDark = false;
  try {
    systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    // The mist light palette is the fallback for browsers without matchMedia.
  }
  const theme = preference === 'auto' ? (systemDark ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0b0f14' : '#f1f3ee');
})();
