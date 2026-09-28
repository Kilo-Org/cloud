import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/lib/config', () => ({ POSTHOG_API_KEY: 'test-key' }));

vi.mock('@/lib/telemetry/controller', () => ({
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
async function readFlag(key: string, defaultValue: boolean): Promise<boolean | undefined> {
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
  hoisted.controller.allowsOptional.mockReturnValue(true);
  hoisted.controller.currentGeneration.mockReturnValue(0);
  hoisted.client.getFeatureFlag.mockReset();
});

describe('version-aware feature flags', () => {
  it('an older build falls back to the default for a flag introduced in a newer version', async () => {
    // Build 1.0.5 predates mobile-chat (minimum 1.0.11): it must not act
    // on the remote value, whatever PostHog returns. mobile-chat's default is
    // on, so the fallback the gate relies on is that default and not the
    // caller's argument.
    hoisted.application.nativeApplicationVersion = '1.0.5';
    hoisted.client.getFeatureFlag.mockImplementation(
      (key: string) => (key === 'mobile-chat' ? true : undefined) as never
    );
    const { initPostHog } = await import('./posthog');
    initPostHog();

    const probe = await readFlag('mobile-chat', false);

    expect(probe).toBe(true);
  });

  it('a build at or above the minimum applies the remote flag value', async () => {
    // This build is at mobile-chat's minimum (1.0.11): the remote value drives
    // the UI in both directions.
    hoisted.client.getFeatureFlag.mockImplementation(
      (key: string) => (key === 'mobile-chat' ? true : undefined) as never
    );
    const { initPostHog } = await import('./posthog');
    initPostHog();

    expect(await readFlag('mobile-chat', false)).toBe(true);

    hoisted.client.getFeatureFlag.mockImplementation(() => false as never);
    expect(await readFlag('mobile-chat', false)).toBe(false);
  });

  it('a build at exactly the minimum version applies the flag', async () => {
    hoisted.application.nativeApplicationVersion = '1.0.11';
    hoisted.client.getFeatureFlag.mockImplementation(
      (key: string) => (key === 'mobile-chat' ? true : undefined) as never
    );
    const { initPostHog } = await import('./posthog');
    initPostHog();

    expect(await readFlag('mobile-chat', false)).toBe(true);
  });

  it('keeps the caller default while flags are not loaded', async () => {
    // No client (consent pending / dev build): every flag falls back to its
    // default, exactly as before this change.
    const posthog = await import('./posthog');
    posthog.initPostHog();
    hoisted.client.getFeatureFlag.mockImplementation(() => undefined as never);

    expect(await readFlag('mobile-chat', false)).toBe(false);
    expect(await readFlag('mobile-pr-review', true)).toBe(true);
  });

  it('an unknown flag key keeps the legacy behavior', async () => {
    // A key with no registry entry has no minimum, so the remote value still
    // applies (this is how a flag gains a version gate: by being registered).
    hoisted.client.getFeatureFlag.mockImplementation(() => true as never);
    const { initPostHog } = await import('./posthog');
    initPostHog();

    expect(await readFlag('mobile-not-in-registry', false)).toBe(true);
  });
});
