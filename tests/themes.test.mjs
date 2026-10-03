import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createThemeController, themeControl, THEME_STORAGE_KEY } from '../src/frontend/theme';
function environment(saved = null, dark = false, blocked = false) {
  let systemListener = () => {};
  let storageListener = (_key, _value) => {};
  const storage = new Map(saved === null ? [] : [[THEME_STORAGE_KEY, saved]]);
  const apply = vi.fn();
  const stopSystem = vi.fn();
  const stopStorage = vi.fn();
  const options = {
    storage: {
      getItem: (key) => {
        if (blocked) throw new Error('Storage unavailable');
        return storage.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (blocked) throw new Error('Storage unavailable');
        storage.set(key, value);
      },
    },
    systemDark: () => dark,
    listenSystem: (callback) => {
      systemListener = callback;
      return stopSystem;
    },
    listenStorage: (callback) => {
      storageListener = callback;
      return stopStorage;
    },
    apply,
  };
  return {
    options,
    apply,
    storage,
    stopSystem,
    stopStorage,
    systemChange(value) {
      dark = value;
      systemListener();
    },
    storageChange(key, value) {
      storageListener(key, value);
    },
  };
}
describe('theme preference lifecycle', () => {
  it.each([false, true])(
    'follows the system by default, including live changes from dark=%s',
    (dark) => {
      const env = environment(null, dark);
      const theme = createThemeController(env.options);
      expect(theme.preference).toBe('auto');
      expect(env.apply).toHaveBeenLastCalledWith('auto', dark ? 'dark' : 'light');
      env.systemChange(!dark);
      expect(env.apply).toHaveBeenLastCalledWith('auto', dark ? 'light' : 'dark');
    },
  );
  it.each(['light', 'dark'])(
    'retains manual %s on reload and ignores device changes',
    (selection) => {
      const env = environment(null, selection === 'light');
      const theme = createThemeController(env.options);
      theme.select(selection);
      expect(env.storage.get(THEME_STORAGE_KEY)).toBe(selection);
      const calls = env.apply.mock.calls.length;
      env.systemChange(selection === 'light');
      expect(env.apply).toHaveBeenCalledTimes(calls);
      expect(theme.resolved).toBe(selection);
      const reloaded = createThemeController(
        environment(env.storage.get(THEME_STORAGE_KEY)).options,
      );
      expect(reloaded.preference).toBe(selection);
      expect(reloaded.resolved).toBe(selection);
    },
  );
  it('returns to current system appearance after choosing auto', () => {
    const env = environment('light', true);
    const theme = createThemeController(env.options);
    theme.select('auto');
    expect(env.storage.get(THEME_STORAGE_KEY)).toBe('auto');
    expect(env.apply).toHaveBeenLastCalledWith('auto', 'dark');
    env.systemChange(false);
    expect(theme.resolved).toBe('light');
  });
  it('handles denied storage and malformed preferences without losing theme controls', () => {
    const env = environment('bogus', true);
    expect(createThemeController(env.options).preference).toBe('auto');
    const blocked = environment(null, true, true);
    const theme = createThemeController(blocked.options);
    expect(theme.resolved).toBe('dark');
    expect(() => theme.select('light')).not.toThrow();
    expect(blocked.apply).toHaveBeenLastCalledWith('light', 'light');
  });
  it('synchronizes other tabs, resets cleared storage, and ignores unrelated keys', () => {
    const env = environment('light', true);
    const theme = createThemeController(env.options);
    env.storageChange('unrelated', 'dark');
    expect(theme.preference).toBe('light');
    env.storageChange(THEME_STORAGE_KEY, 'dark');
    expect(theme.resolved).toBe('dark');
    env.storageChange(THEME_STORAGE_KEY, 'invalid');
    expect(theme.preference).toBe('auto');
    env.storageChange(null, null);
    expect(env.apply).toHaveBeenLastCalledWith('auto', 'dark');
    theme.dispose();
    expect(env.stopSystem).toHaveBeenCalledOnce();
    expect(env.stopStorage).toHaveBeenCalledOnce();
  });
  it('provides three labeled, keyboard-operable choices', () => {
    const markup = themeControl();
    expect(markup).toContain('role="group" aria-label="页面主题"');
    for (const choice of ['auto', 'light', 'dark'])
      expect(markup).toContain(`data-theme-choice="${choice}"`);
    expect(markup.match(/type="button"/g)).toHaveLength(3);
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(3);
  });
});
describe('first paint theme initialization', () => {
  const boot = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  it('loads a blocking same-origin script before application styles without weakening CSP', () => {
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('/src/frontend/main.ts'));
    const security = readFileSync(new URL('../src/api/security.ts', import.meta.url), 'utf8');
    expect(security).toContain("script-src 'self'; style-src 'self'");
    expect(security).not.toContain('unsafe-inline');
  });
  it.each([
    [null, false, 'auto', 'light'],
    [null, true, 'auto', 'dark'],
    ['light', true, 'light', 'light'],
    ['dark', false, 'dark', 'dark'],
    ['auto', true, 'auto', 'dark'],
    ['invalid', true, 'auto', 'dark'],
  ])(
    'sets the first frame for preference=%s / systemDark=%s',
    (saved, systemDark, preference, resolved) => {
      const dataset = {};
      const meta = { setAttribute: vi.fn() };
      runInNewContext(boot, {
        localStorage: { getItem: () => saved },
        matchMedia: () => ({ matches: systemDark }),
        document: { documentElement: { dataset }, querySelector: () => meta },
      });
      expect(dataset).toEqual({ theme: resolved, themePreference: preference });
      expect(meta.setAttribute).toHaveBeenLastCalledWith(
        'content',
        resolved === 'dark' ? '#0b0f14' : '#f1f3ee',
      );
      const runtime = createThemeController(environment(saved, systemDark).options);
      expect(runtime.preference).toBe(preference);
      expect(runtime.resolved).toBe(resolved);
    },
  );
  it('applies the system theme before paint even if storage throws', () => {
    const dataset = {};
    runInNewContext(boot, {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
      },
      matchMedia: () => ({ matches: true }),
      document: { documentElement: { dataset }, querySelector: () => null },
    });
    expect(dataset.theme).toBe('dark');
  });
});
// Small labels and status evidence must stay readable on mist/sidebar/card surfaces.
function luminance(hex) {
  const values = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe('coordinated palette readability', () => {
  const source = readFileSync(new URL('../src/frontend/themes.css', import.meta.url), 'utf8');
  for (const [theme, expression] of [
    ['light', /:root\s*{([^}]+)}/],
    ['dark', /:root\[data-theme='dark'\]\s*{([^}]+)}/],
  ]) {
    const body = source.match(expression)[1];
    const tokens = Object.fromEntries(
      [...body.matchAll(/--([a-z-]+):\s*(#[a-f0-9]{6});/g)].map((match) => [match[1], match[2]]),
    );
    it(`${theme} text and health status exceed 4.5:1 on all main surfaces`, () => {
      for (const foreground of [
        'text',
        'text-secondary',
        'muted',
        'subtle',
        'accent',
        'gold',
        'good',
        'review',
        'bad',
        'neutral',
      ]) {
        for (const background of [
          'bg',
          'sidebar',
          'panel',
          'surface-raised',
          'surface-sunken',
          'surface-hover',
        ]) {
          expect(
            contrast(tokens[foreground], tokens[background]),
            `${theme} ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(tokens['on-primary'], tokens.primary)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
