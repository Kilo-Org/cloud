import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_MCP_SERVERS_KEY, SETTINGS_TOOLS_ENABLED_KEY } from '@/lib/storage-keys';

import {
  addChatBackend,
  clearChatBackends,
  listChatBackends,
  waitForChatBackends,
} from './backend-store';

/**
 * What is dropped when the account goes.
 *
 * The places remembered for a chat scope are cached so the same account and
 * organization answer with the same object — a fresh one each render would
 * re-run the open effect. The remote MCP connection and the servers stored
 * behind it carry a secret, the settings-tools group switch is account-scoped,
 * and the per-chat web-search choice belongs to a chat that is going away. All
 * of them are dropped with the chats rather than kept for the next person to
 * sign in.
 *
 * The Kilo MCP connection is dropped here too; its cache is tested beside it,
 * in `kilo-mcp.test.ts`.
 */

vi.mock('./registry', () => ({
  releaseEveryChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./store', () => ({
  wipeChats: vi.fn(() => ['gone']),
}));

// `sign-out.ts` imports this module. Stub it so the Kilo MCP cache and its
// client stay out of a test that owns the account boundary.
vi.mock('./kilo-mcp', () => ({
  forgetKiloMcp: vi.fn(),
  forgetMcpEnabled: vi.fn().mockResolvedValue(undefined),
}));

// One in-test disk behind the encrypted-kv boundary. The per-chat preferences
// a boundary module writes land here, so a test waits on the stored value
// instead of on a number of event-loop turns. Each mock returns a settled
// promise, because an `async` arrow with nothing to await fails the linter.
const encryptedKv = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/persist/encrypted-kv', () => ({
  encryptedDatabase: () => Promise.resolve({}),
  getItem: (scope: string, key: string) =>
    Promise.resolve(encryptedKv.get(`${scope}:${key}`) ?? null),
  setItem: (scope: string, key: string, value: string) => {
    encryptedKv.set(`${scope}:${key}`, value);
    return Promise.resolve();
  },
  removeItem: (scope: string, key: string) => {
    encryptedKv.delete(`${scope}:${key}`);
    return Promise.resolve();
  },
}));

// The remote MCP store and the settings-tools switch ride on the shared
// SecureStore preference, which pulls sonner-native -> react-native (Flow
// `import typeof`) into the node test environment. Mock the native boundary
// with an in-test disk: the real stores under test can be seeded, read and
// cleared, and a test can wait until a write has landed.
const secureStore = vi.hoisted(() => ({ disk: new Map<string, string>() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: (key: string) => Promise.resolve(secureStore.disk.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    secureStore.disk.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    secureStore.disk.delete(key);
    return Promise.resolve();
  },
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'a0000000-0000-4000-8000-000000000001' }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => 'online',
}));

const { chatPlaceOf, forgetChatPlaces } = await import('./scope');
const { addRemoteMcpServer, clearRemoteMcpServers, listRemoteMcpServers, parseRemoteMcpServers } =
  await import('./remote-mcp-store');
const { remoteMcpState } = await import('./remote-mcp');
const { clearSettingsToolsEnabled, isSettingsToolsEnabled, setSettingsToolsEnabled } =
  await import('./settings-tools-switch');
const { clearChatsForSignOut, releaseChatsForAccountSwitch } = await import('./sign-out');
const { askedIn, rememberAsked } = await import('./pending');
const { setWebSearchEnabled, webSearchEnabledFor } = await import('./web-search-setting');

/** A remote server the account added, so the clears have something to drop. */
function addServer(): void {
  addRemoteMcpServer({
    name: 'Alpha',
    url: 'https://alpha.example/mcp',
    auth: { type: 'none' },
    enabled: true,
  });
}

/**
 * Seeds the two secured preferences the boundary drops, and waits until both
 * writes are on the fake disk and both stores have published them: a clear can
 * only be shown to erase a value that landed first.
 */
async function seedSecuredPreferences(): Promise<void> {
  addServer();
  setSettingsToolsEnabled(false);
  await vi.waitFor(() => {
    expect(
      parseRemoteMcpServers(secureStore.disk.get(REMOTE_MCP_SERVERS_KEY) ?? null)
    ).toHaveLength(1);
    expect(secureStore.disk.get(SETTINGS_TOOLS_ENABLED_KEY)).toBe('false');
    // A store publishes one microtask after its write lands.
    expect(listRemoteMcpServers()).toHaveLength(1);
    expect(remoteMcpState()).toHaveLength(1);
  });
}

beforeEach(() => {
  forgetChatPlaces();
  encryptedKv.clear();
  secureStore.disk.clear();
  clearRemoteMcpServers();
  clearSettingsToolsEnabled();
  clearChatBackends();
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

describe('remembered question targets', () => {
  it('discards the questions and targets of wiped chats without touching another account', async () => {
    await rememberAsked('gone', {
      text: 'unsent custom question',
      model: 'backend:private:1:model',
      effort: null,
      images: [],
    });
    await rememberAsked('kept', {
      text: 'another account question',
      model: 'kilo/one',
      effort: null,
      images: [],
    });

    await clearChatsForSignOut('user-1');

    expect(await askedIn('gone')).toBeNull();
    expect(await askedIn('kept')).toEqual({
      text: 'another account question',
      model: 'kilo/one',
      effort: null,
      images: [],
      failureKey: null,
    });
  });

  it('keeps the questions and targets when an account switch retains its stored chats', async () => {
    await rememberAsked('gone', {
      text: 'unsent custom question',
      model: 'backend:private:1:model',
      effort: null,
      images: [],
    });

    await releaseChatsForAccountSwitch();

    expect(await askedIn('gone')).toEqual({
      text: 'unsent custom question',
      model: 'backend:private:1:model',
      effort: null,
      images: [],
      failureKey: null,
    });
  });
});

describe('the per-chat web-search choice', () => {
  it('is dropped with the wiped chats and left on the chats that stay', async () => {
    await setWebSearchEnabled('gone', false);
    await setWebSearchEnabled('kept', false);
    // Off differs from the default of a Kilo model, so a setting that did not
    // land cannot read as off here.
    expect(await webSearchEnabledFor('gone', 'kilo/one')).toBe(false);
    expect(await webSearchEnabledFor('kept', 'kilo/one')).toBe(false);

    await clearChatsForSignOut('user-1');

    // The wiped chat reads the default of the model its next question goes to,
    // which a stored choice of off cannot produce. The chat of another account
    // keeps the choice it made.
    expect(await webSearchEnabledFor('gone', 'kilo/one')).toBe(true);
    expect(await webSearchEnabledFor('kept', 'kilo/one')).toBe(false);
  });
});

describe('the remote MCP connection and its stored servers', () => {
  it('are dropped when the account signs out', async () => {
    await seedSecuredPreferences();
    expect(listRemoteMcpServers()).toHaveLength(1);
    expect(remoteMcpState()).toHaveLength(1);
    expect(isSettingsToolsEnabled()).toBe(false);

    await clearChatsForSignOut('user-1');

    expect(listRemoteMcpServers()).toEqual([]);
    expect(remoteMcpState()).toEqual([]);
    // The group switch is account-scoped: the next account starts from its
    // default rather than inheriting the previous account's choice.
    expect(isSettingsToolsEnabled()).toBe(true);
    // The erase reaches the disk, not only the snapshots the screens read.
    await vi.waitFor(() => {
      expect(secureStore.disk.has(REMOTE_MCP_SERVERS_KEY)).toBe(false);
      expect(secureStore.disk.has(SETTINGS_TOOLS_ENABLED_KEY)).toBe(false);
    });
  });

  it('are dropped when another account signs in', async () => {
    await seedSecuredPreferences();
    expect(listRemoteMcpServers()).toHaveLength(1);
    expect(remoteMcpState()).toHaveLength(1);

    await releaseChatsForAccountSwitch();

    expect(listRemoteMcpServers()).toEqual([]);
    expect(remoteMcpState()).toEqual([]);
    expect(isSettingsToolsEnabled()).toBe(true);
    await vi.waitFor(() => {
      expect(secureStore.disk.has(REMOTE_MCP_SERVERS_KEY)).toBe(false);
      expect(secureStore.disk.has(SETTINGS_TOOLS_ENABLED_KEY)).toBe(false);
    });
  });
});

describe('custom backend credentials at account boundaries', () => {
  it.each([
    [
      'sign-out',
      async () => {
        await clearChatsForSignOut('user-1');
      },
    ],
    ['account switch', releaseChatsForAccountSwitch],
  ])('removes the departing account profile on %s', async (_boundary, clear) => {
    await waitForChatBackends();
    const backend = addChatBackend({
      name: 'Private',
      baseUrl: 'https://private.example/v1',
      apiKind: 'chat_completions',
      apiKey: 'test-account-key',
      headers: { 'x-private-header': 'test-account-header' },
      models: [{ id: 'model', name: 'Model', tools: false, images: false, reasoning: false }],
      allowLocalHttp: false,
    });
    expect(listChatBackends()).toEqual([backend]);
    await clear();
    expect(listChatBackends()).toEqual([]);
  });
});
