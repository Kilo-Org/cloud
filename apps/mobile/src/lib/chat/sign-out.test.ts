import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What is dropped when the account goes.
 *
 * The places remembered for a chat scope are cached so the same account and
 * organization answer with the same object — a fresh one each render would
 * re-run the open effect. The Kilo MCP connection is cached for the same
 * reason and carries the same secret: tools discovered with one account's
 * token. Both are dropped with the chats rather than kept for the next person
 * to sign in.
 */

vi.mock('./registry', () => ({
  releaseEveryChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./store', () => ({
  wipeChats: vi.fn(() => ['gone']),
}));

vi.mock('./kilo-mcp', () => ({
  forgetKiloMcp: vi.fn(),
  forgetMcpEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/persist/encrypted-kv', () => ({
  encryptedDatabase: async () => {
    await Promise.resolve();
    return {};
  },
}));

const { chatPlaceOf, forgetChatPlaces } = await import('./scope');
const { forgetKiloMcp, forgetMcpEnabled } = await import('./kilo-mcp');
const { clearChatsForSignOut, releaseChatsForAccountSwitch } = await import('./sign-out');

beforeEach(() => {
  forgetChatPlaces();
  vi.mocked(forgetKiloMcp).mockClear();
  vi.mocked(forgetMcpEnabled).mockClear();
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

describe('the Kilo MCP connection', () => {
  it('is dropped when the account signs out', async () => {
    await clearChatsForSignOut('user-1');

    expect(forgetKiloMcp).toHaveBeenCalledTimes(1);
  });

  it('is dropped when another account signs in', async () => {
    await releaseChatsForAccountSwitch();

    expect(forgetKiloMcp).toHaveBeenCalledTimes(1);
  });

  it('takes the per-chat settings of the wiped chats with it', async () => {
    await clearChatsForSignOut('user-1');

    expect(forgetMcpEnabled).toHaveBeenCalledWith(['gone']);
  });
});
