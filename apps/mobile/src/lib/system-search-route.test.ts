/* eslint-disable require-await, @typescript-eslint/require-await -- the SecureStore mock settles without await because it resolves immediately */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

// Fake SecureStore surface backed by an in-memory Map, injected through the
// test-only setter so the durable mirror never loads the real native module.
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
};

const mocks = vi.hoisted(() => ({
  consumePendingRoute: vi.fn<() => string | null>(() => null),
  addListener: vi.fn<(listener: () => void) => { remove: () => void } | null>(() => ({
    remove: vi.fn<() => void>(),
  })),
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

// `system-search-entries` reuses `providerRefFromRecentPr`, which opens
// SecureStore on import; this suite never reads it through that path.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

// `@/lib/native-system-search` is the module that pulls `expo`; stub it so the
// suite stays in the pure node graph.
vi.mock('@/lib/native-system-search', () => ({
  consumePendingSystemSearchRoute: mocks.consumePendingRoute,
  addSystemSearchOpenListener: mocks.addListener,
}));

/* eslint-disable import/first */
import { PENDING_DEEP_LINK_KEY } from '@/lib/storage-keys';
import {
  _resetDeepLinkLaunchForTests,
  _setSecureStoreForTests,
  getPendingDeepLinkSnapshot,
} from './deep-link-launch';
import {
  captureSystemSearchLaunch,
  registerSystemSearchOpenListener,
  routeSystemSearchOpen,
} from './system-search-route';
/* eslint-enable import/first */

const SESSION_ID = '/(app)/agent-chat/session-1';
const PR_ID = '/(app)/pr-review/owner/repo/42';
const FINDING_ID = '/(app)/(tabs)/(3_profile)/security-agent/personal/findings/finding-1';

/** The source of the durable record, the only place the source is observable. */
function persistedSource(): string | null {
  const raw = store.get(PENDING_DEEP_LINK_KEY);
  return raw === undefined ? null : (JSON.parse(raw) as { source: string }).source;
}

describe('system-search-route', () => {
  beforeEach(() => {
    _resetDeepLinkLaunchForTests();
    _setSecureStoreForTests(secureStoreMock);
    store.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetDeepLinkLaunchForTests();
    store.clear();
  });

  describe('routeSystemSearchOpen', () => {
    it.each([
      ['a session', SESSION_ID],
      ['a pull request', PR_ID],
      ['a finding', FINDING_ID],
    ])('stashes the screen %s names with source system-search', async (_name, id) => {
      routeSystemSearchOpen(id);

      expect(getPendingDeepLinkSnapshot()).toBe(id);
      await vi.waitFor(() => {
        expect(persistedSource()).toBe('system-search');
      });
    });

    it('is silent for a null identifier', () => {
      routeSystemSearchOpen(null);

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
    });

    it('is silent for an identifier the section did not issue', () => {
      routeSystemSearchOpen('session-1');

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
    });
  });

  describe('captureSystemSearchLaunch', () => {
    it('routes the native slot once', async () => {
      mocks.consumePendingRoute.mockReturnValueOnce(SESSION_ID);

      captureSystemSearchLaunch();

      expect(mocks.consumePendingRoute).toHaveBeenCalledOnce();
      expect(getPendingDeepLinkSnapshot()).toBe(SESSION_ID);
      await vi.waitFor(() => {
        expect(persistedSource()).toBe('system-search');
      });
    });

    it('cannot re-route a slot the native read already cleared', () => {
      mocks.consumePendingRoute.mockReturnValueOnce(SESSION_ID);
      captureSystemSearchLaunch();

      // A second read — a warm listener racing the launch capture — gets the
      // cleared slot back and must leave the pending href alone.
      captureSystemSearchLaunch();

      expect(mocks.consumePendingRoute).toHaveBeenCalledTimes(2);
      expect(getPendingDeepLinkSnapshot()).toBe(SESSION_ID);
    });

    it('is silent when the native slot is empty', () => {
      captureSystemSearchLaunch();

      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });
  });

  describe('registerSystemSearchOpenListener', () => {
    it('routes what the native slot then holds when the wake-up fires', () => {
      const subscription = registerSystemSearchOpenListener();
      expect(mocks.addListener).toHaveBeenCalledOnce();
      const listener = mocks.addListener.mock.calls[0]?.[0];
      expect(listener).toBeTypeOf('function');

      mocks.consumePendingRoute.mockReturnValueOnce(PR_ID);
      listener?.();

      expect(getPendingDeepLinkSnapshot()).toBe(PR_ID);
      subscription.remove();
    });

    it('is silent when the wake-up finds nothing in the native slot', () => {
      const subscription = registerSystemSearchOpenListener();
      const listener = mocks.addListener.mock.calls[0]?.[0];

      // The launch capture already consumed the payload: the event is only a
      // signal and must not clear or re-route the pending href.
      mocks.consumePendingRoute.mockReturnValueOnce(SESSION_ID);
      captureSystemSearchLaunch();
      listener?.();

      expect(getPendingDeepLinkSnapshot()).toBe(SESSION_ID);
      subscription.remove();
    });

    it('returns a removable no-op subscription without the native module', () => {
      mocks.addListener.mockReturnValueOnce(null);

      const subscription = registerSystemSearchOpenListener();

      expect(() => {
        subscription.remove();
      }).not.toThrow();
    });
  });
});
