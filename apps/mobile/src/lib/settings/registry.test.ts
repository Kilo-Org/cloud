import { Effect, Either } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCondenseToolCalls,
  setCondenseToolCalls,
} from '@/lib/hooks/use-condense-tool-calls-preference';
import { setLanguagePreferenceAsync } from '@/lib/hooks/use-language-preference';
import { setDefaultModelForContext } from '@/lib/hooks/use-persisted-agent-model';
import { setThemePreference } from '@/lib/hooks/use-theme-preference';
import { setTrustedHosts } from '@/lib/hooks/use-trusted-hosts';

import { APP_SETTINGS, settingNamed, settingsService } from './registry';

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-secure-store', () => secureStore);

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const appearance = vi.hoisted(() => ({ setColorScheme: vi.fn() }));
vi.mock('react-native', () => ({ Appearance: appearance }));

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));

const notificationMutation = vi.hoisted(() => ({
  mutate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    user: { setNotificationPreferences: { mutate: notificationMutation.mutate } },
  },
}));

const queryClientMock = vi.hoisted(() => ({
  getQueryData: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/query-client', () => ({ queryClient: queryClientMock }));

beforeEach(() => {
  secureStore.getItemAsync.mockClear();
  secureStore.setItemAsync.mockClear();
  appearance.setColorScheme.mockClear();
});

describe('APP_SETTINGS', () => {
  it('describes every setting with a name, a kind and a description', () => {
    expect(APP_SETTINGS.length).toBeGreaterThan(0);
    for (const setting of APP_SETTINGS) {
      expect(setting.name).not.toBe('');
      expect(setting.description).not.toBe('');
      if (setting.kind === 'enum') {
        expect(setting.options ?? []).not.toHaveLength(0);
      }
    }
  });

  it('carries the destructive flag on the trusted-host list only', () => {
    const destructive = APP_SETTINGS.filter(setting => setting.destructive === true);
    expect(destructive.map(setting => setting.name)).toEqual(['trustedHosts']);
  });

  it('resolves a setting by name and nothing for an unknown one', () => {
    expect(settingNamed('theme')?.kind).toBe('enum');
    expect(settingNamed('nope')).toBeUndefined();
  });
});

describe('settingsService one source of truth', () => {
  it('exposes the descriptors the tool lists', () => {
    expect(settingsService().settings).toBe(APP_SETTINGS);
  });

  it('reads the theme a manual setter wrote', () => {
    setThemePreference('dark');
    expect(Effect.runSync(settingsService().read('theme'))).toBe('dark');

    setThemePreference('light');
    expect(Effect.runSync(settingsService().read('theme'))).toBe('light');
  });

  it('reads a boolean a manual setter wrote', () => {
    setCondenseToolCalls(true);
    expect(Effect.runSync(settingsService().read('condenseToolCalls'))).toBe(true);

    setCondenseToolCalls(false);
    expect(Effect.runSync(settingsService().read('condenseToolCalls'))).toBe(false);
  });

  it('reads the language a manual setter wrote', async () => {
    await expect(setLanguagePreferenceAsync('fr')).resolves.toBe(true);
    expect(Effect.runSync(settingsService().read('language'))).toBe('fr');
  });

  it('reads the model default of the context the service was built for', () => {
    setDefaultModelForContext('org_1', { model: 'anthropic/claude', variant: 'thinking' });

    const forOrg = settingsService('org_1');
    expect(Effect.runSync(forOrg.read('defaultModel'))).toBe('anthropic/claude');
    expect(Effect.runSync(forOrg.read('defaultVariant'))).toBe('thinking');

    // Another context is untouched: the model default is per organization.
    expect(Effect.runSync(settingsService().read('defaultModel'))).toBe('');
    expect(Effect.runSync(settingsService().read('defaultVariant'))).toBe('');
  });

  it('reads the trusted hosts a manual setter wrote', () => {
    setTrustedHosts(['github.com']);
    expect(Effect.runSync(settingsService().read('trustedHosts'))).toEqual(['github.com']);
  });

  it('writes through the same store a manual read then sees', () => {
    const report = Effect.runSync(settingsService().write('condenseToolCalls', true));
    expect(report).toContain('condenseToolCalls');
    expect(report).toContain('true');

    expect(getCondenseToolCalls()).toBe(true);
    expect(Effect.runSync(settingsService().read('condenseToolCalls'))).toBe(true);
  });

  it('writes a theme the manual reader then sees', () => {
    const report = Effect.runSync(settingsService().write('theme', 'dark'));
    expect(report).toContain('theme');
    expect(report).toContain('dark');
    expect(appearance.setColorScheme).toHaveBeenCalledWith('dark');
    expect(Effect.runSync(settingsService().read('theme'))).toBe('dark');
  });

  it('rejects an unknown setting name on read and on write', () => {
    const read = Effect.runSync(Effect.either(settingsService().read('nope')));
    expect(Either.isLeft(read)).toBe(true);
    if (Either.isLeft(read)) {
      expect(String(read.left.cause)).toContain('Unknown setting');
    }

    const write = Effect.runSync(Effect.either(settingsService().write('nope', 'true')));
    expect(Either.isLeft(write)).toBe(true);
  });

  it('rejects a value outside an enum and a boolean that is not true or false', () => {
    const badEnum = Effect.runSync(Effect.either(settingsService().write('theme', 'purple')));
    expect(Either.isLeft(badEnum)).toBe(true);

    const badBoolean = Effect.runSync(
      Effect.either(settingsService().write('condenseToolCalls', 'yes'))
    );
    expect(Either.isLeft(badBoolean)).toBe(true);
  });

  it('reads and rejects a non-list write for the trusted hosts', () => {
    const bad = Effect.runSync(
      Effect.either(settingsService().write('trustedHosts', 'github.com'))
    );
    expect(Either.isLeft(bad)).toBe(true);
  });

  it('reports what changed on every boolean write', () => {
    for (const name of ['hideThinking', 'keepScreenOn', 'hideBalance']) {
      const report = Effect.runSync(settingsService().write(name, false));
      expect(report).toContain(name);
      expect(report).toContain('false');
    }
  });
});
