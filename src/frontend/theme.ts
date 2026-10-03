import { icon } from './ui';

export type ThemePreference = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'lily-theme';
export const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function themePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'auto';
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'auto' ? (systemDark ? 'dark' : 'light') : preference;
}

interface ThemeEnvironment {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  systemDark(): boolean;
  listenSystem(callback: () => void): () => void;
  listenStorage(callback: (key: string | null, value: string | null) => void): () => void;
  apply(preference: ThemePreference, theme: ResolvedTheme): void;
}
export interface ThemeController {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
  select(value: ThemePreference): void;
  dispose(): void;
}

// Persistence is a convenience: a storage failure must never prevent a theme change.
export function createThemeController(environment: ThemeEnvironment): ThemeController {
  let preference: ThemePreference = 'auto';
  try {
    preference = themePreference(environment.storage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Keep the automatic default when browser storage is unavailable.
  }
  const apply = (): void =>
    environment.apply(preference, resolveTheme(preference, environment.systemDark()));
  apply();
  const stopSystem = environment.listenSystem(() => {
    if (preference === 'auto') apply();
  });
  const stopStorage = environment.listenStorage((key, value) => {
    if (key !== THEME_STORAGE_KEY && key !== null) return;
    preference = themePreference(value);
    apply();
  });
  return {
    get preference() {
      return preference;
    },
    get resolved() {
      return resolveTheme(preference, environment.systemDark());
    },
    select(value) {
      preference = themePreference(value);
      try {
        environment.storage.setItem(THEME_STORAGE_KEY, preference);
      } catch {
        // The selection still applies for this tab when storage is restricted.
      }
      apply();
    },
    dispose() {
      stopSystem();
      stopStorage();
    },
  };
}

let controller: ThemeController | undefined;
export function initializeTheme(): ThemeController {
  if (controller) return controller;
  const media = matchMedia(THEME_MEDIA_QUERY);
  controller = createThemeController({
    // Accessing window.localStorage itself may throw, so defer it into the guarded calls.
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
    systemDark: () => media.matches,
    listenSystem(callback) {
      media.addEventListener('change', callback);
      return () => media.removeEventListener('change', callback);
    },
    listenStorage(callback) {
      const listener = (event: StorageEvent): void => {
        // An unrelated sessionStorage preference must not change the site theme.
        try {
          if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
        } catch {
          return;
        }
        callback(event.key, event.newValue);
      };
      window.addEventListener('storage', listener);
      return () => window.removeEventListener('storage', listener);
    },
    apply(preference, theme) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.themePreference = preference;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', theme === 'dark' ? '#0b0f14' : '#f1f3ee');
      updateThemeControls(preference);
    },
  });
  return controller;
}

export function themeControl(): string {
  return `<div class="theme-control" role="group" aria-label="页面主题">${(
    [
      ['auto', '自动', 'monitor', '跟随系统外观'],
      ['light', '浅色', 'sun', '使用浅色主题'],
      ['dark', '深色', 'moon', '使用深色主题'],
    ] as const
  )
    .map(
      ([value, label, symbol, title]) =>
        `<button class="theme-choice" type="button" data-theme-choice="${value}" aria-pressed="false" aria-label="${label}主题：${title}" title="${title}">${icon(symbol)}<span>${label}</span></button>`,
    )
    .join('')}</div>`;
}
function updateThemeControls(preference: ThemePreference): void {
  document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
  });
}
export function bindThemeControls(root: ParentNode): void {
  const theme = initializeTheme();
  root.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((button) => {
    button.addEventListener('click', () =>
      theme.select(themePreference(button.dataset.themeChoice)),
    );
  });
  updateThemeControls(theme.preference);
}
