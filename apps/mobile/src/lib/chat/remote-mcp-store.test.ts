import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as RemoteMcpStoreModule from './remote-mcp-store';
import {
  addRemoteMcpServer,
  clearRemoteMcpServers,
  deleteRemoteMcpServer,
  listRemoteMcpServers,
  parseRemoteMcpServers,
  setRemoteMcpServerEnabled,
  updateRemoteMcpServer,
} from './remote-mcp-store';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

// The store is a module-level singleton that latches its one disk read, so a
// fresh module graph gives a truly cold store whose preload-then-read can be
// exercised end to end.
async function freshStore(): Promise<typeof RemoteMcpStoreModule> {
  vi.resetModules();
  const mod = import('./remote-mcp-store');
  await Promise.resolve();
  return mod;
}

/** A complete draft, so each test names only the field it is about. */
function draft(
  fields: Pick<Parameters<typeof addRemoteMcpServer>[0], 'name' | 'url'> &
    Partial<Parameters<typeof addRemoteMcpServer>[0]>
): Parameters<typeof addRemoteMcpServer>[0] {
  return { auth: { type: 'none' }, enabled: true, ...fields };
}

beforeEach(() => {
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  captureException.mockReset();
  toastError.mockReset();
  clearRemoteMcpServers();
});

describe('parseRemoteMcpServers', () => {
  it('returns an empty list for null and malformed JSON', () => {
    expect(parseRemoteMcpServers(null)).toEqual([]);
    expect(parseRemoteMcpServers('not json')).toEqual([]);
    expect(parseRemoteMcpServers('{"not":"an array"}')).toEqual([]);
  });

  it('drops an entry whose id is not callable-name safe', () => {
    expect(
      parseRemoteMcpServers(
        JSON.stringify([
          {
            id: 'has space',
            name: 'Bad',
            url: 'https://bad.example/mcp',
            auth: { type: 'none' },
            enabled: true,
          },
        ])
      )
    ).toEqual([]);
  });

  it('normalizes a stored URL and keeps a valid server', () => {
    expect(
      parseRemoteMcpServers(
        JSON.stringify([
          {
            id: 'alpha',
            name: 'Alpha',
            url: 'https://alpha.example/mcp/',
            auth: { type: 'bearer', token: 'secret' },
            enabled: false,
          },
        ])
      )
    ).toEqual([
      {
        id: 'alpha',
        name: 'Alpha',
        url: 'https://alpha.example/mcp',
        auth: { type: 'bearer', token: 'secret' },
        enabled: false,
      },
    ]);
  });
});

describe('remote MCP server store', () => {
  it('adds a server and lists it', () => {
    const server = addRemoteMcpServer(draft({ name: 'GitHub', url: 'https://github.example/mcp' }));

    expect(server.id).toBe('github');
    expect(listRemoteMcpServers()).toEqual([server]);
  });

  it('refuses a duplicate URL after normalization', () => {
    addRemoteMcpServer(draft({ name: 'First', url: 'https://remote.example/mcp/' }));

    expect(() =>
      addRemoteMcpServer(draft({ name: 'Second', url: 'https://remote.example/mcp' }))
    ).toThrow('Remote MCP URL is already saved.');
    expect(listRemoteMcpServers()).toHaveLength(1);
  });

  it('uniquifies ids for two servers with the same name', () => {
    const first = addRemoteMcpServer(draft({ name: 'GitHub', url: 'https://a.example/mcp' }));
    const second = addRemoteMcpServer(draft({ name: 'GitHub', url: 'https://b.example/mcp' }));

    expect(first.id).toBe('github');
    expect(second.id).toBe('github-2');
    expect(listRemoteMcpServers().map(server => server.id)).toEqual(['github', 'github-2']);
  });

  it('edits a server in place and keeps its id and position', () => {
    const first = addRemoteMcpServer(draft({ name: 'Alpha', url: 'https://a.example/mcp' }));
    const second = addRemoteMcpServer(draft({ name: 'Beta', url: 'https://b.example/mcp' }));

    const updated = updateRemoteMcpServer(first.id, { name: 'Alpha Two', enabled: false });

    const servers = listRemoteMcpServers();
    expect(servers.map(server => server.id)).toEqual([first.id, second.id]);
    expect(servers[0]).toEqual(updated);
    expect(servers[0]?.name).toBe('Alpha Two');
    expect(servers[0]?.url).toBe('https://a.example/mcp');
    expect(servers[1]).toEqual(second);
  });

  it('deletes one server and keeps the rest', () => {
    const first = addRemoteMcpServer(draft({ name: 'Alpha', url: 'https://a.example/mcp' }));
    const second = addRemoteMcpServer(draft({ name: 'Beta', url: 'https://b.example/mcp' }));

    const removed = deleteRemoteMcpServer(first.id);

    expect(removed).toEqual(first);
    expect(listRemoteMcpServers()).toEqual([second]);
  });

  it('flips only the named server when enabling or disabling', () => {
    const first = addRemoteMcpServer(draft({ name: 'Alpha', url: 'https://a.example/mcp' }));
    const second = addRemoteMcpServer(draft({ name: 'Beta', url: 'https://b.example/mcp' }));

    setRemoteMcpServerEnabled(second.id, false);

    const servers = listRemoteMcpServers();
    expect(servers[0]?.enabled).toBe(true);
    expect(servers[0]?.id).toBe(first.id);
    expect(servers[1]?.enabled).toBe(false);
    expect(servers[1]).toEqual({ ...second, enabled: false });
  });

  it('starts empty when the persisted value is malformed', async () => {
    getItemAsync.mockResolvedValue('{not json');
    const mod = await freshStore();

    await flushMicrotasks();

    expect(mod.listRemoteMcpServers()).toEqual([]);
  });

  it('loads a persisted list', async () => {
    const stored = {
      id: 'alpha',
      name: 'Alpha',
      url: 'https://alpha.example/mcp',
      auth: { type: 'none' },
      enabled: true,
    };
    getItemAsync.mockResolvedValue(JSON.stringify([stored]));
    const mod = await freshStore();

    await flushMicrotasks();

    expect(mod.listRemoteMcpServers()).toEqual([stored]);
  });

  it('unions a write with the persisted list when it races the cold read', async () => {
    const read = Promise.withResolvers<string | null>();
    getItemAsync.mockImplementation(
      // eslint-disable-next-line typescript-eslint/promise-function-async -- the read must stay pending until the test releases it
      () => read.promise
    );
    const mod = await freshStore();

    mod.addRemoteMcpServer(draft({ name: 'New', url: 'https://new.example/mcp' }));

    read.resolve(
      JSON.stringify([
        {
          id: 'existing',
          name: 'Existing',
          url: 'https://existing.example/mcp',
          auth: { type: 'none' },
          enabled: true,
        },
      ])
    );
    await flushMicrotasks();

    expect(mod.listRemoteMcpServers().map(server => server.id)).toEqual(['existing', 'new']);
  });
});
