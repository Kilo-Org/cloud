import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCaptureNativeTestModule,
  createPrivacyNativeTestModule,
} from '../../modules/local-access-privacy/tests/native-test-helpers';
import * as LocalAccess from '@/lib/local-access';

const adapter = vi.hoisted(() => ({
  available: true,
  nativeFailure: false,
  platform: 'android',
  secure: false,
  captureFailure: false,
  captureWait: undefined as Promise<undefined> | undefined,
  captureEvents: [] as string[],
  snapshot: { generation: 0, armed: false, foreground: true, covered: false, failed: false },
  access: {
    userId: 'user-a' as string | null,
    authEpoch: 0,
    unlockGeneration: 0,
    unlocked: true,
    contextReady: true,
    foregroundReady: true,
  },
  accessListeners: new Set<() => void>(),
  delivered: [] as string[],
  queue: [] as (() => void)[],
  listeners: new Map<string, (event: never) => void>(),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return adapter.platform;
    },
  },
}));
vi.mock('@/lib/local-access', async importOriginal => ({
  ...(await importOriginal<typeof LocalAccess>()),
  getLocalAccessSnapshot: () => adapter.access,
  subscribeLocalAccess: (listener: () => void) => {
    adapter.accessListeners.add(listener);
    return () => adapter.accessListeners.delete(listener);
  },
}));
const captureNativePath = await vi.hoisted(async () => {
  // eslint-disable-next-line import/no-nodejs-modules -- resolve Expo's nested native dependency for the test
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return createRequire(require.resolve('expo-screen-capture')).resolve('expo-modules-core');
});
vi.mock(captureNativePath, () => createCaptureNativeTestModule(adapter));
vi.mock('expo', () => ({
  requireNativeModule: () => createPrivacyNativeTestModule(adapter),
  createPermissionHook: vi.fn(),
  PermissionStatus: { GRANTED: 'granted' },
}));

function deliver() {
  for (const task of adapter.queue.splice(0)) {
    task();
  }
}

function publishAccess() {
  for (const listener of adapter.accessListeners) {
    listener();
  }
}

function inactive() {
  adapter.snapshot.foreground = false;
  adapter.snapshot.covered = adapter.snapshot.armed;
  adapter.snapshot.generation += 1;
}

beforeEach(() => {
  vi.resetModules();
  // Execute installed Expo ownership logic, including activeTags retained after native rejection.
  vi.doMock('expo-screen-capture', async () => {
    const capture = await vi.importActual('expo-screen-capture/src/ScreenCapture');
    return capture;
  });
  adapter.available = true;
  adapter.nativeFailure = false;
  adapter.platform = 'android';
  adapter.secure = false;
  adapter.captureFailure = false;
  adapter.captureWait = undefined;
  adapter.captureEvents = [];
  adapter.snapshot = {
    generation: 0,
    armed: false,
    foreground: true,
    covered: false,
    failed: false,
  };
  adapter.access = {
    userId: 'user-a',
    authEpoch: 0,
    unlockGeneration: 0,
    unlocked: true,
    contextReady: true,
    foregroundReady: true,
  };
  adapter.accessListeners.clear();
  adapter.delivered = [];
  adapter.queue = [];
  adapter.listeners.clear();
});

describe('native privacy bridge', () => {
  it('does not activate protection on import', async () => {
    const privacy = await import('./local-access-privacy');
    expect(privacy.getLocalAccessPrivacySnapshot().armed).toBe(false);
    expect(adapter.secure).toBe(false);
  });

  it('covers immediately and waits for maintained capture protection before publication', async () => {
    const privacy = await import('./local-access-privacy');
    const capture = Promise.withResolvers<undefined>();
    adapter.captureWait = capture.promise;
    const arming = privacy.armLocalAccessPrivacy();
    expect(adapter.snapshot.covered).toBe(true);
    expect(privacy.publishLocalAccessVisibility(adapter.snapshot.generation)).toBe(false);
    capture.resolve(undefined);
    const armed = await arming;
    expect(adapter.secure).toBe(true);
    expect(privacy.publishLocalAccessVisibility(armed.generation)).toBe(true);
    expect(adapter.snapshot.covered).toBe(false);
  });

  it('keeps iOS arming independent of incompatible screen-capture reparenting', async () => {
    const privacy = await import('./local-access-privacy');
    adapter.platform = 'ios';
    adapter.captureFailure = true;
    const armed = await privacy.armLocalAccessPrivacy();
    expect(privacy.publishLocalAccessVisibility(armed.generation)).toBe(true);
    expect(adapter.secure).toBe(false);
  });

  it.each(['userId', 'unlocked', 'contextReady', 'foregroundReady'] as const)(
    'keeps content covered without current %s',
    async field => {
      const privacy = await import('./local-access-privacy');
      const armed = await privacy.armLocalAccessPrivacy();
      if (field === 'userId') {
        adapter.access.userId = null;
      } else {
        adapter.access[field] = false;
      }
      expect(privacy.publishLocalAccessVisibility(armed.generation)).toBe(false);
      expect(adapter.snapshot.covered).toBe(true);
    }
  );

  it.each([
    { userId: 'user-b' },
    { authEpoch: 1 },
    { unlockGeneration: 1 },
    { unlocked: false },
    { contextReady: false },
    { foregroundReady: false },
  ])('revokes native visibility synchronously for a shared access change: %j', async change => {
    const privacy = await import('./local-access-privacy');
    const armed = await privacy.armLocalAccessPrivacy();
    privacy.publishLocalAccessVisibility(armed.generation);
    adapter.access = { ...adapter.access, ...change };
    publishAccess();
    expect(adapter.snapshot.covered).toBe(true);
    adapter.access = {
      ...adapter.access,
      unlocked: true,
      contextReady: true,
      foregroundReady: true,
    };
    publishAccess();
    expect(privacy.publishLocalAccessVisibility(armed.generation)).toBe(false);
    expect(privacy.publishLocalAccessVisibility(adapter.snapshot.generation)).toBe(true);
  });

  it('rejects stale publication when native inactivity precedes the JavaScript event', async () => {
    const privacy = await import('./local-access-privacy');
    const armed = await privacy.armLocalAccessPrivacy();
    inactive();
    expect(privacy.publishLocalAccessVisibility(armed.generation)).toBe(false);
    expect(() => {
      privacy.assertNativeForeground();
    }).toThrow(LocalAccess.LocalAccessDeniedError);
    adapter.snapshot.foreground = true;
    adapter.snapshot.generation += 1;
    expect(privacy.publishLocalAccessVisibility(armed.generation)).toBe(false);
    expect(adapter.snapshot.covered).toBe(true);
    expect(privacy.publishLocalAccessVisibility(adapter.snapshot.generation)).toBe(true);
  });

  it.each([false, true])(
    'requires native capture repair and releases only owned keys (other consumer: %s)',
    async otherConsumer => {
      const privacy = await import('./local-access-privacy');
      const capture = await import('expo-screen-capture');
      if (otherConsumer) {
        await capture.preventScreenCaptureAsync('other-consumer');
      }
      adapter.captureFailure = true;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each explicit Retry must follow the previous rejection
        await expect(privacy.armLocalAccessPrivacy()).rejects.toThrow('Capture unavailable');
        expect(privacy.publishLocalAccessVisibility(adapter.snapshot.generation)).toBe(false);
        expect(adapter.snapshot.covered).toBe(true);
        expect(adapter.secure).toBe(otherConsumer);
      }
      adapter.captureFailure = false;
      const retried = await privacy.armLocalAccessPrivacy();
      expect(adapter.secure).toBe(true);
      expect(privacy.publishLocalAccessVisibility(retried.generation)).toBe(true);
      await privacy.disarmLocalAccessPrivacy();
      expect(adapter.secure).toBe(otherConsumer);
      if (otherConsumer) {
        await capture.allowScreenCaptureAsync('other-consumer');
        expect(adapter.secure).toBe(false);
      }
    }
  );

  it.each(['available', 'nativeFailure'] as const)(
    'denies native effects after %s failure',
    async kind => {
      const privacy = await import('./local-access-privacy');
      adapter.available = kind !== 'available';
      adapter.nativeFailure = kind === 'nativeFailure';
      expect(() => {
        privacy.assertNativeForeground();
      }).toThrow(LocalAccess.LocalAccessDeniedError);
    }
  );

  it('rejects activation and speech when the native module is missing', async () => {
    const privacy = await import('./local-access-privacy');
    adapter.available = false;
    await expect(privacy.armLocalAccessPrivacy()).rejects.toThrow('Missing native privacy');
    expect(await privacy.announceLocalAccessPrivacy('protected')).toBe(false);
    expect(adapter.delivered).toEqual([]);
  });

  it('serializes disarm and rearm without a late capture release', async () => {
    const privacy = await import('./local-access-privacy');
    const capture = Promise.withResolvers<undefined>();
    adapter.captureWait = capture.promise;
    const first = privacy.armLocalAccessPrivacy();
    const stale = expect(first).rejects.toThrow('stale');
    const release = privacy.disarmLocalAccessPrivacy();
    const replacement = privacy.armLocalAccessPrivacy();
    capture.resolve(undefined);
    await stale;
    await release;
    const armed = await replacement;
    expect(adapter.captureEvents).toEqual(['prevent', 'allow', 'prevent']);
    expect(adapter.secure).toBe(true);
    expect(privacy.publishLocalAccessVisibility(armed.generation)).toBe(true);
  });

  it('rejects native-queued speech after inactivity and never replays it after unlock', async () => {
    const privacy = await import('./local-access-privacy');
    const armed = await privacy.armLocalAccessPrivacy();
    privacy.publishLocalAccessVisibility(armed.generation);
    const speech = privacy.announceLocalAccessPrivacy('secret transcript');
    inactive();
    adapter.snapshot.foreground = true;
    adapter.snapshot.generation += 1;
    privacy.publishLocalAccessVisibility(adapter.snapshot.generation);
    deliver();
    expect(await speech).toBe(false);
    expect(adapter.delivered).toEqual([]);
  });

  it('does not enqueue protected speech while covered and permits explicit non-sensitive gate speech', async () => {
    const privacy = await import('./local-access-privacy');
    await privacy.armLocalAccessPrivacy();
    expect(await privacy.announceLocalAccessPrivacy('secret')).toBe(false);
    const speech = privacy.announceLocalAccessPrivacy('Unlock required', 'gate');
    deliver();
    expect(await speech).toBe(true);
    expect(adapter.delivered).toEqual(['Unlock required']);
  });

  it('preserves fresh disarmed speech without reviving queued authenticated speech', async () => {
    const privacy = await import('./local-access-privacy');
    const old = privacy.announceLocalAccessPrivacy('old owner');
    await privacy.armLocalAccessPrivacy();
    await privacy.disarmLocalAccessPrivacy();
    deliver();
    expect(await old).toBe(false);
    const fresh = privacy.announceLocalAccessPrivacy('public status');
    adapter.access = { ...adapter.access, userId: 'user-b' };
    publishAccess();
    deliver();
    expect(await fresh).toBe(true);
    expect(adapter.delivered).toEqual(['public status']);
    expect(adapter.secure).toBe(false);
  });

  it('does not execute a queued gate action after its generation changes', async () => {
    const privacy = await import('./local-access-privacy');
    const armed = await privacy.armLocalAccessPrivacy();
    const actions: string[] = [];
    const unsubscribe = privacy.subscribeLocalAccessPrivacyGateActions(id => {
      actions.push(id);
    });
    const listener = adapter.listeners.get('onGateAction') as (event: {
      generation: number;
      id: string;
    }) => void;
    inactive();
    adapter.snapshot.foreground = true;
    listener({ generation: armed.generation, id: 'retry' });
    expect(actions).toEqual([]);
    listener({ generation: adapter.snapshot.generation, id: 'retry' });
    expect(actions).toEqual(['retry']);
    unsubscribe();
    expect(adapter.listeners.size).toBe(0);
  });
});
