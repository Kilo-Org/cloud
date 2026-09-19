/* eslint-disable max-lines -- the durable-slot, consume-once, and precedence suites share one owned test file */
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

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

/* eslint-disable import/first */
import * as Sentry from '@sentry/react-native';
import { PENDING_DEEP_LINK_KEY } from '@/lib/storage-keys';
import { resolvePendingNavigation } from './pending-navigation';
import { isShellReadyForShare } from './pending-share-navigation';
import {
  _resetDeepLinkLaunchForTests,
  _setGetLinkingURLForTests,
  _setSecureStoreForTests,
  captureLaunchDeepLink,
  clearAccountBoundPendingDeepLink,
  clearPendingDeepLink,
  getPendingDeepLink,
  getPendingDeepLinkSnapshot,
  restorePersistedPendingDeepLink,
  setCurrentDeepLinkUserId,
  setPendingDeepLink,
  subscribeToPendingDeepLink,
} from './deep-link-launch';
/* eslint-enable import/first */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let storedResolve: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      storedResolve?.();
    },
  };
}

describe('deep-link-launch', () => {
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

  describe('pending slot', () => {
    it('is single-shot get-and-clear', () => {
      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'universal-link');
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
      expect(getPendingDeepLink()).toBeNull();
    });
  });

  describe('source precedence (order-independent)', () => {
    it('notification then universal-link leaves the link href', () => {
      setPendingDeepLink('/from-notification', 'notification');
      setPendingDeepLink('/from-link', 'universal-link');
      expect(getPendingDeepLink()).toBe('/from-link');
    });

    it('universal-link then notification leaves the link href', () => {
      setPendingDeepLink('/from-link', 'universal-link');
      setPendingDeepLink('/from-notification', 'notification');
      expect(getPendingDeepLink()).toBe('/from-link');
    });

    it('notification then notification leaves the latest notification href', () => {
      setPendingDeepLink('/notif-1', 'notification');
      setPendingDeepLink('/notif-2', 'notification');
      expect(getPendingDeepLink()).toBe('/notif-2');
    });
  });

  describe('system-search source precedence', () => {
    // A system-search destination is session-bound, so these cases run with the
    // account already settled (the signed-in case).
    beforeEach(() => {
      setCurrentDeepLinkUserId('user-1');
    });

    it('beats a pending notification', () => {
      setPendingDeepLink('/from-notification', 'notification');
      setPendingDeepLink('/(app)/agent-chat/session-1', 'system-search');
      expect(getPendingDeepLink()).toBe('/(app)/agent-chat/session-1');
    });

    it('loses to a universal link', () => {
      setPendingDeepLink('/from-link', 'universal-link');
      setPendingDeepLink('/(app)/agent-chat/session-1', 'system-search');
      expect(getPendingDeepLink()).toBe('/from-link');
    });

    it('replaces an app-scheme launch link with the exact route for the same tap', () => {
      // Android delivers a system-search tap as the document's `kiloapp://`
      // route; the launch capture maps it through the lossy web table (which
      // strips the query), and the search capture must then win with the exact
      // route. An `https://` launch link is not flagged and keeps priority.
      setPendingDeepLink('/(app)/pr-review/gitlab/group/sub/repo/12', 'universal-link', {
        fromLaunchAppScheme: true,
      });
      setPendingDeepLink(
        '/(app)/pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com',
        'system-search'
      );
      expect(getPendingDeepLink()).toBe(
        '/(app)/pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com'
      );
    });

    it('is not overwritten by a later notification', () => {
      setPendingDeepLink('/(app)/agent-chat/session-1', 'system-search');
      setPendingDeepLink('/from-notification', 'notification');
      expect(getPendingDeepLink()).toBe('/(app)/agent-chat/session-1');
    });

    it('round-trips through the persisted record', async () => {
      setPendingDeepLink('/(app)/agent-chat/session-1', 'system-search');
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(true);
      });
      const record = JSON.parse(store.get(PENDING_DEEP_LINK_KEY) ?? '') as {
        source: string;
        userId: string | null;
      };
      expect(record.source).toBe('system-search');
      // The durable record is bound to the account that captured it.
      expect(record.userId).toBe('user-1');

      _resetDeepLinkLaunchForTests();

      setCurrentDeepLinkUserId('user-1');
      await restorePersistedPendingDeepLink();
      expect(getPendingDeepLink()).toBe('/(app)/agent-chat/session-1');
    });

    it('is dropped when the destination was captured while signed out', () => {
      setCurrentDeepLinkUserId(null);
      setPendingDeepLink('/(app)/agent-chat/session-1', 'system-search');

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
    });

    it('binds a destination captured before the account settled', () => {
      // A cold-launch tap is captured at module scope, before auth restores;
      // it must survive the settle of the account it belongs to.
      _resetDeepLinkLaunchForTests();
      setPendingDeepLink('/(app)/agent-chat/session-1', 'system-search');
      expect(getPendingDeepLinkSnapshot()).toBeNull();

      setCurrentDeepLinkUserId('user-1');

      expect(getPendingDeepLink()).toBe('/(app)/agent-chat/session-1');
    });

    it('drops a destination captured before a signed-out settle', () => {
      _resetDeepLinkLaunchForTests();
      setPendingDeepLink('/(app)/agent-chat/session-1', 'system-search');
      expect(getPendingDeepLinkSnapshot()).toBeNull();

      setCurrentDeepLinkUserId(null);

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
    });

    it('does not restore a persisted destination with no account identity', async () => {
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: '/(app)/agent-chat/session-1',
          source: 'system-search',
          storedAt: Date.now(),
          userId: null,
        })
      );

      setCurrentDeepLinkUserId('user-2');
      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
      });
    });

    it('does not restore for a different account', async () => {
      setPendingDeepLink('/(app)/agent-chat/session-1', 'system-search');
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(true);
      });

      _resetDeepLinkLaunchForTests();

      setCurrentDeepLinkUserId('user-2');
      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });
  });

  describe('session-bound launch captures', () => {
    // Android delivers a tap on an indexed result as the entry's `kiloapp://`
    // link, so an app-scheme launch URL that names an indexed family is a
    // system-search identifier and must not survive the account boundary.
    const PR_LAUNCH = 'kiloapp://pr-review/Kilo-Org/cloud/6234';
    const PR_HREF = '/(app)/pr-review/Kilo-Org/cloud/6234';

    it('drops an app-scheme search-family launch captured while signed out', () => {
      setCurrentDeepLinkUserId(null);
      _setGetLinkingURLForTests(() => PR_LAUNCH);
      captureLaunchDeepLink();

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
    });

    it('keeps an app-scheme search-family launch captured before a signed-in settle', () => {
      // A cold launch is captured before auth restores: the destination binds to
      // the account it turns out to belong to.
      _setGetLinkingURLForTests(() => PR_LAUNCH);
      captureLaunchDeepLink();
      expect(getPendingDeepLinkSnapshot()).toBe(PR_HREF);

      setCurrentDeepLinkUserId('user-a');
      expect(getPendingDeepLink()).toBe(PR_HREF);
    });

    it('drops an app-scheme search-family launch captured before a signed-out settle', () => {
      _setGetLinkingURLForTests(() => PR_LAUNCH);
      captureLaunchDeepLink();
      expect(getPendingDeepLinkSnapshot()).toBe(PR_HREF);

      setCurrentDeepLinkUserId(null);
      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });

    it('drops an app-scheme search-family launch at sign-out', () => {
      setCurrentDeepLinkUserId('user-a');
      _setGetLinkingURLForTests(() => PR_LAUNCH);
      captureLaunchDeepLink();
      expect(getPendingDeepLinkSnapshot()).toBe(PR_HREF);

      clearAccountBoundPendingDeepLink();
      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });

    it('keeps an https launch link that names the same family', () => {
      // The public universal link stays account-independent: a signed-out
      // reader may still sign in and land on the page they opened.
      setCurrentDeepLinkUserId(null);
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/pr-review/Kilo-Org/cloud/6234');
      captureLaunchDeepLink();

      expect(getPendingDeepLinkSnapshot()).toBe(PR_HREF);
    });

    it('does not restore a persisted session-bound record with no account identity', async () => {
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: PR_HREF,
          source: 'universal-link',
          storedAt: Date.now(),
          userId: null,
          sessionBound: true,
        })
      );

      setCurrentDeepLinkUserId('user-b');
      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
      });
    });

    it('restores a persisted session-bound record for the account that captured it', async () => {
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: PR_HREF,
          source: 'universal-link',
          storedAt: Date.now(),
          userId: 'user-a',
          sessionBound: true,
        })
      );

      setCurrentDeepLinkUserId('user-a');
      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLink()).toBe(PR_HREF);
    });
  });

  describe('consume exactly once', () => {
    it('lets exactly one of two consumers read a single href', () => {
      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'notification');
      const first = getPendingDeepLink();
      const second = getPendingDeepLink();
      expect(first).toBe('/(app)/(tabs)/(3_profile)');
      expect(second).toBeNull();
    });
  });

  describe('durable mirror', () => {
    it('persists the record on set and deletes it on get', async () => {
      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'notification');
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(true);
      });
      const record = JSON.parse(store.get(PENDING_DEEP_LINK_KEY) ?? '') as {
        href: string;
        source: string;
        storedAt: number;
      };
      expect(record.href).toBe('/(app)/(tabs)/(3_profile)');
      expect(record.source).toBe('notification');
      expect(typeof record.storedAt).toBe('number');

      getPendingDeepLink();
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
      });
    });

    it('serializes writes so a delete after a persist lands last', async () => {
      // Hold the persist open so a fast delete cannot overtake it.
      const persistGate = deferred();
      secureStoreMock.setItemAsync.mockImplementationOnce(async (key: string, value: string) => {
        await persistGate.promise;
        store.set(key, value);
      });

      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'notification');
      // Consume immediately: the delete is enqueued behind the persist.
      getPendingDeepLink();

      // The delete must not run while the persist is still held.
      await vi.waitFor(() => {
        expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1);
      });
      expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled();

      persistGate.resolve();
      await vi.waitFor(() => {
        expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledTimes(1);
      });
      // The delete landed after the persist: the key is gone.
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
    });

    it('reports a write failure to Sentry and keeps the in-memory slot', async () => {
      secureStoreMock.setItemAsync.mockRejectedValueOnce(new Error('write failed'));
      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'notification');
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
      await vi.waitFor(() => {
        expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
          tags: { 'error.subsystem': 'deep_link', 'error.operation': 'write_pending_link' },
        });
      });
    });
  });

  describe('restorePersistedPendingDeepLink', () => {
    it('restores a destination persisted before process death', async () => {
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: '/(app)/(tabs)/(3_profile)',
          source: 'notification',
          storedAt: Date.now(),
          userId: null,
        })
      );
      _resetDeepLinkLaunchForTests();

      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
    });

    it('discards a record captured for a different user', async () => {
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: '/(app)/(tabs)/(3_profile)',
          source: 'notification',
          storedAt: Date.now(),
          userId: 'user-a',
        })
      );
      _resetDeepLinkLaunchForTests();
      setCurrentDeepLinkUserId('user-b');

      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLink()).toBeNull();
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
      });
    });

    it('restores a record captured for the matching user', async () => {
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: '/(app)/(tabs)/(3_profile)',
          source: 'notification',
          storedAt: Date.now(),
          userId: 'user-a',
        })
      );
      _resetDeepLinkLaunchForTests();
      setCurrentDeepLinkUserId('user-a');

      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
    });

    it('restores a record captured while signed out (null userId)', async () => {
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: '/(app)/(tabs)/(3_profile)',
          source: 'notification',
          storedAt: Date.now(),
          userId: null,
        })
      );
      _resetDeepLinkLaunchForTests();
      setCurrentDeepLinkUserId('user-b');

      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
    });

    it('discards an expired record with no navigation', async () => {
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: '/(app)/(tabs)/(3_profile)',
          source: 'notification',
          storedAt: Date.now() - 25 * 60 * 60 * 1000,
        })
      );
      _resetDeepLinkLaunchForTests();

      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLink()).toBeNull();
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
      });
    });

    it('discards a corrupt record with no navigation', async () => {
      store.set(PENDING_DEEP_LINK_KEY, 'not json');
      _resetDeepLinkLaunchForTests();

      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLink()).toBeNull();
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
      });
    });

    it('discards a record with an invalid shape with no navigation', async () => {
      store.set(PENDING_DEEP_LINK_KEY, JSON.stringify({ href: 42 }));
      _resetDeepLinkLaunchForTests();

      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLink()).toBeNull();
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
      });
    });

    it('is a no-op when nothing is persisted', async () => {
      _resetDeepLinkLaunchForTests();

      await restorePersistedPendingDeepLink();

      expect(getPendingDeepLink()).toBeNull();
    });

    it('does not overwrite a live slot or delete its persisted record', async () => {
      // A live capture owns the slot.
      setPendingDeepLink('/live', 'universal-link');
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(true);
      });

      // A stale record from a previous process is still on disk.
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: '/stale',
          source: 'notification',
          storedAt: Date.now(),
        })
      );

      await restorePersistedPendingDeepLink();

      // The live slot is untouched and the persisted record is NOT deleted.
      expect(getPendingDeepLinkSnapshot()).toBe('/live');
      expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(true);
    });

    it('does not re-arm a slot consumed before restore completes', async () => {
      // A persisted record exists from a previous process.
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: '/stale',
          source: 'notification',
          storedAt: Date.now(),
        })
      );
      _resetDeepLinkLaunchForTests();

      // A live capture fills the slot, then the consumer consumes it.
      setPendingDeepLink('/live', 'universal-link');
      expect(getPendingDeepLink()).toBe('/live');
      // Consume enqueued a delete; wait for it to land.
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
      });

      // Restore runs after consume: the record is gone, so nothing is re-armed.
      await restorePersistedPendingDeepLink();
      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });

    it('does not re-arm a slot consumed while the restore read is in flight', async () => {
      // A persisted record exists from a previous process.
      store.set(
        PENDING_DEEP_LINK_KEY,
        JSON.stringify({
          href: '/stale',
          source: 'notification',
          storedAt: Date.now(),
        })
      );
      _resetDeepLinkLaunchForTests();

      // Hold the restore read open so a live capture+consume can land mid-read.
      const gate = deferred();
      secureStoreMock.getItemAsync.mockImplementationOnce(async () => {
        await gate.promise;
        return store.get(PENDING_DEEP_LINK_KEY) ?? null;
      });

      const restorePromise = restorePersistedPendingDeepLink();

      // A live capture fills the slot, then the consumer consumes it, while the
      // restore read is still pending.
      setPendingDeepLink('/live', 'universal-link');
      expect(getPendingDeepLink()).toBe('/live');

      // Release the read: the persisted record is still present, but the epoch
      // has moved, so restore must not re-arm the consumed slot.
      gate.resolve();
      await restorePromise;
      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });
  });

  describe('observable slot', () => {
    it('notifies subscribers on set and clear', () => {
      const listener = vi.fn<() => void>();
      const unsubscribe = subscribeToPendingDeepLink(listener);

      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'notification');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getPendingDeepLinkSnapshot()).toBe('/(app)/(tabs)/(3_profile)');

      getPendingDeepLink();
      expect(listener).toHaveBeenCalledTimes(2);
      expect(getPendingDeepLinkSnapshot()).toBeNull();

      unsubscribe();
      setPendingDeepLink('/after-unsubscribe', 'notification');
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('snapshot reflects the current slot without clearing', () => {
      setPendingDeepLink('/x', 'notification');
      expect(getPendingDeepLinkSnapshot()).toBe('/x');
      expect(getPendingDeepLinkSnapshot()).toBe('/x');
      expect(getPendingDeepLink()).toBe('/x');
    });
  });

  describe('captureLaunchDeepLink', () => {
    it('stashes a mapped launch URL synchronously', () => {
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/security-agent/findings');
      captureLaunchDeepLink();
      // Assert immediately — no await. The point of the test is synchronicity.
      expect(getPendingDeepLink()).toBe(
        '/(app)/(tabs)/(3_profile)/security-agent/personal/findings'
      );
    });

    it('carries the resume anchor of a cold launch URL into the stash', () => {
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/cloud/sessions/ses_1?at=msg%2042');
      captureLaunchDeepLink();
      // Assert immediately — no await. The point of the test is synchronicity.
      expect(getPendingDeepLink()).toBe('/(app)/agent-chat/ses_1?at=msg%2042');
    });

    it('keeps an anchor-less session launch href byte-identical', () => {
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/cloud/sessions/ses_1');
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBe('/(app)/agent-chat/ses_1');
    });

    it('is a no-op when the latch is already set (slot not overwritten)', () => {
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/profile');
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');

      // Second call must not write again even if getLinkingURL returns a new URL.
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/claw');
      setPendingDeepLink('/pre-existing', 'notification');
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBe('/pre-existing');
    });

    it('is a no-op when getLinkingURL returns null', () => {
      _setGetLinkingURLForTests(() => null);
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBeNull();
    });

    it('flags an app-scheme launch URL so the exact search route can replace it', () => {
      setCurrentDeepLinkUserId('user-1');
      _setGetLinkingURLForTests(
        () =>
          'kiloapp://pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com'
      );
      captureLaunchDeepLink();
      // The web table drops the instance query, so the search capture's exact
      // route for the same tap must replace this mapping.
      expect(getPendingDeepLinkSnapshot()).toBe('/(app)/pr-review/gitlab/group/sub/repo/12');

      setPendingDeepLink(
        '/(app)/pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com',
        'system-search'
      );
      expect(getPendingDeepLink()).toBe(
        '/(app)/pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com'
      );
    });

    it('does not let a stale search slot replace an unrelated app-scheme launch link', () => {
      setCurrentDeepLinkUserId('user-1');
      _setGetLinkingURLForTests(() => 'kiloapp://pr-review/octocat/hello-world/42');
      captureLaunchDeepLink();

      // A slot left over from an earlier, unconsumed search tap names a
      // different destination: the link the launch actually opened wins.
      setPendingDeepLink('/(app)/agent-chat/session-1', 'system-search');

      expect(getPendingDeepLink()).toBe('/(app)/pr-review/octocat/hello-world/42');
    });

    it('leaves an https launch link unflaggeable by the search route', () => {
      setCurrentDeepLinkUserId('user-1');
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/pr-review/octocat/hello-world/42');
      captureLaunchDeepLink();

      setPendingDeepLink('/(app)/agent-chat/other', 'system-search');
      expect(getPendingDeepLinkSnapshot()).toBe('/(app)/pr-review/octocat/hello-world/42');
    });

    it('is a no-op for an unmapped/garbage URL', () => {
      _setGetLinkingURLForTests(() => 'https://app.kilo.ai/admin');
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBeNull();

      // Latch only sets on a successful mapped capture; garbage still no-ops.
      _setGetLinkingURLForTests(() => 'not a url');
      captureLaunchDeepLink();
      expect(getPendingDeepLink()).toBeNull();
    });
  });

  describe('clearPendingDeepLink', () => {
    it('clears the in-memory slot and deletes the persisted record', async () => {
      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'notification');
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(true);
      });

      clearPendingDeepLink();

      expect(getPendingDeepLinkSnapshot()).toBeNull();
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(false);
      });
    });

    it('notifies subscribers so the layout consumer sees the cleared slot', () => {
      const listener = vi.fn<() => void>();
      const unsubscribe = subscribeToPendingDeepLink(listener);
      setPendingDeepLink('/x', 'notification');
      expect(listener).toHaveBeenCalledTimes(1);

      clearPendingDeepLink();
      expect(listener).toHaveBeenCalledTimes(2);
      expect(getPendingDeepLinkSnapshot()).toBeNull();

      unsubscribe();
    });
  });

  describe('clearAccountBoundPendingDeepLink', () => {
    it('clears a destination captured while signed in', () => {
      setCurrentDeepLinkUserId('user-a');
      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'universal-link');

      clearAccountBoundPendingDeepLink();

      expect(getPendingDeepLinkSnapshot()).toBeNull();
    });

    it('keeps a destination captured while signed out', () => {
      // currentDeepLinkUserId is null by default: the slot was captured signed out.
      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'universal-link');

      clearAccountBoundPendingDeepLink();

      expect(getPendingDeepLinkSnapshot()).toBe('/(app)/(tabs)/(3_profile)');
      // The slot is still consumable after the redundant sign-out.
      expect(getPendingDeepLink()).toBe('/(app)/(tabs)/(3_profile)');
    });

    it('keeps a signed-out destination and its persisted record on clear', async () => {
      setPendingDeepLink('/(app)/(tabs)/(3_profile)', 'universal-link');
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(true);
      });

      clearAccountBoundPendingDeepLink();

      expect(getPendingDeepLinkSnapshot()).toBe('/(app)/(tabs)/(3_profile)');
      // The persisted record survives so a later process still restores it.
      await vi.waitFor(() => {
        expect(store.has(PENDING_DEEP_LINK_KEY)).toBe(true);
      });
    });
  });

  describe('layout consumer gating', () => {
    const ready = {
      hasToken: true,
      isLoading: false,
      updateRequired: false,
      inAuthGroup: false,
      inForceUpdate: false,
      userIdLoading: false,
      userIdError: false,
      consentCheckError: false,
      consentChecked: true,
      needsConsent: false,
      onConsentRoute: false,
      onConsentReviewRoute: false,
    } as const;

    it('navigates exactly once once the shell is ready', () => {
      setPendingDeepLink('/dest', 'notification');
      expect(isShellReadyForShare(ready)).toBe(true);

      // The consumer effect runs when the shell becomes ready.
      const first = resolvePendingNavigation(getPendingDeepLink());
      expect(first?.href).toBe('/dest');
      // A re-run of the effect finds the slot empty: no second navigation.
      expect(getPendingDeepLink()).toBeNull();
    });

    it('holds the dest while any gate is not ready', () => {
      setPendingDeepLink('/dest', 'notification');

      const notReady = [
        { isLoading: true },
        { updateRequired: true },
        { inForceUpdate: true },
        { hasToken: false },
        { userIdError: true },
        { consentCheckError: true },
        { userIdLoading: true },
        { consentChecked: false },
        { needsConsent: true },
        { inAuthGroup: true },
        { onConsentRoute: true, onConsentReviewRoute: false },
      ];
      for (const gate of notReady) {
        expect(isShellReadyForShare({ ...ready, ...gate })).toBe(false);
      }

      // The dest is still held (not consumed) while the shell is not ready.
      expect(getPendingDeepLinkSnapshot()).toBe('/dest');
    });
  });
});
