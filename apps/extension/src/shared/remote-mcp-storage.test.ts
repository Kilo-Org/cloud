/* eslint-disable max-lines */
import { describe, expect, it } from 'vitest';
import {
  REMOTE_MCP_STORAGE_KEY,
  loadRemoteMcpStore,
  normalizeRemoteMcpStore,
  saveRemoteMcpStore,
  updateRemoteMcpStore,
  upsertRemoteMcpServer,
} from './remote-mcp-storage';
import { normalizeRemoteMcpUrl } from './remote-mcp-url';
import type { RemoteMcpStore } from './remote-mcp';
import type { RemoteMcpStorageArea } from './remote-mcp-storage';

const createStorage = (initialValue?: unknown): RemoteMcpStorageArea & { value: unknown } => {
  let storedValue = initialValue;

  return {
    getItem: key => {
      expect(key).toBe(REMOTE_MCP_STORAGE_KEY);
      return storedValue;
    },
    setItem: (key, value) => {
      expect(key).toBe(REMOTE_MCP_STORAGE_KEY);
      storedValue = value;
    },
    get value() {
      return storedValue;
    },
  };
};

const savedServer = {
  allowInSafeMode: false,
  auth: { token: 'token-1', type: 'bearer' } as const,
  cachedTools: [{ description: 'Tool', inputSchema: { type: 'object' }, name: 'tool' }],
  displayName: 'Remote MCP',
  enabled: true,
  id: 'server-1',
  lastConnectedAt: '2026-06-30T12:00:00.000Z',
  lastError: 'old error',
  slug: 'remote-mcp',
  status: 'connected',
  url: 'https://remote.example/mcp',
} satisfies RemoteMcpStore['servers'][number];

describe('remote MCP URL policy', () => {
  it('normalizes accepted URLs and rejects non-local HTTP URLs', () => {
    expect(normalizeRemoteMcpUrl(' https://remote.example/mcp/ ')).toBe(
      'https://remote.example/mcp'
    );
    expect(normalizeRemoteMcpUrl('http://localhost:8787/mcp')).toBe('http://localhost:8787/mcp');
    expect(normalizeRemoteMcpUrl('http://127.0.0.1:8787/mcp')).toBe('http://127.0.0.1:8787/mcp');
    expect(() => normalizeRemoteMcpUrl('http://remote.example/mcp')).toThrow(
      'Remote MCP URL must use HTTPS unless it points to localhost.'
    );
  });

  it('rejects URL credentials and fragments', () => {
    expect(() => normalizeRemoteMcpUrl('https://token@remote.example/mcp')).toThrow(
      'Remote MCP URL must not include credentials.'
    );
    expect(() => normalizeRemoteMcpUrl('https://remote.example/mcp#tools')).toThrow(
      'Remote MCP URL must not include a fragment.'
    );
    expect(() => normalizeRemoteMcpUrl('https://remote.example/mcp#')).toThrow(
      'Remote MCP URL must not include a fragment.'
    );
    expect(() => normalizeRemoteMcpUrl('https://remote.example/mcp?base=/#')).toThrow(
      'Remote MCP URL must not include a fragment.'
    );
  });

  it('preserves query strings while normalizing path trailing slashes', () => {
    expect(normalizeRemoteMcpUrl('https://remote.example/mcp/?base=/')).toBe(
      'https://remote.example/mcp?base=/'
    );
    expect(normalizeRemoteMcpUrl('https://REMOTE.example:443/mcp/')).toBe(
      'https://REMOTE.example:443/mcp'
    );
  });
});

describe('remote MCP storage', () => {
  it('returns an empty store for missing and malformed storage', async () => {
    await expect(loadRemoteMcpStore(createStorage())).resolves.toStrictEqual({ servers: [] });
    expect(normalizeRemoteMcpStore({ servers: [{ ...savedServer, id: '' }] })).toStrictEqual({
      servers: [],
    });
    expect(
      normalizeRemoteMcpStore({
        servers: [
          { ...savedServer, id: 'invalid-url', url: 'http://remote.example/mcp' },
          { ...savedServer, id: 'normalized-url', url: 'https://remote.example/mcp/' },
        ],
      })
    ).toStrictEqual({
      servers: [{ ...savedServer, id: 'normalized-url', url: 'https://remote.example/mcp' }],
    });
    expect(normalizeRemoteMcpStore({ wrong: true })).toStrictEqual({ servers: [] });
  });

  it('keeps the first server when persisted normalized URLs collide', () => {
    expect(
      normalizeRemoteMcpStore({
        servers: [
          { ...savedServer, id: 'first', url: 'https://remote.example/mcp/' },
          { ...savedServer, id: 'second', url: 'https://remote.example/mcp' },
          { ...savedServer, id: 'third', url: 'https://other.example/mcp' },
        ],
      })
    ).toStrictEqual({
      servers: [
        { ...savedServer, id: 'first', url: 'https://remote.example/mcp' },
        { ...savedServer, id: 'third', url: 'https://other.example/mcp' },
      ],
    });
  });

  it('strips unknown persisted fields instead of dropping otherwise valid entries', () => {
    expect(
      normalizeRemoteMcpStore({
        futureStoreField: true,
        servers: [
          {
            ...savedServer,
            auth: { futureAuthField: true, token: 'token-1', type: 'bearer' },
            cachedTools: [
              {
                description: 'Tool',
                futureToolField: true,
                inputSchema: { type: 'object' },
                name: 'tool',
              },
            ],
            futureServerField: true,
          },
        ],
      })
    ).toStrictEqual({ servers: [savedServer] });
  });

  it('round-trips persisted oauth tokens, client info, and code verifier', () => {
    const oauthServer = {
      ...savedServer,
      auth: {
        oauth: {
          clientInformation: { client_id: 'client-abc' },
          codeVerifier: 'verifier-xyz',
          tokens: { access_token: 'access-123', token_type: 'Bearer' },
        },
        type: 'oauth',
      } as const,
    };

    expect(normalizeRemoteMcpStore({ servers: [oauthServer] })).toStrictEqual({
      servers: [oauthServer],
    });
  });

  it('drops malformed oauth state to no-oauth instead of throwing', () => {
    const result = normalizeRemoteMcpStore({
      servers: [
        {
          ...savedServer,
          auth: { oauth: { tokens: { token_type: 'Bearer' } }, type: 'oauth' },
        },
      ],
    });

    expect(result.servers).toStrictEqual([{ ...savedServer, auth: { type: 'oauth' } }]);
  });

  it('loads and saves through the sign-out-covered local storage key', async () => {
    const storage = createStorage({ servers: [savedServer] });

    await expect(loadRemoteMcpStore(storage)).resolves.toStrictEqual({ servers: [savedServer] });
    await saveRemoteMcpStore(storage, { servers: [] });

    expect(storage.value).toStrictEqual({ servers: [] });
  });

  it('rejects duplicate normalized URLs', () => {
    const store = upsertRemoteMcpServer(
      { servers: [] },
      {
        allowInSafeMode: false,
        auth: { type: 'none' },
        displayName: 'First',
        enabled: true,
        url: 'https://remote.example/mcp/',
      }
    );

    expect(() =>
      upsertRemoteMcpServer(store, {
        allowInSafeMode: false,
        auth: { type: 'none' },
        displayName: 'Second',
        enabled: true,
        url: 'https://remote.example/mcp',
      })
    ).toThrow('Remote MCP URL is already saved.');
  });

  it('uniquifies slugs for same-named servers', () => {
    const store = upsertRemoteMcpServer(
      { servers: [] },
      {
        allowInSafeMode: false,
        auth: { type: 'none' },
        displayName: 'GitHub',
        enabled: true,
        url: 'https://a.example/mcp',
      }
    );
    const next = upsertRemoteMcpServer(store, {
      allowInSafeMode: false,
      auth: { type: 'none' },
      displayName: 'GitHub',
      enabled: true,
      url: 'https://b.example/mcp',
    });

    expect(next.servers.map(server => server.slug)).toStrictEqual(['github', 'github-2']);
  });

  it('clears connection state when URL changes', () => {
    expect(
      upsertRemoteMcpServer(
        { servers: [savedServer] },
        { ...savedServer, url: 'https://other.example/mcp' }
      )
    ).toStrictEqual({
      servers: [
        {
          ...savedServer,
          auth: { token: 'token-1', type: 'bearer' },
          cachedTools: [],
          lastConnectedAt: undefined,
          lastError: undefined,
          status: 'untested',
          url: 'https://other.example/mcp',
        },
      ],
    });
  });

  it('clears connection state when auth type changes', () => {
    expect(
      upsertRemoteMcpServer(
        { servers: [savedServer] },
        { ...savedServer, auth: { headerName: 'X-Token', headerValue: 'secret', type: 'header' } }
      )
    ).toStrictEqual({
      servers: [
        {
          ...savedServer,
          auth: { headerName: 'X-Token', headerValue: 'secret', type: 'header' },
          cachedTools: [],
          lastConnectedAt: undefined,
          lastError: undefined,
          status: 'untested',
        },
      ],
    });
  });

  it('clears connection state when same-type auth changes', () => {
    expect(
      upsertRemoteMcpServer(
        { servers: [savedServer] },
        { ...savedServer, auth: { token: 'token-2', type: 'bearer' } }
      )
    ).toStrictEqual({
      servers: [
        {
          ...savedServer,
          auth: { token: 'token-2', type: 'bearer' },
          cachedTools: [],
          lastConnectedAt: undefined,
          lastError: undefined,
          status: 'untested',
        },
      ],
    });
  });

  it('keeps credentials and cached tools when disabling a server', () => {
    expect(
      upsertRemoteMcpServer({ servers: [savedServer] }, { ...savedServer, enabled: false })
    ).toStrictEqual({
      servers: [{ ...savedServer, enabled: false }],
    });
  });

  it('preserves cachedTools and status when only oauth tokens rotate', () => {
    const oauthServer = {
      ...savedServer,
      auth: {
        oauth: {
          clientInformation: { client_id: 'client-abc' },
          tokens: { access_token: 'old-token', token_type: 'Bearer' },
        },
        type: 'oauth',
      } as const,
    };

    const result = upsertRemoteMcpServer(
      { servers: [oauthServer] },
      {
        ...oauthServer,
        auth: {
          oauth: {
            clientInformation: { client_id: 'client-abc' },
            tokens: { access_token: 'new-token', token_type: 'Bearer' },
          },
          type: 'oauth',
        },
      }
    );

    expect(result.servers[0]?.status).toBe('connected');
    expect(result.servers[0]?.cachedTools).toStrictEqual(oauthServer.cachedTools);
  });

  it('clears connection state when oauth auth type changes to bearer', () => {
    const oauthServer = {
      ...savedServer,
      auth: { type: 'oauth' } as const,
    };

    const result = upsertRemoteMcpServer(
      { servers: [oauthServer] },
      { ...oauthServer, auth: { token: 'tok', type: 'bearer' } }
    );

    expect(result.servers[0]?.status).toBe('untested');
    expect(result.servers[0]?.cachedTools).toStrictEqual([]);
  });
});

describe('serialized store updates', () => {
  /* Resolving a controlled storage promise only queues continuations; run those
     microtasks until the observable state is reached. No wall-clock waiting. */
  const drainUntil = async (condition: () => boolean): Promise<void> => {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      if (condition()) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop -- one microtask hop per attempt
      await Promise.resolve();
    }
    throw new Error('storage continuations never reached the expected state');
  };

  it('keeps both overlapping updates when a second starts mid-flight', async () => {
    const loads: PromiseWithResolvers<unknown>[] = [];
    const saves: (PromiseWithResolvers<void> & { value: RemoteMcpStore })[] = [];
    let storedValue: unknown = { servers: [] };

    const storage: RemoteMcpStorageArea = {
      getItem: () => {
        const load = Promise.withResolvers<unknown>();
        loads.push(load);
        return load.promise;
      },
      setItem: async (_key, value) => {
        const save = Promise.withResolvers<void>();
        saves.push({ ...save, value });
        await save.promise;
        storedValue = value;
      },
    };

    const first = updateRemoteMcpStore(storage, store => {
      const nextStore: RemoteMcpStore = {
        servers: [
          ...store.servers,
          { ...savedServer, id: 'server-a', slug: 'server-a', url: 'https://server-a.example/mcp' },
        ],
      };
      return { result: nextStore, store: nextStore };
    });
    /* The second call arrives while the first one is still loading. */
    const second = updateRemoteMcpStore(storage, store => {
      const nextStore: RemoteMcpStore = {
        servers: [
          ...store.servers,
          { ...savedServer, id: 'server-b', slug: 'server-b', url: 'https://server-b.example/mcp' },
        ],
      };
      return { result: nextStore, store: nextStore };
    });

    expect(loads).toHaveLength(1);

    loads[0]?.resolve({ servers: [] });
    await drainUntil(() => saves.length === 1);
    expect(loads).toHaveLength(1);

    saves[0]?.resolve();
    await drainUntil(() => loads.length === 2);

    /* The second update loads the store the first one just saved. */
    loads[1]?.resolve(storedValue);
    await drainUntil(() => saves.length === 2);
    expect(saves[1]?.value.servers.map(server => server.id)).toStrictEqual([
      'server-a',
      'server-b',
    ]);

    saves[1]?.resolve();
    await Promise.all([first, second]);

    expect(normalizeRemoteMcpStore(storedValue).servers.map(server => server.id)).toStrictEqual([
      'server-a',
      'server-b',
    ]);
  });
});
