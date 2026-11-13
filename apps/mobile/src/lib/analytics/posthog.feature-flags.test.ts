import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_ACCESS_FLAG,
  CODE_REVIEW_COUNCIL_FLAG,
  CODE_REVIEW_MD_CONVERSION_FLAG,
  type FeatureFlagKey,
  ORGANIZATION_AUTO_MODEL_FLAG,
} from '@kilocode/app-shared/feature-flags';
import type * as FeatureFlags from '@/lib/feature-flags';

const hoisted = vi.hoisted(() => {
  const client = {
    register: vi.fn(),
    setPersonPropertiesForFlags: vi.fn(),
    onFeatureFlags: vi.fn(),
    capture: vi.fn(),
    screen: vi.fn(),
    identify: vi.fn(),
    reloadFeatureFlags: vi.fn(),
    getFeatureFlag: vi.fn(),
    reset: vi.fn(),
    setPersistedProperty: vi.fn(),
    optOut: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(),
    flush: vi.fn(),
  };
  // Mutable so each test can set the build version under test before the
  // module loads. `useFeatureFlag` reads it at read time, not import time.
  const application = {
    nativeApplicationVersion: '1.0.11' as string | undefined,
    nativeBuildVersion: '45',
  };
  const controller = {
    allowsMandatory: vi.fn().mockReturnValue(true),
    allowsOptional: vi.fn().mockReturnValue(true),
    currentGeneration: vi.fn().mockReturnValue(0),
  };
  return { client, application, controller };
});

vi.mock('posthog-react-native', () => ({
  default: vi.fn(function PostHogMock() {
    return hoisted.client;
  }),
  PostHogPersistedProperty: {
    Queue: 'queue',
    LogsQueue: 'logs_queue',
    AiQueue: 'ai_queue',
  },
}));

vi.mock('expo-device', () => ({
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 },
  deviceType: null,
}));

vi.mock('expo-application', () => ({
  get nativeApplicationVersion() {
    return hoisted.application.nativeApplicationVersion;
  },
  get nativeBuildVersion() {
    return hoisted.application.nativeBuildVersion;
  },
}));

vi.mock('@/lib/feature-flags', async importOriginal => {
  const actual = await importOriginal<typeof FeatureFlags>();
  return {
    ...actual,
    getFeatureFlagDefinition: (key: string) =>
      key === CODE_REVIEW_COUNCIL_FLAG
        ? { key: CODE_REVIEW_COUNCIL_FLAG, minAppVersion: '1.0.11', defaultValue: true }
        : actual.getFeatureFlagDefinition(key),
  };
});

vi.mock('@/lib/config', () => ({ POSTHOG_API_KEY: 'test-key' }));

vi.mock('@/lib/telemetry/controller', () => ({
  allowsMandatory: hoisted.controller.allowsMandatory,
  allowsOptional: hoisted.controller.allowsOptional,
  currentGeneration: hoisted.controller.currentGeneration,
}));

vi.mock('@/lib/telemetry/posthog-storage', () => ({
  sealPostHogStorage: vi.fn(),
  unsealPostHogStorage: vi.fn(),
  purgePostHogPersistence: vi.fn(),
  isPostHogStorageSealed: vi.fn().mockReturnValue(false),
  posthogCustomStorage: {},
}));

vi.stubGlobal('__DEV__', false);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

/** Mount a probe that reads `useFeatureFlag` the way real screens do. */
async function readFlag(key: FeatureFlagKey, defaultValue: boolean): Promise<boolean | undefined> {
  const posthog = await import('./posthog');
  let observed: boolean | undefined = undefined;
  function Probe() {
    observed = posthog.useFeatureFlag(key, defaultValue);
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  act(() => {
    renderer?.unmount();
  });
  // undefined here means the probe never rendered — every expectation below
  // then fails, which is the honest signal.
  return observed;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  hoisted.application.nativeApplicationVersion = '1.0.11';
  hoisted.controller.allowsMandatory.mockReturnValue(true);
  hoisted.controller.allowsOptional.mockReturnValue(true);
  hoisted.controller.currentGeneration.mockReturnValue(0);
  hoisted.client.getFeatureFlag.mockReset();
});

describe('version-aware feature flags', () => {
  it('an older build falls back to the default for a flag introduced in a newer version', async () => {
    // Older builds use the definition's default, not the caller's default.
    hoisted.application.nativeApplicationVersion = '1.0.5';
    hoisted.client.getFeatureFlag.mockImplementation(() => true as never);
    const { initPostHog } = await import('./posthog');
    initPostHog();

    const probe = await readFlag(CODE_REVIEW_COUNCIL_FLAG, false);

    expect(probe).toBe(true);
  });

  it('a build at or above the minimum applies the remote flag value', async () => {
    // Supported builds apply the remote value in both directions.
    hoisted.client.getFeatureFlag.mockImplementation(() => true as never);
    const { initPostHog } = await import('./posthog');
    initPostHog();

    expect(await readFlag(CODE_REVIEW_COUNCIL_FLAG, false)).toBe(true);

    hoisted.client.getFeatureFlag.mockImplementation(() => false as never);
    expect(await readFlag(CODE_REVIEW_COUNCIL_FLAG, false)).toBe(false);
  });

  it('a build at exactly the minimum version applies the flag', async () => {
    hoisted.application.nativeApplicationVersion = '1.0.11';
    hoisted.client.getFeatureFlag.mockImplementation(() => true as never);
    const { initPostHog } = await import('./posthog');
    initPostHog();

    expect(await readFlag(CODE_REVIEW_COUNCIL_FLAG, false)).toBe(true);
  });

  it('keeps the caller default while flags are not loaded', async () => {
    // No flag value yet (the request has not answered): the caller's default
    // applies, which is why every registered flag defaults to `false`.
    const posthog = await import('./posthog');
    posthog.initPostHog();
    hoisted.client.getFeatureFlag.mockImplementation(() => undefined as never);

    expect(await readFlag(CODE_REVIEW_COUNCIL_FLAG, false)).toBe(false);
    expect(await readFlag(CODE_REVIEW_COUNCIL_FLAG, true)).toBe(true);
  });

  it('registers every shared flag key for this build', async () => {
    // The keys are the web app's, so a gated surface follows the same rollout
    // decision on both clients; a registry that drops one silently ungates it.
    const registry = await import('@/lib/feature-flags');
    const keys = registry.FEATURE_FLAG_DEFINITIONS.map(definition => definition.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        CODE_REVIEW_MD_CONVERSION_FLAG,
        CODE_REVIEW_COUNCIL_FLAG,
        ORGANIZATION_AUTO_MODEL_FLAG,
        CHATGPT_ACCESS_FLAG,
      ])
    );
    for (const definition of registry.FEATURE_FLAG_DEFINITIONS) {
      expect(definition.defaultValue).toBe(false);
    }
  });
});
