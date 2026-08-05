/* oxlint-disable max-lines */
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
  const holder: { options?: Record<string, unknown> } = {};
  const device = { deviceType: null as number | null };
  const controller = {
    allowsOptional: vi.fn().mockReturnValue(true),
    currentGeneration: vi.fn().mockReturnValue(0),
  };
  let sealedState = false;
  const storage = {
    sealPostHogStorage: vi.fn().mockImplementation(() => {
      sealedState = true;
    }),
    unsealPostHogStorage: vi.fn().mockImplementation(() => {
      sealedState = false;
    }),
    purgePostHogPersistence: vi.fn(),
    isPostHogStorageSealed: vi.fn().mockImplementation(() => sealedState),
    // oxlint-disable-next-line consistent-type-assertions -- mock must match PostHogCustomStorage interface
    posthogCustomStorage: {} as Record<string, unknown>,
  };
  return { client, holder, device, controller, storage };
});

vi.mock('posthog-react-native', () => ({
  default: vi.fn(function PostHogMock(_key: string, options: Record<string, unknown>) {
    hoisted.holder.options = options;
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
  get deviceType() {
    return hoisted.device.deviceType;
  },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.2.3',
  nativeBuildVersion: '45',
}));

vi.mock('@/lib/config', () => ({ POSTHOG_API_KEY: 'test-key' }));

vi.mock('@/lib/telemetry/controller', () => ({
  allowsOptional: hoisted.controller.allowsOptional,
  currentGeneration: hoisted.controller.currentGeneration,
}));

vi.mock('@/lib/telemetry/posthog-storage', () => ({
  sealPostHogStorage: hoisted.storage.sealPostHogStorage,
  unsealPostHogStorage: hoisted.storage.unsealPostHogStorage,
  purgePostHogPersistence: hoisted.storage.purgePostHogPersistence,
  isPostHogStorageSealed: hoisted.storage.isPostHogStorageSealed,
  posthogCustomStorage: hoisted.storage.posthogCustomStorage,
}));

vi.stubGlobal('__DEV__', false);

function readCustomAppProperties(): (
  properties: Record<string, unknown>
) => Record<string, unknown> {
  const fn = hoisted.holder.options?.customAppProperties;
  expect(fn).toEqual(expect.any(Function));
  return fn as (properties: Record<string, unknown>) => Record<string, unknown>;
}

async function loadInitPostHog() {
  vi.resetModules();
  const module = await import('./posthog');
  return module.initPostHog;
}

// oxlint-disable-next-line require-await -- async required by promise-function-async
async function loadModule() {
  vi.resetModules();
  return import('./posthog');
}

describe('initPostHog device_form_factor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.device.deviceType = null;
    hoisted.controller.allowsOptional.mockReturnValue(true);
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it.each([
    { deviceType: 1, expected: 'phone' },
    { deviceType: 2, expected: 'tablet' },
    { deviceType: 3, expected: 'desktop' },
    { deviceType: 4, expected: 'tv' },
    { deviceType: 0, expected: 'unknown' },
    { deviceType: null, expected: 'unknown' },
  ] as const)(
    'maps deviceType $deviceType to device_form_factor $expected',
    async ({ deviceType, expected }) => {
      hoisted.device.deviceType = deviceType;
      const initPostHog = await loadInitPostHog();
      initPostHog();

      const customAppProperties = readCustomAppProperties();
      expect(customAppProperties({ $device_type: 'Mobile' })).toEqual({
        $device_type: 'Mobile',
        device_form_factor: expected,
      });
    }
  );

  it('registers platform: mobile once', async () => {
    hoisted.device.deviceType = 1;
    const initPostHog = await loadInitPostHog();
    initPostHog();

    expect(hoisted.client.register).toHaveBeenCalledTimes(1);
    expect(hoisted.client.register).toHaveBeenCalledWith({ platform: 'mobile' });
  });

  it('constructs PostHog only once when init is called twice', async () => {
    hoisted.device.deviceType = 1;
    const initPostHog = await loadInitPostHog();
    const posthogModule = await import('posthog-react-native');
    const PostHog = posthogModule.default;

    initPostHog();
    initPostHog();

    expect(PostHog).toHaveBeenCalledTimes(1);
  });

  it('passes customStorage to PostHog', async () => {
    const initPostHog = await loadInitPostHog();
    initPostHog();

    expect(hoisted.holder.options?.customStorage).toBe(hoisted.storage.posthogCustomStorage);
  });
});

describe('initPostHog gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it('returns early when optional consent is not given', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    const initPostHog = await loadInitPostHog();
    initPostHog();

    const posthogModule = await import('posthog-react-native');
    expect(posthogModule.default).not.toHaveBeenCalled();
  });

  it('initializes when optional consent is true', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(true);
    const initPostHog = await loadInitPostHog();
    initPostHog();

    const posthogModule = await import('posthog-react-native');
    expect(posthogModule.default).toHaveBeenCalledTimes(1);
  });
});

describe('capture gate and generation scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.controller.currentGeneration.mockReturnValue(0);
    hoisted.controller.allowsOptional.mockReturnValue(true);
  });

  it('captureEvent returns early when optional consent is not given', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    const { initPostHog, captureEvent } = await loadModule();
    initPostHog();
    captureEvent('test-event');

    expect(hoisted.client.capture).not.toHaveBeenCalled();
  });

  it('captureEvent drops a stale-generation capture', async () => {
    hoisted.controller.currentGeneration.mockReturnValue(0);
    const module = await loadModule();
    module.initPostHog();

    // Bump the generation after init.
    hoisted.controller.currentGeneration.mockReturnValue(1);
    module.captureEvent('test-event');
    module.captureScreen('test-screen');
    module.identifyUser('stale@test.com');

    expect(hoisted.client.capture).not.toHaveBeenCalled();
    expect(hoisted.client.screen).not.toHaveBeenCalled();
    expect(hoisted.client.identify).not.toHaveBeenCalled();
  });

  it('captureEvent allows a current-generation capture', async () => {
    hoisted.controller.currentGeneration.mockReturnValue(0);
    const { initPostHog, captureEvent } = await loadModule();
    initPostHog();
    captureEvent('test-event');

    expect(hoisted.client.capture).toHaveBeenCalledWith('test-event', undefined);
  });

  it('captureScreen returns early when optional consent is not given', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    const { initPostHog, captureScreen } = await loadModule();
    initPostHog();
    captureScreen('test-screen');

    expect(hoisted.client.screen).not.toHaveBeenCalled();
  });

  it('identifyUser returns early when optional consent is not given', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    const { initPostHog, identifyUser } = await loadModule();
    initPostHog();
    identifyUser('test@test.com');

    expect(hoisted.client.identify).not.toHaveBeenCalled();
  });
});

describe('captureUncataloged privacy and gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.controller.allowsOptional.mockReturnValue(true);
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it('drops payload keys that name a prohibited data class before capture', async () => {
    const { initPostHog, captureUncataloged } = await loadModule();
    initPostHog();
    captureUncataloged('onboarding-entered', {
      surface: 'claw',
      email: 'a@b.co',
      session_id: 'x',
      ok_count: 1,
    });

    expect(hoisted.client.capture).toHaveBeenCalledWith('onboarding-entered', {
      surface: 'claw',
      ok_count: 1,
    });
  });

  it('keeps every allowed key on an uncataloged payload', async () => {
    const { initPostHog, captureUncataloged } = await loadModule();
    initPostHog();
    captureUncataloged('provision-failed', { category: 'lock' });

    expect(hoisted.client.capture).toHaveBeenCalledWith('provision-failed', { category: 'lock' });
  });

  it('passes no properties through unchanged when none are given', async () => {
    const { initPostHog, captureUncataloged } = await loadModule();
    initPostHog();
    captureUncataloged('completion-reached');

    expect(hoisted.client.capture).toHaveBeenCalledWith('completion-reached', undefined);
  });

  it('returns early when optional consent is not given', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    const { initPostHog, captureUncataloged } = await loadModule();
    initPostHog();
    captureUncataloged('login', { surface: 'claw' });

    expect(hoisted.client.capture).not.toHaveBeenCalled();
  });

  it('drops a stale-generation capture', async () => {
    hoisted.controller.currentGeneration.mockReturnValue(0);
    const { initPostHog, captureUncataloged } = await loadModule();
    initPostHog();

    // Bump the generation after init.
    hoisted.controller.currentGeneration.mockReturnValue(1);
    captureUncataloged('login', { surface: 'claw' });

    expect(hoisted.client.capture).not.toHaveBeenCalled();
  });
});

describe('discardPostHog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.controller.allowsOptional.mockReturnValue(true);
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it('seals storage, clears queues, opts out, drops client in order', async () => {
    const { initPostHog, discardPostHog } = await loadModule();
    initPostHog();

    const callOrder: string[] = [];
    hoisted.storage.sealPostHogStorage.mockImplementation(() => {
      callOrder.push('seal');
    });
    hoisted.client.setPersistedProperty.mockImplementation(() => {
      callOrder.push('clear');
    });
    hoisted.client.optOut.mockImplementation(() => {
      callOrder.push('optOut');
    });

    await discardPostHog();
    expect(callOrder).toEqual(['seal', 'clear', 'clear', 'clear', 'optOut']);
    expect(hoisted.storage.sealPostHogStorage).toHaveBeenCalledTimes(1);
    expect(hoisted.client.setPersistedProperty).toHaveBeenCalledWith('queue', null);
    expect(hoisted.client.setPersistedProperty).toHaveBeenCalledWith('logs_queue', null);
    expect(hoisted.client.setPersistedProperty).toHaveBeenCalledWith('ai_queue', null);
    expect(hoisted.client.optOut).toHaveBeenCalledTimes(1);
  });

  it('never calls shutdown or flush', async () => {
    const { initPostHog, discardPostHog } = await loadModule();
    initPostHog();
    await discardPostHog();
    expect(hoisted.client.shutdown).not.toHaveBeenCalled();
    expect(hoisted.client.flush).not.toHaveBeenCalled();
  });

  it('drops the client reference after discard', async () => {
    const { initPostHog, discardPostHog } = await loadModule();
    initPostHog();
    await discardPostHog();
    const posthogModule = await import('posthog-react-native');
    const prevCalls = (posthogModule.default as ReturnType<typeof vi.fn>).mock.calls.length;
    // Re-init on the *same* module instance — after discard nulled client,
    // initPostHog must construct a new client. resetModules would force a
    // fresh client=null and prove nothing.
    initPostHog();
    expect((posthogModule.default as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      prevCalls + 1
    );
  });

  it('handles a bare mock with no setPersistedProperty gracefully', async () => {
    const { initPostHog, discardPostHog, subscribeToPostHogReady, isPostHogReady } =
      await loadModule();

    // Create a live client first so the early branch proves a true→false
    // readiness transition, not a no-op null clear.
    initPostHog();
    expect(isPostHogReady()).toBe(true);

    // Subscribe after init so the listener only observes the false transition.
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeToPostHogReady(listener);

    // Save and remove setPersistedProperty from the live mock to trigger the
    // bare-mock early discard branch.  Restore after the test so other tests
    // still see the full mock.
    const originalSPP = (hoisted.client as Record<string, unknown>).setPersistedProperty;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- temporary removal to trigger bare-mock path
    delete (hoisted.client as Record<string, unknown>).setPersistedProperty;

    try {
      await expect(discardPostHog()).resolves.toBeUndefined();
      expect(hoisted.storage.sealPostHogStorage).toHaveBeenCalledTimes(1);
      expect(hoisted.client.optOut).not.toHaveBeenCalled();
      // The bare-mock path clears client and must notify readiness subscribers.
      expect(listener).toHaveBeenCalledTimes(1);
      expect(isPostHogReady()).toBe(false);
    } finally {
      (hoisted.client as Record<string, unknown>).setPersistedProperty = originalSPP;
    }

    unsubscribe();
  });

  it('allows concurrent re-init to create a fresh client', async () => {
    const { initPostHog, discardPostHog } = await loadModule();
    initPostHog();

    let optOutResolve: (() => void) | undefined = undefined;
    hoisted.client.optOut.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        optOutResolve = resolve;
      });
    });

    const discardPromise = discardPostHog();

    // Let the synchronous part of discardPostHog run: seal, clear queues,
    // client = null, then it awaits optOut.
    await new Promise<void>(resolve => {
      void setTimeout(resolve, 0);
    });

    initPostHog();
    const posthogModule = await import('posthog-react-native');
    expect(posthogModule.default).toHaveBeenCalledTimes(2);
    expect(hoisted.client.onFeatureFlags).toHaveBeenCalledTimes(2);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    optOutResolve!();
    await discardPromise;
  });
});

describe('identifyUser person properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.controller.allowsOptional.mockReturnValue(true);
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it('sends no email or name person key on identifyUser', async () => {
    const { initPostHog, identifyUser } = await loadModule();
    initPostHog();
    identifyUser('test@test.com');

    expect(hoisted.client.identify).toHaveBeenCalledTimes(1);

    // First arg: distinct ID must be the email — unchanged by this slice.
    expect(hoisted.client.identify).toHaveBeenCalledWith('test@test.com', expect.any(Object));

    const properties = hoisted.client.identify.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(properties).not.toHaveProperty('email');
    expect(properties).not.toHaveProperty('name');
  });

  it('identifyUser sends app_version and app_build as person properties', async () => {
    const { initPostHog, identifyUser } = await loadModule();
    initPostHog();
    identifyUser('test@test.com');

    const properties = hoisted.client.identify.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(properties).toEqual({
      app_version: '1.2.3',
      app_build: '45',
    });
  });
});

describe('initPostHog constructor options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.controller.allowsOptional.mockReturnValue(true);
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it('passes disableGeoip: true to the constructor', async () => {
    const initPostHog = await loadInitPostHog();
    initPostHog();

    expect(hoisted.holder.options?.disableGeoip).toBe(true);
  });
});

describe('resumePostHog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.controller.allowsOptional.mockReturnValue(true);
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it('returns a Promise and unseals storage after the 110 ms debounce', async () => {
    vi.useFakeTimers();
    const { resumePostHog } = await loadModule();
    const promise = resumePostHog();
    expect(promise).toBeInstanceOf(Promise);
    expect(hoisted.storage.unsealPostHogStorage).not.toHaveBeenCalled();
    // advanceTimersByTimeAsync processes microtasks (the await discardChain
    // continuation), then the 110 ms setTimeout, then the microtask from the
    // resolved setTimeout promise, so unsealPostHogStorage runs synchronously.
    await vi.advanceTimersByTimeAsync(110);
    expect(hoisted.storage.unsealPostHogStorage).toHaveBeenCalledTimes(1);
    await promise;
    vi.useRealTimers();
  });

  it('awaits active discard before unsealing', async () => {
    const { initPostHog, discardPostHog, resumePostHog } = await loadModule();
    initPostHog();

    let optOutResolve: (() => void) | undefined = undefined;
    hoisted.client.optOut.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        optOutResolve = resolve;
      });
    });

    const discardPromise = discardPostHog();
    await new Promise<void>(resolve => {
      void setTimeout(resolve, 0);
    });

    const resumePromise = resumePostHog();
    await new Promise<void>(resolve => {
      void setTimeout(resolve, 10);
    });

    // Unseal must not have been called — discard is still in flight.
    expect(hoisted.storage.unsealPostHogStorage).not.toHaveBeenCalled();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    optOutResolve!();
    await discardPromise;
    await resumePromise;

    expect(hoisted.storage.unsealPostHogStorage).toHaveBeenCalledTimes(1);
  });
});

describe('discard serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.controller.allowsOptional.mockReturnValue(true);
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it('resumePostHog awaits a slow discard even when a later fast discard overwrites the tail', async () => {
    const { initPostHog, discardPostHog, resumePostHog } = await loadModule();
    initPostHog();

    // First discard: slow optOut.
    let optOutResolve: (() => void) | undefined = undefined;
    hoisted.client.optOut.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        optOutResolve = resolve;
      });
    });

    const firstDiscard = discardPostHog();

    // Let the synchronous part of the first discard run (seal, clear
    // queues, client=null, flagListeners.clear).
    await new Promise<void>(resolve => {
      void setTimeout(resolve, 0);
    });

    // Second discard: client is already null, so the IIFE returns early.
    const secondDiscard = discardPostHog();

    // resumePostHog captures the chain tail. The tail includes the second
    // discard. Since the second discard chains after the first, awaiting
    // the tail must await the first discard too.
    const resumePromise = resumePostHog();
    await new Promise<void>(resolve => {
      void setTimeout(resolve, 10);
    });

    // Unseal must not have been called — the first discard is still in flight.
    expect(hoisted.storage.unsealPostHogStorage).not.toHaveBeenCalled();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    optOutResolve!();
    await firstDiscard;
    await secondDiscard;
    await resumePromise;

    expect(hoisted.storage.unsealPostHogStorage).toHaveBeenCalledTimes(1);
  });

  it('resumePostHog does not wait for a discard that begins after resume', async () => {
    const { initPostHog, discardPostHog, resumePostHog } = await loadModule();
    initPostHog();

    // First discard completes quickly.
    await discardPostHog();

    // Second discard: slow optOut, but starts after resumePostHog captures the tail.
    let optOutResolve: (() => void) | undefined = undefined;
    hoisted.client.optOut.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        optOutResolve = resolve;
      });
    });
    // Re-create a client so the second discard has something to opt out.
    const posthogModule = await import('posthog-react-native');
    (posthogModule.default as ReturnType<typeof vi.fn>).mockClear();
    initPostHog();

    // Start resumePostHog BEFORE the second discard.
    const resumePromise = resumePostHog();

    // Now start the second discard (slow).
    const secondDiscard = discardPostHog();

    // resumePostHog captured the tail before the second discard was
    // appended. The tail should resolve when the first discard's
    // completion resolves (already done).
    await resumePromise;

    // The second discard is still in flight, but resumePostHog has
    // already unsealed.
    expect(hoisted.storage.unsealPostHogStorage).toHaveBeenCalledTimes(1);

    // Clean up: resolve the second discard.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    optOutResolve!();
    await secondDiscard;
  });

  it('rapid off-then-on creates a working non-opted-out client', async () => {
    const { initPostHog, discardPostHog, resumePostHog, captureEvent } = await loadModule();
    initPostHog();

    // Off: discard the client.
    await discardPostHog();

    // On: resume and re-init.
    await resumePostHog();
    expect(hoisted.storage.unsealPostHogStorage).toHaveBeenCalledTimes(1);

    const posthogModule = await import('posthog-react-native');
    const prevCalls = (posthogModule.default as ReturnType<typeof vi.fn>).mock.calls.length;
    initPostHog();
    expect((posthogModule.default as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      prevCalls + 1
    );

    // The recovered client must be able to capture.
    hoisted.client.capture.mockClear();
    captureEvent('recovery-test');
    expect(hoisted.client.capture).toHaveBeenCalledWith('recovery-test', undefined);

    // The recovered client must not be opted out — optOut was called on the
    // old client, not the new one. The new client's optOut has never been
    // called.
    expect(hoisted.client.optOut).toHaveBeenCalledTimes(1);
  });
});

describe('isPostHogReady and subscribeToPostHogReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.controller.allowsOptional.mockReturnValue(true);
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it('isPostHogReady returns false before init', async () => {
    const { isPostHogReady } = await loadModule();
    expect(isPostHogReady()).toBe(false);
  });

  it('isPostHogReady returns true after init', async () => {
    const { initPostHog, isPostHogReady } = await loadModule();
    expect(isPostHogReady()).toBe(false);
    initPostHog();
    expect(isPostHogReady()).toBe(true);
  });

  it('notifies ready subscribers when the client is created', async () => {
    const { initPostHog, subscribeToPostHogReady } = await loadModule();

    const listener = vi.fn() as () => void;
    const unsubscribe = subscribeToPostHogReady(listener);
    expect(listener).not.toHaveBeenCalled();

    initPostHog();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('unsubscribe removes the listener — no further notifications', async () => {
    const { initPostHog, subscribeToPostHogReady } = await loadModule();

    const listener = vi.fn() as () => void;
    const unsubscribe = subscribeToPostHogReady(listener);
    unsubscribe();

    initPostHog();
    expect(listener).not.toHaveBeenCalled();
  });

  it('isPostHogReady returns false when consent is not allowed', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    const { initPostHog, isPostHogReady } = await loadModule();
    initPostHog();
    // initPostHog returns early when consent is not allowed.
    expect(isPostHogReady()).toBe(false);
  });

  it('isPostHogReady stays true after a second initPostHog call', async () => {
    const { initPostHog, isPostHogReady } = await loadModule();
    initPostHog();
    expect(isPostHogReady()).toBe(true);

    // Second init is a no-op (client already exists).
    initPostHog();
    expect(isPostHogReady()).toBe(true);
  });

  it('isPostHogReady returns false after discardPostHog', async () => {
    const { initPostHog, discardPostHog, isPostHogReady } = await loadModule();
    initPostHog();
    expect(isPostHogReady()).toBe(true);

    await discardPostHog();
    expect(isPostHogReady()).toBe(false);
  });

  it('notifies ready subscribers when discardPostHog clears the client', async () => {
    const { initPostHog, discardPostHog, subscribeToPostHogReady } = await loadModule();
    initPostHog();

    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeToPostHogReady(listener);
    expect(listener).not.toHaveBeenCalled();

    await discardPostHog();
    expect(listener).toHaveBeenCalledTimes(1);

    // After unsubscribe, no further notifications.
    unsubscribe();
    listener.mockClear();

    initPostHog();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps a subscriber live across discard and re-init, notifying both transitions', async () => {
    const { initPostHog, discardPostHog, subscribeToPostHogReady, isPostHogReady } =
      await loadModule();

    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeToPostHogReady(listener);
    expect(listener).not.toHaveBeenCalled();

    // Initial init: ready becomes true.
    initPostHog();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isPostHogReady()).toBe(true);

    // Discard: ready becomes false. Same listener fires again.
    await discardPostHog();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(isPostHogReady()).toBe(false);

    // Re-init: ready becomes true. Same listener fires again.
    initPostHog();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(isPostHogReady()).toBe(true);

    unsubscribe();
  });
});

describe('flag listener persistence through off-on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.controller.allowsOptional.mockReturnValue(true);
    hoisted.controller.currentGeneration.mockReturnValue(0);
  });

  it('onFeatureFlags callback is re-registered after discardPostHog + initPostHog', async () => {
    const { initPostHog, discardPostHog } = await loadModule();
    initPostHog();
    expect(hoisted.client.onFeatureFlags).toHaveBeenCalledTimes(1);

    await discardPostHog();

    // Re-init must register the onFeatureFlags callback on the new client.
    initPostHog();
    expect(hoisted.client.onFeatureFlags).toHaveBeenCalledTimes(2);

    const callback = hoisted.client.onFeatureFlags.mock.calls[1]?.[0];
    expect(callback).toEqual(expect.any(Function));
  });

  it('onFeatureFlags callback survives concurrent re-init during async discard', async () => {
    const { initPostHog, discardPostHog } = await loadModule();
    initPostHog();

    let optOutResolve: (() => void) | undefined = undefined;
    hoisted.client.optOut.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        optOutResolve = resolve;
      });
    });

    const discardPromise = discardPostHog();

    // Let the synchronous part of discardPostHog run (seal, clear queues,
    // client = null), then it awaits optOut. After our fix, flagListeners
    // is NOT cleared here.
    await new Promise<void>(resolve => {
      void setTimeout(resolve, 0);
    });

    // Concurrent re-init while optOut is still pending.
    initPostHog();
    expect(hoisted.client.onFeatureFlags).toHaveBeenCalledTimes(2);

    // The second onFeatureFlags callback must be registered and callable.
    const callback = hoisted.client.onFeatureFlags.mock.calls[1]?.[0];
    expect(callback).toEqual(expect.any(Function));
    // Invoking the callback must not throw — flagListeners may be empty or
    // contain stale entries, but iteration must be safe.
    expect(() => {
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- direct invocation in a test assertion
      (callback as () => void)();
    }).not.toThrow();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    optOutResolve!();
    await discardPromise;
  });
});
