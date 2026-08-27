/* oxlint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

const posthogMock = vi.hoisted(() => {
  const captureEvent = vi.fn();
  const flushLastPostHogEvent = vi.fn().mockResolvedValue(undefined);
  let isReady = false;
  let readyListener: (() => void) | null = null;
  const isPostHogReady = vi.fn(() => isReady);
  const subscribeToPostHogReady = vi.fn((listener: () => void) => {
    readyListener = listener;
    return () => {
      if (readyListener === listener) {
        readyListener = null;
      }
    };
  });
  return {
    captureEvent,
    flushLastPostHogEvent,
    isPostHogReady,
    subscribeToPostHogReady,
    setReady(value: boolean) {
      isReady = value;
    },
    fireReady() {
      readyListener?.();
    },
  };
});

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  }),
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: posthogMock.captureEvent,
  flushLastPostHogEvent: posthogMock.flushLastPostHogEvent,
  isPostHogReady: posthogMock.isPostHogReady,
  subscribeToPostHogReady: posthogMock.subscribeToPostHogReady,
  CONSENT_OUTCOME_EVENT: 'consent_outcome',
}));

/* eslint-disable import/first */
import * as SecureStore from 'expo-secure-store';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { chainSave } from '@/lib/hooks/save-chain';
/* eslint-enable import/first */

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => {
    setImmediate(resolve);
  });
}

describe('consent storage', () => {
  beforeEach(() => {
    store.clear();
  });

  it('returns false when nothing is stored for the user', async () => {
    const { hasAcceptedConsent, readConsent } = await import('./consent');

    expect(await hasAcceptedConsent('user-1')).toBe(false);
    expect(await readConsent('user-1')).toEqual({
      mandatory: false,
      optional: false,
    });
  });

  it('returns true after acceptConsent for the same user', async () => {
    const { CURRENT_CONSENT_VERSION, acceptConsent, hasAcceptedConsent } =
      await import('./consent');

    await acceptConsent('user-1');
    // Hex of "user-1"
    const storedRaw = store.get('consent-accepted-757365722d31');
    expect(storedRaw).toBe(JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional: false }));
    expect(await hasAcceptedConsent('user-1')).toBe(true);
  });

  it('uses a hex-encoded key that is injective for every user id', async () => {
    const { acceptConsent, hasAcceptedConsent } = await import('./consent');

    // These two ids differ only in stripped characters under the old scheme
    await acceptConsent('oauth/google:103283381342696699340');
    await acceptConsent('oauthgoogle103283381342696699340');

    // Each gets its own key
    const keys = [...store.keys()];
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);

    expect(await hasAcceptedConsent('oauth/google:103283381342696699340')).toBe(true);
    expect(await hasAcceptedConsent('oauthgoogle103283381342696699340')).toBe(true);
  });

  it('returns false when the stored consent version is old', async () => {
    const { hasAcceptedConsent, readConsent } = await import('./consent');

    // Hex-encoded "user-1" is "757365722d31"
    store.set('consent-accepted-757365722d31', JSON.stringify({ v: 1, optional: false }));

    expect(await hasAcceptedConsent('user-1')).toBe(false);
    expect(await readConsent('user-1')).toEqual({
      mandatory: false,
      optional: false,
    });
  });

  it('returns false for old unversioned consent records', async () => {
    const { hasAcceptedConsent } = await import('./consent');

    // Hex of "user-1"
    store.set('consent-accepted-757365722d31', 'true');

    expect(await hasAcceptedConsent('user-1')).toBe(false);
  });

  it('deletes a legacy key and forces re-consent', async () => {
    const { hasAcceptedConsent, readConsent } = await import('./consent');

    // Old strip-based key for "oauth/google:foo"
    store.set('consent-accepted-oauthgooglefoo', JSON.stringify({ v: 1, optional: false }));

    expect(await hasAcceptedConsent('oauth/google:foo')).toBe(false);
    expect(await readConsent('oauth/google:foo')).toEqual({
      mandatory: false,
      optional: false,
    });
    // Legacy key is removed
    expect(store.has('consent-accepted-oauthgooglefoo')).toBe(false);
  });

  it('isolates acceptance per user id', async () => {
    const { acceptConsent, hasAcceptedConsent } = await import('./consent');

    await acceptConsent('user-1');
    expect(await hasAcceptedConsent('user-2')).toBe(false);
  });

  it('revokes acceptance and deletes both hex and legacy keys', async () => {
    const { hasAcceptedConsent, revokeConsent } = await import('./consent');

    // Set up hex and legacy keys for the revoked user
    store.set('consent-accepted-757365722d31', JSON.stringify({ v: 2, optional: false }));
    store.set('consent-accepted-user1', JSON.stringify({ v: 2, optional: false }));

    // Set up keys for a different user to prove they survive
    store.set('consent-accepted-757365722d32', 'stale');
    store.set('consent-accepted-user2', 'stale');

    await revokeConsent('user-1');

    expect(await hasAcceptedConsent('user-1')).toBe(false);
    // Both hex and legacy keys for user-1 are deleted
    expect(store.has('consent-accepted-757365722d31')).toBe(false);
    expect(store.has('consent-accepted-user1')).toBe(false);
    // User-2 keys are untouched
    expect(store.has('consent-accepted-757365722d32')).toBe(true);
    expect(store.has('consent-accepted-user2')).toBe(true);
  });

  it('round-trips optional consent in a v2 record', async () => {
    const { acceptConsent, readConsent, hasAcceptedConsent } = await import('./consent');

    await acceptConsent('user-1', true);

    expect(await hasAcceptedConsent('user-1')).toBe(true);
    expect(await readConsent('user-1')).toEqual({
      mandatory: true,
      optional: true,
    });
  });

  it('acceptConsent with no second argument stores optional: false', async () => {
    const { CURRENT_CONSENT_VERSION, acceptConsent, readConsent } = await import('./consent');

    await acceptConsent('user-1');

    expect(await readConsent('user-1')).toEqual({
      mandatory: true,
      optional: false,
    });

    // Hex of "user-1"
    const raw = store.get('consent-accepted-757365722d31');
    expect(raw).toBe(JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional: false }));
  });

  it('setOptionalConsent updates optional and leaves mandatory untouched', async () => {
    const { CURRENT_CONSENT_VERSION, acceptConsent, readConsent, setOptionalConsent } =
      await import('./consent');

    await acceptConsent('user-1', true);

    await setOptionalConsent('user-1', false);

    expect(await readConsent('user-1')).toEqual({
      mandatory: true,
      optional: false,
    });

    const raw = store.get('consent-accepted-757365722d31');
    expect(raw).toBe(JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional: false }));
  });

  it('setOptionalConsent does nothing when no accepted record exists', async () => {
    const { acceptConsent, hasAcceptedConsent, readConsent, setOptionalConsent } =
      await import('./consent');

    await acceptConsent('user-2');
    await setOptionalConsent('user-1', true);

    // user-1 has no record — nothing changed
    expect(await hasAcceptedConsent('user-1')).toBe(false);
    expect(await readConsent('user-1')).toEqual({
      mandatory: false,
      optional: false,
    });
    // user-2 untouched
    expect(await hasAcceptedConsent('user-2')).toBe(true);
  });

  it('notifies listeners when consent changes for a user', async () => {
    const { acceptConsent, revokeConsent, subscribeToConsentChanges } = await import('./consent');
    const changes: string[] = [];

    const unsubscribe = subscribeToConsentChanges(change => {
      changes.push(
        `${change.userId}:${change.hasAccepted ? 'accepted' : 'revoked'}:optional=${change.optional}`
      );
    });

    await acceptConsent('user-1');
    await revokeConsent('user-1');
    unsubscribe();

    expect(changes).toEqual(['user-1:accepted:optional=false', 'user-1:revoked:optional=false']);
  });

  it('notifies with optional: true when accepted with optional consent', async () => {
    const { acceptConsent, subscribeToConsentChanges } = await import('./consent');
    const changes: string[] = [];

    const unsubscribe = subscribeToConsentChanges(change => {
      changes.push(`${change.userId}:optional=${change.optional}`);
    });

    await acceptConsent('user-1', true);
    unsubscribe();

    expect(changes).toEqual(['user-1:optional=true']);
  });

  it('setOptionalConsent notifies listeners', async () => {
    const { acceptConsent, setOptionalConsent, subscribeToConsentChanges } =
      await import('./consent');
    const changes: string[] = [];

    await acceptConsent('user-1');

    const unsubscribe = subscribeToConsentChanges(change => {
      changes.push(`${change.userId}:optional=${change.optional}`);
    });

    await setOptionalConsent('user-1', true);
    unsubscribe();

    expect(changes).toEqual(['user-1:optional=true']);
  });

  it('stops notifying unsubscribed consent listeners', async () => {
    const { acceptConsent, subscribeToConsentChanges } = await import('./consent');
    const changes: string[] = [];

    const unsubscribe = subscribeToConsentChanges(change => {
      changes.push(change.userId);
    });

    unsubscribe();
    await acceptConsent('user-1');

    expect(changes).toEqual([]);
  });

  it('a consent write queued across an auth epoch bump still lands', async () => {
    const { CURRENT_CONSENT_VERSION, acceptConsent } = await import('./consent');
    let releaseBlock: (() => void) | undefined = undefined;
    const gate = new Promise<void>(resolve => {
      releaseBlock = resolve;
    });

    // Hold the user's consent chain open, then queue acceptConsent behind it.
    // Consent is `account-metadata (persistent)`: it must SURVIVE sign-out,
    // so the queued write runs even though the epoch moved while it waited.
    const blocker = chainSave('consent-accepted-757365722d31', async () => {
      await gate;
    });
    const queued = acceptConsent('user-1');

    bumpAuthEpoch();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    releaseBlock!();
    await Promise.all([blocker, queued]);

    expect(store.get('consent-accepted-757365722d31')).toBe(
      JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional: false })
    );
  });

  it('serializes concurrent consent writes for the same user in FIFO order', async () => {
    const { CURRENT_CONSENT_VERSION, acceptConsent } = await import('./consent');
    let releaseFirst: (() => void) | undefined = undefined;
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let firstWriteStarted = false;

    // Block the first write so the second can be observed waiting in the
    // queue instead of interleaving with it.
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async () => {
      firstWriteStarted = true;
      await gate;
    });

    const first = acceptConsent('user-1', false);
    const second = acceptConsent('user-1', true);

    await flushMicrotasks();
    // The first write holds the key's chain; the second has not started.
    expect(firstWriteStarted).toBe(true);
    expect(store.has('consent-accepted-757365722d31')).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    releaseFirst!();
    await Promise.all([first, second]);

    // Both writes landed without interleaving; the queued one is last.
    expect(store.get('consent-accepted-757365722d31')).toBe(
      JSON.stringify({ v: CURRENT_CONSENT_VERSION, optional: true })
    );
  });

  it('does not restore a consent record after a concurrent revoke', async () => {
    const { acceptConsent, hasAcceptedConsent, revokeConsent, setOptionalConsent } =
      await import('./consent');
    let releaseBlocker: (() => void) | undefined = undefined;
    const gate = new Promise<void>(resolve => {
      releaseBlocker = resolve;
    });

    await acceptConsent('user-1', false);

    // Hold the user's consent chain open, then queue a revoke followed by a
    // stale optional-consent update. The update reads inside the same per-user
    // chain, so it observes the revoke's delete and must skip its write.
    const blocker = chainSave('consent-accepted-757365722d31', async () => {
      await gate;
    });
    const revoke = revokeConsent('user-1');
    const optionalUpdate = setOptionalConsent('user-1', true);

    await flushMicrotasks();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    releaseBlocker!();
    await Promise.all([blocker, revoke, optionalUpdate]);

    // Revoke is authoritative: the queued optional update must not recreate it.
    expect(await hasAcceptedConsent('user-1')).toBe(false);
    expect(store.has('consent-accepted-757365722d31')).toBe(false);
  });
});

describe('consent outcome analytics', () => {
  beforeEach(() => {
    store.clear();
    posthogMock.captureEvent.mockClear();
    posthogMock.flushLastPostHogEvent.mockClear();
    posthogMock.setReady(false);
    // Drain any pending outcome left by a previous test so this test starts clean.
    posthogMock.setReady(true);
    posthogMock.fireReady();
    posthogMock.setReady(false);
    posthogMock.captureEvent.mockClear();
    posthogMock.flushLastPostHogEvent.mockClear();
  });

  it('queues an accept outcome until the ready listener fires ready', async () => {
    const { acceptConsent } = await import('./consent');
    await acceptConsent('user-1', true);

    // Not ready: nothing captured yet.
    expect(posthogMock.captureEvent).not.toHaveBeenCalled();

    posthogMock.setReady(true);
    posthogMock.fireReady();

    expect(posthogMock.captureEvent).toHaveBeenCalledTimes(1);
    expect(posthogMock.captureEvent).toHaveBeenCalledWith('consent_outcome', {
      action: 'accepted',
      optional: true,
    });
  });

  it('clears a queued outcome so a later ready transition cannot emit it', async () => {
    const { acceptConsent, clearPendingConsentOutcome } = await import('./consent');
    await acceptConsent('user-1', true);

    // Not ready: the accept outcome is queued and nothing captured yet.
    expect(posthogMock.captureEvent).not.toHaveBeenCalled();

    // Sign-out clears the queued outcome during teardown.
    clearPendingConsentOutcome();

    posthogMock.setReady(true);
    posthogMock.fireReady();

    // The stale payload must not drain onto a later account's client.
    expect(posthogMock.captureEvent).not.toHaveBeenCalled();
  });

  it('does not capture when the ready listener fires while not ready', async () => {
    const { acceptConsent } = await import('./consent');
    await acceptConsent('user-1', true);

    posthogMock.fireReady();

    expect(posthogMock.captureEvent).not.toHaveBeenCalled();
  });

  it('does not re-queue a duplicate accept with the same optional value', async () => {
    const { acceptConsent } = await import('./consent');
    await acceptConsent('user-1', true);
    await acceptConsent('user-1', true);

    posthogMock.setReady(true);
    posthogMock.fireReady();

    expect(posthogMock.captureEvent).toHaveBeenCalledTimes(1);
    expect(posthogMock.captureEvent).toHaveBeenCalledWith('consent_outcome', {
      action: 'accepted',
      optional: true,
    });
  });

  it('queues setOptionalConsent(true) until the ready listener fires', async () => {
    const { acceptConsent, setOptionalConsent } = await import('./consent');
    await acceptConsent('user-1', false);
    posthogMock.captureEvent.mockClear();

    await setOptionalConsent('user-1', true);

    expect(posthogMock.captureEvent).not.toHaveBeenCalled();

    posthogMock.setReady(true);
    posthogMock.fireReady();

    expect(posthogMock.captureEvent).toHaveBeenCalledTimes(1);
    expect(posthogMock.captureEvent).toHaveBeenCalledWith('consent_outcome', {
      action: 'optional_changed',
      optional: true,
    });
  });

  it('setOptionalConsent(false) captures, flushes, then notifies listeners', async () => {
    const { acceptConsent, setOptionalConsent, subscribeToConsentChanges } =
      await import('./consent');
    await acceptConsent('user-1', true);
    posthogMock.captureEvent.mockClear();
    posthogMock.flushLastPostHogEvent.mockClear();

    const listener = vi.fn<() => void>();
    subscribeToConsentChanges(listener);

    await setOptionalConsent('user-1', false);

    expect(posthogMock.captureEvent).toHaveBeenCalledWith('consent_outcome', {
      action: 'optional_changed',
      optional: false,
    });
    expect(posthogMock.flushLastPostHogEvent).toHaveBeenCalledTimes(1);

    const captureCall = posthogMock.captureEvent.mock.invocationCallOrder[0];
    const flushCall = posthogMock.flushLastPostHogEvent.mock.invocationCallOrder[0];
    const listenerCall = listener.mock.invocationCallOrder[0];
    if (captureCall === undefined || flushCall === undefined || listenerCall === undefined) {
      throw new Error('expected consent change call order to be recorded');
    }
    expect(captureCall).toBeLessThan(flushCall);
    expect(flushCall).toBeLessThan(listenerCall);
  });

  it('revokeConsent captures revoked then flushes', async () => {
    const { acceptConsent, revokeConsent } = await import('./consent');
    await acceptConsent('user-1', true);
    posthogMock.captureEvent.mockClear();
    posthogMock.flushLastPostHogEvent.mockClear();

    await revokeConsent('user-1');

    expect(posthogMock.captureEvent).toHaveBeenCalledWith('consent_outcome', {
      action: 'revoked',
      optional: false,
    });
    expect(posthogMock.flushLastPostHogEvent).toHaveBeenCalledTimes(1);
  });

  it('does not capture when the optional value is unchanged', async () => {
    const { acceptConsent, setOptionalConsent } = await import('./consent');
    await acceptConsent('user-1', true);
    posthogMock.captureEvent.mockClear();
    posthogMock.flushLastPostHogEvent.mockClear();

    await setOptionalConsent('user-1', true);

    expect(posthogMock.captureEvent).not.toHaveBeenCalled();
    expect(posthogMock.flushLastPostHogEvent).not.toHaveBeenCalled();
  });

  it('does not capture when setOptionalConsent has no prior accept', async () => {
    const { setOptionalConsent } = await import('./consent');

    await setOptionalConsent('user-1', true);

    expect(posthogMock.captureEvent).not.toHaveBeenCalled();
    expect(posthogMock.flushLastPostHogEvent).not.toHaveBeenCalled();
  });
});
