import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

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
});
