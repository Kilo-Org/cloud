import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

import { acceptConsent, hasAcceptedConsent, revokeConsent } from './consent';

describe('consent storage', () => {
  beforeEach(() => {
    store.clear();
  });

  it('returns false when nothing is stored for the user', async () => {
    expect(await hasAcceptedConsent('user-1')).toBe(false);
  });

  it('returns true after acceptConsent for the same user', async () => {
    await acceptConsent('user-1');
    expect(await hasAcceptedConsent('user-1')).toBe(true);
  });

  it('isolates acceptance per user id', async () => {
    await acceptConsent('user-1');
    expect(await hasAcceptedConsent('user-2')).toBe(false);
  });

  it('revokes acceptance for the user', async () => {
    await acceptConsent('user-1');
    await revokeConsent('user-1');
    expect(await hasAcceptedConsent('user-1')).toBe(false);
  });
});
