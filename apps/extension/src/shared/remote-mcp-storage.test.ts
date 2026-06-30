import { describe, expect, it } from 'vitest';
import {
  REMOTE_MCP_STORAGE_KEY,
  loadRemoteMcpStore,
  normalizeRemoteMcpStore,
  saveRemoteMcpStore,
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
          auth: { type: 'bearer' },
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
          auth: { headerName: 'X-Token', type: 'header' },
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
});
