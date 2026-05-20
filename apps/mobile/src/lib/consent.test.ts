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
    const { hasAcceptedConsent } = await import('./consent');

    expect(await hasAcceptedConsent('user-1')).toBe(false);
  });

  it('returns true after acceptConsent for the same user', async () => {
    const { CURRENT_CONSENT_VERSION, acceptConsent, hasAcceptedConsent } =
      await import('./consent');

    await acceptConsent('user-1');
    expect(store.get('consent-accepted-user1')).toBe(String(CURRENT_CONSENT_VERSION));
    expect(await hasAcceptedConsent('user-1')).toBe(true);
  });

  it('strips characters that are invalid in SecureStore keys', async () => {
    const { CURRENT_CONSENT_VERSION, acceptConsent, hasAcceptedConsent } =
      await import('./consent');

    await acceptConsent('oauth/google:103283381342696699340');
    expect(store.get('consent-accepted-oauthgoogle103283381342696699340')).toBe(
      String(CURRENT_CONSENT_VERSION)
    );
    expect(await hasAcceptedConsent('oauth/google:103283381342696699340')).toBe(true);
  });

  it('returns false when the stored consent version is old', async () => {
    const { hasAcceptedConsent } = await import('./consent');

    store.set('consent-accepted-user1', '0');

    expect(await hasAcceptedConsent('user-1')).toBe(false);
  });

  it('returns false for old unversioned consent records', async () => {
    const { hasAcceptedConsent } = await import('./consent');

    store.set('consent-accepted-user1', 'true');

    expect(await hasAcceptedConsent('user-1')).toBe(false);
  });

  it('isolates acceptance per user id', async () => {
    const { acceptConsent, hasAcceptedConsent } = await import('./consent');

    await acceptConsent('user-1');
    expect(await hasAcceptedConsent('user-2')).toBe(false);
  });

  it('revokes acceptance for the user', async () => {
    const { acceptConsent, hasAcceptedConsent, revokeConsent } = await import('./consent');

    await acceptConsent('user-1');
    await revokeConsent('user-1');
    expect(await hasAcceptedConsent('user-1')).toBe(false);
  });

  it('notifies listeners when consent changes for a user', async () => {
    const { acceptConsent, revokeConsent, subscribeToConsentChanges } = await import('./consent');
    const changes: string[] = [];

    const unsubscribe = subscribeToConsentChanges(change => {
      changes.push(`${change.userId}:${change.hasAccepted ? 'accepted' : 'revoked'}`);
    });

    await acceptConsent('user-1');
    await revokeConsent('user-1');
    unsubscribe();

    expect(changes).toEqual(['user-1:accepted', 'user-1:revoked']);
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
