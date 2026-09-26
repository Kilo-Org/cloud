import { Effect, Either } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCondenseToolCalls,
  setCondenseToolCalls,
} from '@/lib/hooks/use-condense-tool-calls-preference';
import { setLanguagePreferenceAsync } from '@/lib/hooks/use-language-preference';
import { getLiveActivityEnabled } from '@/lib/hooks/use-live-activity-preference';
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

// The language write runs the manual picker's apply path, which touches the
// native i18n instance, Expo's reload and the device stores. This suite proves
// the catalog delegates to it and reports its outcome, so the path is stubbed
// here and its own behaviour is covered by the language-picker suite.
const applyLanguagePreference = vi.hoisted(() =>
  vi.fn<(preference: string, resolved: string) => Promise<{ kind: string }>>()
);
vi.mock('@/i18n/apply-language', () => ({ applyLanguagePreference }));

const notificationMutation = vi.hoisted(() => ({
  mutate: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({
    chatMessages: false,
    agentAttention: true,
    agentUpdates: true,
    sessionStatus: true,
    kiloclawActivity: true,
    balanceAlerts: true,
    securityFindings: true,
    agentPushEnabled: true,
    notificationPreviews: 'full',
  }),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    user: {
      getNotificationPreferences: { query: notificationMutation.query },
      setNotificationPreferences: { mutate: notificationMutation.mutate },
    },
  },
}));

const queryClientMock = vi.hoisted(() => ({
  getQueryData: vi.fn(),
  ensureQueryData: vi.fn(async ({ queryFn }: { queryFn: () => Promise<unknown> }) => {
    const result = await queryFn();
    return result;
  }),
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

  it('lists the live activity toggle as a boolean', () => {
    expect(settingNamed('liveActivity')?.kind).toBe('boolean');
  });

  it('writes the live activity toggle into the store the manual screen reads', () => {
    const report = Effect.runSync(settingsService().write('liveActivity', false));
    expect(report).toContain('liveActivity');
    expect(report).toContain('false');
    expect(getLiveActivityEnabled()).toBe(false);
    expect(Effect.runSync(settingsService().read('liveActivity'))).toBe(false);

    const on = Effect.runSync(settingsService().write('liveActivity', true));
    expect(on).toContain('liveActivity');
    expect(on).toContain('true');
    expect(getLiveActivityEnabled()).toBe(true);
    expect(Effect.runSync(settingsService().read('liveActivity'))).toBe(true);
  });

  it('refuses a non-boolean value for the live activity toggle', () => {
    const refused = Effect.runSync(Effect.either(settingsService().write('liveActivity', 'yes')));
    expect(Either.isLeft(refused)).toBe(true);
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

  it('reads the trusted hosts a manual setter wrote', async () => {
    await setTrustedHosts(['github.com']);
    expect(Effect.runSync(settingsService().read('trustedHosts'))).toEqual(['github.com']);
  });

  it('loads notification preferences before reporting their current values', async () => {
    expect(await Effect.runPromise(settingsService().read('notifications.chatMessages'))).toBe(
      false
    );
    expect(await Effect.runPromise(settingsService().read('notifications.previews'))).toBe('full');
    expect(notificationMutation.query).toHaveBeenCalled();
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
    for (const name of ['hideThinking', 'keepScreenOn', 'liveActivity', 'hideBalance']) {
      const report = Effect.runSync(settingsService().write(name, false));
      expect(report).toContain(name);
      expect(report).toContain('false');
    }
  });
});

/**
 * The agent's language write has to apply the way the manual picker does: the
 * stored preference alone leaves the running app in its old language, so the
 * write goes through the picker's own apply path and reports what happened.
 */
describe('the language write applies the change', () => {
  beforeEach(() => {
    applyLanguagePreference.mockReset();
    applyLanguagePreference.mockResolvedValue({ kind: 'applied-ltr' });
  });

  it('applies an LTR language through the manual picker path and reports it', async () => {
    const report = await Effect.runPromise(settingsService().write('language', 'es'));

    expect(applyLanguagePreference).toHaveBeenCalledWith('es', 'es');
    expect(report).toBe('language set to es');
  });

  it('resolves "device" to the device language before applying it', async () => {
    const report = await Effect.runPromise(settingsService().write('language', 'device'));

    expect(applyLanguagePreference).toHaveBeenCalledWith('device', 'en');
    expect(report).toBe('language set to device');
  });

  it('reports a direction change that restarts the app as applied', async () => {
    applyLanguagePreference.mockResolvedValue({ kind: 'restarting-rtl' });

    await expect(Effect.runPromise(settingsService().write('language', 'ar'))).resolves.toBe(
      'language set to ar'
    );
  });

  it.each([
    ['persist-failed', 'could not be saved'],
    ['reload-failed', 'could not restart'],
    ['catalog-failed', 'catalog could not be loaded'],
  ])('refuses to claim success when the apply fails (%s)', async (kind, fragment) => {
    applyLanguagePreference.mockResolvedValue({ kind });

    const refused = await Effect.runPromise(
      Effect.either(settingsService().write('language', 'es'))
    );

    expect(Either.isLeft(refused)).toBe(true);
    if (Either.isLeft(refused)) {
      expect(String(refused.left.cause)).toContain(fragment);
    }
  });
});
