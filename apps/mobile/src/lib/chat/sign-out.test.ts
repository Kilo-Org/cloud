import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The places remembered for a chat scope.
 *
 * Where a chat belongs is cached so the same account and organization answer
 * with the same object — a fresh one each render would re-run the open effect.
 * The cache is account-scoped like the chats themselves, so it is dropped with
 * them rather than keeping one account's scopes for the next.
 */

vi.mock('./registry', () => ({
  releaseEveryChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./store', () => ({
  wipeChats: vi.fn(),
}));

vi.mock('@/lib/persist/encrypted-kv', () => ({
  encryptedDatabase: async () => {
    await Promise.resolve();
    return {};
  },
}));

const { chatPlaceOf, forgetChatPlaces } = await import('./scope');
const { clearChatsForSignOut, releaseChatsForAccountSwitch } = await import('./sign-out');

beforeEach(() => {
  forgetChatPlaces();
});

describe('the places remembered for a chat scope', () => {
  it('is dropped when the account signs out', async () => {
    const before = chatPlaceOf('user-1', null);
    expect(chatPlaceOf('user-1', null)).toBe(before);

    await clearChatsForSignOut('user-1');

    expect(chatPlaceOf('user-1', null)).not.toBe(before);
  });

  it('is dropped when another account signs in', async () => {
    const before = chatPlaceOf('user-1', 'org-1');

    await releaseChatsForAccountSwitch();

    expect(chatPlaceOf('user-1', 'org-1')).not.toBe(before);
  });
});
