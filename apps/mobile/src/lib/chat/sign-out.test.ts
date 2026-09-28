import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What is dropped when the account goes.
 *
 * The places remembered for a chat scope are cached so the same account and
 * organization answer with the same object — a fresh one each render would
 * re-run the open effect. The Kilo MCP connection is cached for the same
 * reason and carries the same secret: tools discovered with one account's
 * token. The remote MCP connection and the servers stored behind it carry that
 * secret too, and the settings-tools group switch is account-scoped. All of
 * them are dropped with the chats rather than kept for the next person to sign
 * in.
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

// The remote MCP store and the settings-tools switch ride on the shared
// SecureStore preference, which pulls sonner-native -> react-native (Flow
// `import typeof`) into the node test environment. Mock the native boundaries
// so the real stores under test can be seeded, read and cleared.
const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-secure-store', () => secureStore);

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const { chatPlaceOf, forgetChatPlaces } = await import('./scope');
const { forgetKiloMcp, forgetMcpEnabled } = await import('./kilo-mcp');
const { addRemoteMcpServer, clearRemoteMcpServers, listRemoteMcpServers } =
  await import('./remote-mcp-store');
const { remoteMcpState } = await import('./remote-mcp');
const { clearSettingsToolsEnabled, isSettingsToolsEnabled, setSettingsToolsEnabled } =
  await import('./settings-tools-switch');
const { clearChatsForSignOut, releaseChatsForAccountSwitch } = await import('./sign-out');

/** A remote server the account added, so the clears have something to drop. */
function addServer(): void {
  addRemoteMcpServer({
    name: 'Alpha',
    url: 'https://alpha.example/mcp',
    auth: { type: 'none' },
    enabled: true,
  });
}

beforeEach(() => {
  forgetChatPlaces();
  vi.mocked(forgetKiloMcp).mockClear();
  vi.mocked(forgetMcpEnabled).mockClear();
  clearRemoteMcpServers();
  clearSettingsToolsEnabled();
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

describe('the remote MCP connection and its stored servers', () => {
  it('are dropped when the account signs out', async () => {
    addServer();
    setSettingsToolsEnabled(false);
    expect(listRemoteMcpServers()).toHaveLength(1);
    expect(remoteMcpState()).toHaveLength(1);
    expect(isSettingsToolsEnabled()).toBe(false);

    await clearChatsForSignOut('user-1');

    expect(listRemoteMcpServers()).toEqual([]);
    expect(remoteMcpState()).toEqual([]);
    // The group switch is account-scoped: the next account starts from its
    // default rather than inheriting the previous account's choice.
    expect(isSettingsToolsEnabled()).toBe(true);
  });

  it('are dropped when another account signs in', async () => {
    addServer();
    setSettingsToolsEnabled(false);
    expect(listRemoteMcpServers()).toHaveLength(1);
    expect(remoteMcpState()).toHaveLength(1);

    await releaseChatsForAccountSwitch();

    expect(listRemoteMcpServers()).toEqual([]);
    expect(remoteMcpState()).toEqual([]);
    expect(isSettingsToolsEnabled()).toBe(true);
  });
});
