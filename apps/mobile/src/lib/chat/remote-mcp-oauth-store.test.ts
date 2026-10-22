import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AuthEpochModule from '@/lib/auth/auth-epoch';

import type * as OAuthStoreModule from './remote-mcp-oauth-store';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const SERVER = { id: 'demo', url: 'https://demo.example/mcp' };
const TOKENS = { access_token: 'access', token_type: 'Bearer' };
const CLIENT = { client_id: 'client' };

/** A disk read that answers only when the test says so. */
function heldDiskRead(stored: string | null): () => void {
  const read = Promise.withResolvers<string | null>();
  getItemAsync.mockReturnValue(read.promise);
  return () => {
    read.resolve(stored);
  };
}

// The store and the auth epoch are module singletons; a fresh module graph
// gives each test a store whose one disk read has not started yet.
async function fresh(): Promise<{
  store: typeof OAuthStoreModule;
  epoch: typeof AuthEpochModule;
}> {
  vi.resetModules();
  const [store, epoch] = await Promise.all([
    import('./remote-mcp-oauth-store'),
    import('@/lib/auth/auth-epoch'),
  ]);
  return { store, epoch };
}

beforeEach(() => {
  getItemAsync.mockReset();
  setItemAsync.mockReset().mockResolvedValue(undefined);
  deleteItemAsync.mockReset().mockResolvedValue(undefined);
});

describe('writing a remote MCP server OAuth state', () => {
  it('keeps both of two writes that wait on the same disk read', async () => {
    const { store, epoch } = await fresh();
    const answer = heldDiskRead(JSON.stringify({ other: { url: 'https://other.example/mcp' } }));
    const owner = { ...SERVER, epoch: epoch.currentAuthEpoch() };

    const tokens = store.writeRemoteMcpOAuth(owner, { tokens: TOKENS });
    const client = store.writeRemoteMcpOAuth(owner, { client: CLIENT });
    answer();
    await tokens;
    await client;

    expect(await store.readRemoteMcpOAuth(SERVER.id, SERVER.url)).toEqual({
      url: SERVER.url,
      tokens: TOKENS,
      client: CLIENT,
    });
    expect(await store.readRemoteMcpOAuth('other', 'https://other.example/mcp')).toEqual({
      url: 'https://other.example/mcp',
    });
  });

  it('reads a write the disk has not taken yet', async () => {
    const { store, epoch } = await fresh();
    heldDiskRead(null)();
    const landing = Promise.withResolvers<void>();
    setItemAsync.mockReturnValue(landing.promise);

    await store.writeRemoteMcpOAuth(
      { ...SERVER, epoch: epoch.currentAuthEpoch() },
      { tokens: TOKENS }
    );

    // The store holds the choice before the disk does, and the endpoint match
    // applies to that choice too.
    expect(await store.readRemoteMcpOAuth(SERVER.id, 'https://demo.example/mcp/')).toEqual({
      url: SERVER.url,
      tokens: TOKENS,
    });
    expect(await store.readRemoteMcpOAuth(SERVER.id, 'https://other.example/mcp')).toBeUndefined();
    landing.resolve();
  });

  it('drops a write that a sign-out overtook while it waited on the disk read', async () => {
    const { store, epoch } = await fresh();
    const answer = heldDiskRead(null);
    const write = store.writeRemoteMcpOAuth(
      { ...SERVER, epoch: epoch.currentAuthEpoch() },
      { tokens: TOKENS }
    );

    epoch.bumpAuthEpoch();
    store.clearRemoteMcpOAuth();
    answer();
    await write;

    expect(await store.readRemoteMcpOAuth(SERVER.id, SERVER.url)).toBeUndefined();
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  it('drops a write made for the account before a sign-out', async () => {
    const { store, epoch } = await fresh();
    heldDiskRead(null)();
    const before = epoch.currentAuthEpoch();
    epoch.bumpAuthEpoch();
    store.clearRemoteMcpOAuth();

    await store.writeRemoteMcpOAuth({ ...SERVER, epoch: before }, { tokens: TOKENS });

    expect(await store.readRemoteMcpOAuth(SERVER.id, SERVER.url)).toBeUndefined();
  });
});

describe('matching a remote MCP server OAuth state to its endpoint', () => {
  it('reads the state an older spelling of one endpoint saved', async () => {
    const { store } = await fresh();
    heldDiskRead(JSON.stringify({ demo: { url: 'https://demo.example/', tokens: TOKENS } }))();

    expect(await store.readRemoteMcpOAuth('demo', 'https://demo.example')).toEqual({
      url: 'https://demo.example/',
      tokens: TOKENS,
    });
  });

  it('merges a field into the state an older spelling saved', async () => {
    const { store, epoch } = await fresh();
    heldDiskRead(JSON.stringify({ demo: { url: 'https://demo.example/', tokens: TOKENS } }))();

    await store.writeRemoteMcpOAuth(
      { id: 'demo', url: 'https://demo.example', epoch: epoch.currentAuthEpoch() },
      { client: CLIENT }
    );

    expect(await store.readRemoteMcpOAuth('demo', 'https://demo.example')).toEqual({
      url: 'https://demo.example',
      tokens: TOKENS,
      client: CLIENT,
    });
  });

  it('reads nothing for a state saved for another endpoint', async () => {
    const { store } = await fresh();
    heldDiskRead(JSON.stringify({ demo: { url: 'https://demo.example/', tokens: TOKENS } }))();

    expect(await store.readRemoteMcpOAuth('demo', 'https://other.example')).toBeUndefined();
  });
});
