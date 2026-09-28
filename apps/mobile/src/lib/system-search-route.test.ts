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

const mocks = vi.hoisted(() => {
  const consumePendingRoute = vi.fn<() => Promise<string | null>>();
  // The mocked slot read answers `null` — an empty slot — unless a case arms it.
  consumePendingRoute.mockResolvedValue(null);
  return {
    consumePendingRoute,
    addListener: vi.fn<(listener: () => void) => { remove: () => void } | null>(() => ({
      remove: vi.fn<() => void>(),
    })),
  };
});

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
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import {
  _resetDeepLinkLaunchForTests,
  _setSecureStoreForTests,
  getPendingDeepLinkSnapshot,
  setCurrentDeepLinkUserId,
} from './deep-link-launch';
import { systemSearchDeeplinkFromId, systemSearchHrefFromRoute } from './system-search-entries';
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
    // A system-search destination is session-bound: the account is settled for
    // every case unless the case itself exercises the signed-out boundary.
    setCurrentDeepLinkUserId('user-1');
  });

  afterEach(() => {
    _resetDeepLinkLaunchForTests();
    setTelemetrySink(null);
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

    // Android stores each document's `route`, so this is the identifier form
    // its tap delivers; the bare id above is what iOS returns.
    it.each([
      ['a session', 'kiloapp://agent-chat/session-1', SESSION_ID],
      ['a pull request', 'kiloapp://pr-review/owner/repo/42', PR_ID],
      ['a finding', 'kiloapp://security-agent/personal/findings/finding-1', FINDING_ID],
    ])('stashes the link Android hands back for %s', async (_name, route, id) => {
      routeSystemSearchOpen(route);

      expect(getPendingDeepLinkSnapshot()).toBe(id);
      await vi.waitFor(() => {
        expect(persistedSource()).toBe('system-search');
      });
    });

    it('is silent for an identifier the section did not issue', () => {
      routeSystemSearchOpen('session-1');
      routeSystemSearchOpen('kiloapp://agent-chat/');
      routeSystemSearchOpen('https://example.com/agent-chat/session-1');

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
    });

    it('is silent for a null identifier', () => {
      routeSystemSearchOpen(null);

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
    });

    it('drops a tap taken while signed out, so a later sign-in cannot open it', () => {
      // A stale identifier can outlive the account that indexed it. Captured
      // while signed out, it must not be held for whoever signs in next.
      setCurrentDeepLinkUserId(null);

      routeSystemSearchOpen(SESSION_ID);

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);

      setCurrentDeepLinkUserId('user-2');
      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });

    it('binds a cold-launch tap once the account settles', async () => {
      // The module-scope capture runs before auth restores; the destination is
      // held and bound to the account that then settles.
      _resetDeepLinkLaunchForTests();
      mocks.consumePendingRoute.mockResolvedValueOnce(SESSION_ID);

      captureSystemSearchLaunch();
      await vi.waitFor(() => {
        expect(mocks.consumePendingRoute).toHaveBeenCalledOnce();
      });
      expect(getPendingDeepLinkSnapshot()).toBeNull();

      setCurrentDeepLinkUserId('user-1');

      expect(getPendingDeepLinkSnapshot()).toBe(SESSION_ID);
    });
  });

  describe('captureSystemSearchLaunch', () => {
    it('routes the native slot once', async () => {
      mocks.consumePendingRoute.mockResolvedValueOnce(SESSION_ID);

      captureSystemSearchLaunch();

      expect(mocks.consumePendingRoute).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(getPendingDeepLinkSnapshot()).toBe(SESSION_ID);
      });
      await vi.waitFor(() => {
        expect(persistedSource()).toBe('system-search');
      });
    });

    it('cannot re-route a slot the native read already cleared', async () => {
      mocks.consumePendingRoute.mockResolvedValueOnce(SESSION_ID);
      captureSystemSearchLaunch();

      // A second read — a warm listener racing the launch capture — gets the
      // cleared slot back and must leave the pending href alone.
      captureSystemSearchLaunch();

      expect(mocks.consumePendingRoute).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => {
        expect(getPendingDeepLinkSnapshot()).toBe(SESSION_ID);
      });
    });

    it('is silent when the native slot is empty', async () => {
      captureSystemSearchLaunch();

      await vi.waitFor(() => {
        expect(mocks.consumePendingRoute).toHaveBeenCalledOnce();
      });
      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });
  });

  describe('a rejected native slot read', () => {
    it.each([
      [
        'the launch capture',
        () => {
          captureSystemSearchLaunch();
        },
      ],
      [
        'the wake-up listener',
        () => {
          registerSystemSearchOpenListener();
          const listener = mocks.addListener.mock.calls[0]?.[0];
          listener?.();
        },
      ],
    ])('reports %s instead of leaving an unhandled rejection', async (_name, trigger) => {
      const error = new Error('native slot read failed');
      mocks.consumePendingRoute.mockRejectedValueOnce(error);
      const events: TelemetryEvent[] = [];
      setTelemetrySink(event => {
        events.push(event);
      });

      trigger();

      await vi.waitFor(() => {
        expect(events).toHaveLength(1);
      });
      expect(events[0]?.error).toBe(error);
      expect(events[0]?.level).toBe('warning');
      expect(events[0]?.tags).toMatchObject({
        'error.subsystem': 'system-search',
        'error.operation': 'consume-route',
      });
      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });
  });

  describe('registerSystemSearchOpenListener', () => {
    it('routes what the native slot then holds when the wake-up fires', async () => {
      const subscription = registerSystemSearchOpenListener();
      expect(mocks.addListener).toHaveBeenCalledOnce();
      const listener = mocks.addListener.mock.calls[0]?.[0];
      expect(listener).toBeTypeOf('function');

      mocks.consumePendingRoute.mockResolvedValueOnce(PR_ID);
      listener?.();

      await vi.waitFor(() => {
        expect(getPendingDeepLinkSnapshot()).toBe(PR_ID);
      });
      subscription.remove();
    });

    it('is silent when the wake-up finds nothing in the native slot', async () => {
      const subscription = registerSystemSearchOpenListener();
      const listener = mocks.addListener.mock.calls[0]?.[0];

      // The launch capture already consumed the payload: the event is only a
      // signal and must not clear or re-route the pending href.
      mocks.consumePendingRoute.mockResolvedValueOnce(SESSION_ID);
      captureSystemSearchLaunch();
      listener?.();

      await vi.waitFor(() => {
        expect(mocks.consumePendingRoute).toHaveBeenCalledTimes(2);
      });
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

  describe('systemSearchHrefFromRoute', () => {
    const ids = [
      SESSION_ID,
      PR_ID,
      '/(app)/pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com',
      FINDING_ID,
    ];

    it('resolves the bare id iOS hands back', () => {
      for (const id of ids) {
        expect(systemSearchHrefFromRoute(id)).toBe(id);
      }
    });

    it('resolves the link Android stores to the exact screen', () => {
      for (const id of ids) {
        const link = systemSearchDeeplinkFromId(id);
        expect(link).not.toBeNull();
        if (link !== null) {
          expect(systemSearchHrefFromRoute(link)).toBe(id);
        }
      }
    });

    it('returns null for a link that names no screen this section issued', () => {
      const routes = [
        'kiloapp://agent-chat/',
        'kiloapp://security-agent',
        'kiloapp://settings',
        'https://example.com/agent-chat/session-1',
        'session-1',
      ];

      for (const route of routes) {
        expect(systemSearchHrefFromRoute(route)).toBeNull();
      }
    });
  });
});
