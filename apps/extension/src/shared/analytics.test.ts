/* eslint-disable max-lines */
import { describe, expect, it, vi } from 'vitest';

interface MockClient {
  capture: ReturnType<typeof vi.fn>;
  identify: ReturnType<typeof vi.fn>;
  init: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
  const clients: MockClient[] = [];

  class MockPostHog {
    capture = vi.fn();
    identify = vi.fn();
    init = vi.fn();
    register = vi.fn();
    reset = vi.fn();

    constructor() {
      clients.push(this);
    }
  }

  return { MockPostHog, clients };
});

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('posthog-js/dist/module.no-external', () => ({
  PostHog: mocks.MockPostHog,
}));

// eslint-disable-next-line import/first
import {
  ANALYTICS_LAST_ACTIVE_DAY_STORAGE_KEY,
  ANALYTICS_OPT_OUT_STORAGE_KEY,
  ANALYTICS_SURFACE,
  EXTENSION_ACTIVE_EVENT,
  EXTENSION_SIGNED_OUT_EVENT,
  __setExtensionVersionReaderForTests,
  __setFirefoxPermissionsReaderForTests,
  captureDailyActive,
  captureEvent,
  getFirefoxUsageDataGranted,
  initAnalytics,
  loadAnalyticsOptOut,
  resetAnalyticsUser,
  setAnalyticsOptOut,
  shouldStartAnalytics,
} from './analytics';
// eslint-disable-next-line import/first
import type { AnalyticsStorageArea } from './analytics';

const API_KEY = 'phc_test_key';
const EMAIL = 'user@kilo.ai';
const EXTENSION_VERSION = '1.0.3';

const EXPECTED_INIT_OPTIONS = {
  advanced_disable_flags: true,
  api_host: 'https://us.i.posthog.com',
  autocapture: false,
  capture_pageleave: false,
  capture_pageview: false,
  disable_external_dependency_loading: true,
  disable_session_recording: true,
  persistence: 'localStorage',
} as const;

/** Every key the analytics module may touch; anything else is a bug. */
const ANALYTICS_STORAGE_KEY_ALLOWLIST: Record<string, true> = {
  [ANALYTICS_LAST_ACTIVE_DAY_STORAGE_KEY]: true,
  [ANALYTICS_OPT_OUT_STORAGE_KEY]: true,
};

const ALLOWED_STRING_ENUMS = new Set([
  'agents',
  'dangerous',
  'device_auth',
  'expired',
  'explicit',
  'extension',
  'safe',
  'stored_session',
]);

const createStorage = (
  initial?: unknown
): AnalyticsStorageArea & { readonly lastActiveDay: unknown; readonly value: unknown } => {
  const values = new Map<string, unknown>();
  if (initial !== undefined) {
    values.set(ANALYTICS_OPT_OUT_STORAGE_KEY, initial);
  }

  return {
    getItem: key => {
      expect(ANALYTICS_STORAGE_KEY_ALLOWLIST[key]).toBe(true);
      return values.get(key);
    },
    setItem: (key, value) => {
      expect(ANALYTICS_STORAGE_KEY_ALLOWLIST[key]).toBe(true);
      values.set(key, value);
    },
    get lastActiveDay() {
      return values.get(ANALYTICS_LAST_ACTIVE_DAY_STORAGE_KEY);
    },
    get value() {
      return values.get(ANALYTICS_OPT_OUT_STORAGE_KEY);
    },
  };
};

const createDeferredStorage = (): AnalyticsStorageArea & {
  resolveGet: (value: unknown) => void;
  readonly value: unknown;
} => {
  let storedValue: unknown = false;
  const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();

  return {
    getItem: key => {
      expect(ANALYTICS_STORAGE_KEY_ALLOWLIST[key]).toBe(true);
      // eslint-disable-next-line promise/prefer-await-to-then
      return gate.then(() => storedValue);
    },
    resolveGet: (value: unknown) => {
      storedValue = value;
      openGate();
    },
    setItem: (key, value) => {
      expect(ANALYTICS_STORAGE_KEY_ALLOWLIST[key]).toBe(true);
      storedValue = value;
    },
    get value() {
      return storedValue;
    },
  };
};

const withEnv = async (
  env: {
    readonly DEV?: boolean;
    readonly FIREFOX?: 'true' | 'false';
    readonly VITE_POSTHOG_API_KEY?: string;
  },
  run: () => Promise<void> | void
): Promise<void> => {
  vi.unstubAllEnvs();
  if (env.DEV !== undefined) {
    vi.stubEnv('DEV', env.DEV);
  }
  if (env.FIREFOX !== undefined) {
    vi.stubEnv('FIREFOX', env.FIREFOX);
  }
  if (env.VITE_POSTHOG_API_KEY !== undefined) {
    vi.stubEnv('VITE_POSTHOG_API_KEY', env.VITE_POSTHOG_API_KEY);
  }
  try {
    await run();
  } finally {
    vi.unstubAllEnvs();
  }
};

const productionEnv = {
  DEV: false,
  VITE_POSTHOG_API_KEY: API_KEY,
} as const;

const allCaptureCalls = (): unknown[][] =>
  mocks.clients.flatMap(client => client.capture.mock.calls);

const isPlainPropertiesRecord = (
  value: unknown
): value is Record<string, string | number | boolean> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    entry => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
  );
};

const assertCapturedPropertiesAreEnums = (): void => {
  for (const call of allCaptureCalls()) {
    const [, properties] = call;
    if (isPlainPropertiesRecord(properties)) {
      for (const value of Object.values(properties)) {
        if (typeof value === 'string') {
          expect(ALLOWED_STRING_ENUMS.has(value)).toBe(true);
        } else {
          expect(['boolean', 'number']).toContain(typeof value);
        }
      }
    }
  }
};

const resetModule = async (): Promise<void> => {
  __setFirefoxPermissionsReaderForTests();
  __setExtensionVersionReaderForTests();
  vi.unstubAllEnvs();
  await resetAnalyticsUser({ reason: 'explicit' });
  mocks.clients.length = 0;
};

describe('analytics gating', () => {
  it('allows start only when every gate passes', async () => {
    await resetModule();
    expect(
      shouldStartAnalytics({
        firefoxUsageDataGranted: true,
        hasApiKey: true,
        hasEmail: true,
        isDev: false,
        optedOut: false,
      })
    ).toBe(true);
  });

  it.each([
    ['isDev', { isDev: true }],
    ['hasApiKey', { hasApiKey: false }],
    ['hasEmail', { hasEmail: false }],
    ['optedOut', { optedOut: true }],
    ['firefoxUsageDataGranted', { firefoxUsageDataGranted: false }],
  ] as const)('vetoes when %s fails', async (_label, override) => {
    await resetModule();
    expect(
      shouldStartAnalytics({
        firefoxUsageDataGranted: true,
        hasApiKey: true,
        hasEmail: true,
        isDev: false,
        optedOut: false,
        ...override,
      })
    ).toBe(false);
  });

  it('covers multi-gate combinations independently', async () => {
    await resetModule();
    const cases = [
      {
        firefoxUsageDataGranted: true,
        hasApiKey: true,
        hasEmail: true,
        isDev: true,
        optedOut: false,
      },
      {
        firefoxUsageDataGranted: true,
        hasApiKey: false,
        hasEmail: true,
        isDev: false,
        optedOut: false,
      },
      {
        firefoxUsageDataGranted: true,
        hasApiKey: true,
        hasEmail: false,
        isDev: false,
        optedOut: false,
      },
      {
        firefoxUsageDataGranted: true,
        hasApiKey: true,
        hasEmail: true,
        isDev: false,
        optedOut: true,
      },
      {
        firefoxUsageDataGranted: false,
        hasApiKey: true,
        hasEmail: true,
        isDev: false,
        optedOut: false,
      },
    ] as const;

    for (const input of cases) {
      expect(shouldStartAnalytics(input)).toBe(false);
    }
  });
});

describe('firefox usage data grant', () => {
  it('returns true on non-Firefox builds without reading permissions', async () => {
    await resetModule();
    const reader = vi.fn();
    __setFirefoxPermissionsReaderForTests(reader);

    await withEnv({ FIREFOX: 'false' }, async () => {
      await expect(getFirefoxUsageDataGranted()).resolves.toBe(true);
      expect(reader).not.toHaveBeenCalled();
    });
  });

  it('returns false when data_collection key is absent', async () => {
    await resetModule();
    __setFirefoxPermissionsReaderForTests(() => ({ permissions: [] }));

    await withEnv({ FIREFOX: 'true' }, async () => {
      await expect(getFirefoxUsageDataGranted()).resolves.toBe(false);
    });
  });

  it('returns false when technicalAndInteraction is not granted', async () => {
    await resetModule();
    __setFirefoxPermissionsReaderForTests(() => ({
      data_collection: ['personallyIdentifyingInfo'],
    }));

    await withEnv({ FIREFOX: 'true' }, async () => {
      await expect(getFirefoxUsageDataGranted()).resolves.toBe(false);
    });
  });

  it('returns true when technicalAndInteraction is granted', async () => {
    await resetModule();
    __setFirefoxPermissionsReaderForTests(() => ({
      data_collection: ['technicalAndInteraction'],
    }));

    await withEnv({ FIREFOX: 'true' }, async () => {
      await expect(getFirefoxUsageDataGranted()).resolves.toBe(true);
    });
  });

  it('returns false for invalid browser API responses', async () => {
    await resetModule();
    __setFirefoxPermissionsReaderForTests(() => 'not-an-object');

    await withEnv({ FIREFOX: 'true' }, async () => {
      await expect(getFirefoxUsageDataGranted()).resolves.toBe(false);
    });
  });
});

describe('analytics client lifecycle', () => {
  it('starts client, registers super properties, and identifies on pass', async () => {
    await resetModule();
    __setExtensionVersionReaderForTests(() => EXTENSION_VERSION);
    await withEnv(productionEnv, async () => {
      const storage = createStorage(false);
      await expect(initAnalytics(storage, EMAIL)).resolves.toBe(true);

      expect(mocks.clients).toHaveLength(1);
      expect(mocks.clients[0]?.init).toHaveBeenCalledWith(API_KEY, EXPECTED_INIT_OPTIONS);
      expect(mocks.clients[0]?.register).toHaveBeenCalledWith({
        browser: 'chrome',
        extension_version: EXTENSION_VERSION,
        platform: 'extension',
        surface: ANALYTICS_SURFACE,
      });
      expect(mocks.clients[0]?.identify).toHaveBeenCalledWith(EMAIL, { email: EMAIL });
    });
  });

  it('registers the firefox browser super property on Firefox builds', async () => {
    await resetModule();
    __setExtensionVersionReaderForTests(() => EXTENSION_VERSION);
    __setFirefoxPermissionsReaderForTests(() => ({ data_collection: ['technicalAndInteraction'] }));

    await withEnv({ ...productionEnv, FIREFOX: 'true' }, async () => {
      await expect(initAnalytics(createStorage(false), EMAIL)).resolves.toBe(true);

      expect(mocks.clients[0]?.register).toHaveBeenCalledWith({
        browser: 'firefox',
        extension_version: EXTENSION_VERSION,
        platform: 'extension',
        surface: ANALYTICS_SURFACE,
      });
    });
  });

  it('omits extension_version when the manifest version is unreadable', async () => {
    await resetModule();
    __setExtensionVersionReaderForTests(() => {
      throw new Error('no manifest');
    });

    await withEnv(productionEnv, async () => {
      await expect(initAnalytics(createStorage(false), EMAIL)).resolves.toBe(true);

      expect(mocks.clients[0]?.register).toHaveBeenCalledWith({
        browser: 'chrome',
        platform: 'extension',
        surface: ANALYTICS_SURFACE,
      });
    });
  });

  it('returns false and builds no client when opted out', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      await expect(initAnalytics(createStorage(true), EMAIL)).resolves.toBe(false);
      expect(mocks.clients).toHaveLength(0);
    });
  });

  it('returns false with no email', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      await expect(initAnalytics(createStorage(false), '')).resolves.toBe(false);
      expect(mocks.clients).toHaveLength(0);
    });
  });

  it('returns false in dev mode even with a key', async () => {
    await resetModule();
    await withEnv({ ...productionEnv, DEV: true }, async () => {
      await expect(initAnalytics(createStorage(false), EMAIL)).resolves.toBe(false);
      expect(mocks.clients).toHaveLength(0);
    });
  });

  it('returns false without a key and logs a single console.info', async () => {
    await resetModule();
    const info = vi.spyOn(console, 'info').mockReturnValue();

    await withEnv({ DEV: false, VITE_POSTHOG_API_KEY: '' }, async () => {
      await expect(initAnalytics(createStorage(false), EMAIL)).resolves.toBe(false);
      expect(mocks.clients).toHaveLength(0);
      // eslint-disable-next-line vitest/prefer-called-once
      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0]?.[0])).toMatch(/VITE_POSTHOG_API_KEY/);
    });

    info.mockRestore();
  });

  it('returns false when Firefox usage data is not granted', async () => {
    await resetModule();
    __setFirefoxPermissionsReaderForTests(() => ({ data_collection: [] }));

    await withEnv({ ...productionEnv, FIREFOX: 'true' }, async () => {
      await expect(initAnalytics(createStorage(false), EMAIL)).resolves.toBe(false);
      expect(mocks.clients).toHaveLength(0);
    });
  });

  it('re-init with the same email is a no-op returning true', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(false);
      await expect(initAnalytics(storage, EMAIL)).resolves.toBe(true);
      const clientsAfterFirst = mocks.clients.length;
      const firstClient = mocks.clients[0]!;
      const identifyCalls = firstClient.identify.mock.calls.length;
      await expect(initAnalytics(storage, EMAIL)).resolves.toBe(true);
      expect(mocks.clients).toHaveLength(clientsAfterFirst);
      expect(firstClient.identify).toHaveBeenCalledTimes(identifyCalls);
    });
  });

  it('re-init with a different email re-identifies on the same client', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(false);
      await expect(initAnalytics(storage, EMAIL)).resolves.toBe(true);
      const clientsAfterFirst = mocks.clients.length;
      await expect(initAnalytics(storage, 'other@kilo.ai')).resolves.toBe(true);
      expect(mocks.clients).toHaveLength(clientsAfterFirst);
      expect(mocks.clients[0]?.identify).toHaveBeenLastCalledWith('other@kilo.ai', {
        email: 'other@kilo.ai',
      });
    });
  });
});

describe('analytics opt-out storage', () => {
  it('treats absent and invalid stored values as false', async () => {
    await resetModule();
    await expect(loadAnalyticsOptOut(createStorage())).resolves.toBe(false);
    await expect(loadAnalyticsOptOut(createStorage('yes'))).resolves.toBe(false);
    await expect(loadAnalyticsOptOut(createStorage(1))).resolves.toBe(false);
    await expect(loadAnalyticsOptOut(createStorage(true))).resolves.toBe(true);
    await expect(loadAnalyticsOptOut(createStorage(false))).resolves.toBe(false);
  });

  it('persists opt-out and drops an active client', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(false);
      await initAnalytics(storage, EMAIL);
      expect(mocks.clients).toHaveLength(1);
      const client = mocks.clients[0]!;
      client.capture.mockClear();
      client.reset.mockClear();

      await setAnalyticsOptOut(storage, true);
      expect(storage.value).toBe(true);
      expect(client.reset).toHaveBeenCalledWith();
      await expect(loadAnalyticsOptOut(storage)).resolves.toBe(true);

      captureEvent('message_sent', { mode: 'safe' });
      expect(client.capture).not.toHaveBeenCalled();
    });
  });

  it('re-inits when opting back in with an identity', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(true);
      await setAnalyticsOptOut(storage, false, { email: EMAIL });
      expect(storage.value).toBe(false);
      expect(mocks.clients.length).toBeGreaterThan(0);
      expect(mocks.clients.at(-1)?.identify).toHaveBeenCalledWith(EMAIL, { email: EMAIL });
    });
  });

  it('only persists when opting back in without an identity', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(true);
      await setAnalyticsOptOut(storage, false);
      expect(storage.value).toBe(false);
      expect(mocks.clients).toHaveLength(0);
    });
  });
});

describe('analytics capture', () => {
  it('is a no-op without an active client', async () => {
    await resetModule();
    captureEvent('message_sent', { mode: 'safe' });
    expect(allCaptureCalls()).toHaveLength(0);
  });

  it('forwards send_instantly when sendInstantly is set', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      await initAnalytics(createStorage(false), EMAIL);
      const client = mocks.clients[0]!;
      client.capture.mockClear();

      captureEvent(EXTENSION_SIGNED_OUT_EVENT, { reason: 'explicit' }, { sendInstantly: true });

      expect(client.capture).toHaveBeenCalledWith(
        EXTENSION_SIGNED_OUT_EVENT,
        { reason: 'explicit' },
        { send_instantly: true }
      );
      assertCapturedPropertiesAreEnums();
    });
  });
});

describe('analytics daily active heartbeat', () => {
  it('captures once per local day and stays silent on a same-day reopen', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(false);
      await initAnalytics(storage, EMAIL);
      const client = mocks.clients[0]!;
      client.capture.mockClear();

      // Local month is 0-based: 10 is November. 09:00 local must not roll to UTC tomorrow.
      await expect(captureDailyActive(storage, new Date(2026, 10, 12, 9, 0, 0))).resolves.toBe(
        true
      );
      expect(client.capture).toHaveBeenCalledWith(
        EXTENSION_ACTIVE_EVENT,
        {},
        { send_instantly: true }
      );
      expect(storage.lastActiveDay).toMatch(/^2026-11-12:[\da-f]{8}$/u);

      await expect(captureDailyActive(storage, new Date(2026, 10, 12, 23, 59, 0))).resolves.toBe(
        false
      );
      expect(client.capture).toHaveBeenCalledTimes(1);
      expect(allCaptureCalls()).toHaveLength(1);
    });
  });

  it('captures again once the local day rolls over', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(false);
      await initAnalytics(storage, EMAIL);
      const client = mocks.clients[0]!;
      client.capture.mockClear();

      await captureDailyActive(storage, new Date(2026, 10, 12, 23, 0, 0));
      await expect(captureDailyActive(storage, new Date(2026, 10, 13, 0, 1, 0))).resolves.toBe(
        true
      );

      expect(client.capture).toHaveBeenCalledTimes(2);
      expect(storage.lastActiveDay).toMatch(/^2026-11-13:[\da-f]{8}$/u);
    });
  });

  it('counts a second account on the same browser and local day', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(false);
      const day = new Date(2026, 10, 12, 9, 0, 0);
      const firstEmail = EMAIL;
      const secondEmail = 'other@kilo.ai';

      await initAnalytics(storage, firstEmail);
      const client = mocks.clients[0]!;
      client.capture.mockClear();
      await expect(captureDailyActive(storage, day)).resolves.toBe(true);

      // A different signed-in user must not be swallowed by the first user's day.
      await initAnalytics(storage, secondEmail);
      await expect(captureDailyActive(storage, day)).resolves.toBe(true);
      expect(client.capture).toHaveBeenCalledTimes(2);

      // The second user's own day is still deduped.
      await expect(captureDailyActive(storage, day)).resolves.toBe(false);
      expect(client.capture).toHaveBeenCalledTimes(2);
    });
  });

  it('still fires when extension storage throws', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      await initAnalytics(createStorage(false), EMAIL);
      const client = mocks.clients[0]!;
      client.capture.mockClear();
      const brokenStorage: AnalyticsStorageArea = {
        getItem: () => {
          throw new Error('storage detached');
        },
        setItem: () => {
          throw new Error('quota exceeded');
        },
      };

      await expect(
        captureDailyActive(brokenStorage, new Date(2026, 10, 12, 9, 0, 0))
      ).resolves.toBe(true);
      expect(client.capture).toHaveBeenCalledTimes(1);
    });
  });

  it('is a no-op that leaves the day unset without an active client', async () => {
    await resetModule();
    const storage = createStorage(false);

    await expect(captureDailyActive(storage, new Date(2026, 10, 12, 9, 0, 0))).resolves.toBe(false);

    expect(storage.lastActiveDay).toBeUndefined();
    expect(allCaptureCalls()).toHaveLength(0);
  });

  it('leaves the day unset when the user is opted out', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(true);
      await expect(initAnalytics(storage, EMAIL)).resolves.toBe(false);

      await expect(captureDailyActive(storage, new Date(2026, 10, 12, 9, 0, 0))).resolves.toBe(
        false
      );

      expect(storage.lastActiveDay).toBeUndefined();
      expect(allCaptureCalls()).toHaveLength(0);
    });
  });

  it('collapses concurrent calls into a single capture', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createStorage(false);
      await initAnalytics(storage, EMAIL);
      const client = mocks.clients[0]!;
      client.capture.mockClear();
      const day = new Date(2026, 10, 12, 9, 0, 0);

      const results = await Promise.all([
        captureDailyActive(storage, day),
        captureDailyActive(storage, day),
      ]);

      expect(results).toStrictEqual([true, true]);
      expect(client.capture).toHaveBeenCalledTimes(1);
    });
  });
});

describe('analytics user reset', () => {
  it('active + explicit: capture with send_instantly before reset', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      await initAnalytics(createStorage(false), EMAIL);
      const client = mocks.clients[0]!;
      client.capture.mockClear();
      client.reset.mockClear();

      await resetAnalyticsUser({ reason: 'explicit' });

      expect(client.capture.mock.invocationCallOrder[0]).toBeLessThan(
        client.reset.mock.invocationCallOrder[0]!
      );
      expect(client.capture).toHaveBeenCalledWith(
        EXTENSION_SIGNED_OUT_EVENT,
        { reason: 'explicit' },
        { send_instantly: true }
      );
      assertCapturedPropertiesAreEnums();
    });
  });

  it('active + expired: capture with expired reason before reset', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      await initAnalytics(createStorage(false), EMAIL);
      const client = mocks.clients[0]!;
      client.capture.mockClear();
      client.reset.mockClear();

      await resetAnalyticsUser({ reason: 'expired' });

      expect(client.capture.mock.invocationCallOrder[0]).toBeLessThan(
        client.reset.mock.invocationCallOrder[0]!
      );
      expect(client.capture).toHaveBeenCalledWith(
        EXTENSION_SIGNED_OUT_EVENT,
        { reason: 'expired' },
        { send_instantly: true }
      );
      assertCapturedPropertiesAreEnums();
    });
  });

  it('inactive: ephemeral scrub with zero capture and zero identify', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      mocks.clients.length = 0;

      await resetAnalyticsUser({ reason: 'expired' });

      expect(mocks.clients).toHaveLength(1);
      const ephemeral = mocks.clients[0]!;
      expect(ephemeral.init).toHaveBeenCalledWith(API_KEY, EXPECTED_INIT_OPTIONS);
      expect(ephemeral.capture).not.toHaveBeenCalled();
      expect(ephemeral.identify).not.toHaveBeenCalled();
      // eslint-disable-next-line vitest/prefer-called-once
      expect(ephemeral.reset).toHaveBeenCalledTimes(1);
    });
  });

  it('inactive without api key is a no-op', async () => {
    await resetModule();
    await withEnv({ DEV: false, VITE_POSTHOG_API_KEY: '' }, async () => {
      mocks.clients.length = 0;
      await resetAnalyticsUser({ reason: 'explicit' });
      expect(mocks.clients).toHaveLength(0);
    });
  });
});

describe('analytics in-flight race guard', () => {
  it('discards init when opt-out lands mid-flight', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createDeferredStorage();
      const initPromise = initAnalytics(storage, EMAIL);

      await setAnalyticsOptOut(storage, true);
      storage.resolveGet(true);

      await expect(initPromise).resolves.toBe(false);
      expect(mocks.clients.every(client => client.identify.mock.calls.length === 0)).toBe(true);

      captureEvent('message_sent', { mode: 'safe' });
      expect(allCaptureCalls()).toHaveLength(0);
    });
  });

  it('discards init when reset lands mid-flight', async () => {
    await resetModule();
    await withEnv(productionEnv, async () => {
      const storage = createDeferredStorage();
      const initPromise = initAnalytics(storage, EMAIL);

      await resetAnalyticsUser({ reason: 'explicit' });
      // Reset may construct an ephemeral scrub client.
      storage.resolveGet(false);

      await expect(initPromise).resolves.toBe(false);
      expect(mocks.clients.every(client => client.identify.mock.calls.length === 0)).toBe(true);
      captureEvent('message_sent', { mode: 'safe' });
      expect(allCaptureCalls()).toHaveLength(0);
    });
  });
});
