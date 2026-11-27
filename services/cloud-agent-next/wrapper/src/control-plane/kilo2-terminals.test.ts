import { afterEach, describe, expect, it } from 'bun:test';
import { createKilo2Api } from './kilo2-api.js';
import { createKilo2Terminals } from './kilo2-terminals.js';

const directory = '/workspace/terminals';
const sessionId = 'ses_terminal';
const authorization = 'Basic terminals-test';

type Recorded = { method: string; path: string; search: string; body: unknown };

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
});

function info(id: string, status: 'running' | 'exited' = 'running') {
  return {
    id,
    title: 'Workspace terminal',
    command: '/bin/bash',
    args: [],
    cwd: directory,
    status,
    pid: 41,
    sessionID: sessionId,
    userTitle: null,
    foregroundProcess: null,
    size: { cols: 100, rows: 30 },
    output: { head: 0, tail: 1234 },
  };
}

function startKilo(state: {
  ptys: Map<string, 'running' | 'exited'>;
  listedPtys?: string[];
  beforePtyRead?: () => Promise<void>;
}) {
  const requests: Recorded[] = [];
  const upgrades: { search: URLSearchParams; authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request, instance) {
      const url = new URL(request.url);
      if (request.headers.get('authorization') !== authorization)
        return new Response('unauthorized', { status: 401 });
      if (url.pathname.endsWith('/connect')) {
        upgrades.push({
          search: url.searchParams,
          authorization: request.headers.get('authorization'),
        });
        return instance.upgrade(request, { data: undefined })
          ? undefined
          : new Response('upgrade failed', { status: 400 });
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        body: request.body ? await request.json() : undefined,
      });
      const persistent = /^\/api\/experimental\/persistent-pty\/([^/]+)(\/snapshot)?$/.exec(
        url.pathname
      );
      if (url.pathname === `/api/experimental/session/${sessionId}/terminal`) {
        if (request.method === 'POST') {
          const id = `pty_persistent_${state.ptys.size + 1}`;
          state.ptys.set(id, 'running');
          return Response.json({ data: info(id) });
        }
        return Response.json({
          data: (state.listedPtys ?? [...state.ptys.keys()]).map(id => info(id)),
        });
      }
      if (persistent) {
        const id = decodeURIComponent(persistent[1] ?? '');
        const status = state.ptys.get(id);
        if (!status) return new Response('missing', { status: 404 });
        if (persistent[2])
          return Response.json({
            data: {
              info: info(id, status),
              text: '',
              checkpoint: 'c2NyZWVu',
              cursor: { x: 0, y: 0 },
            },
          });
        if (request.method === 'DELETE') {
          state.ptys.delete(id);
          return new Response(null, { status: 204 });
        }
        if (request.method === 'GET') await state.beforePtyRead?.();
        return Response.json({ data: info(id, status) });
      }
      return new Response('unexpected route', { status: 500 });
    },
    websocket: { message() {} },
  });
  servers.push(server);
  return { url: server.url.toString(), requests, upgrades };
}

function terminalsFor(url: string, sessions: string[] = [sessionId]) {
  const server = { url, authorization };
  return createKilo2Terminals({
    api: createKilo2Api(server),
    server,
    listSessionIds: async () => sessions,
  });
}

describe('Kilo v2 persistent terminals', () => {
  it('creates, resizes and removes terminals through the persistent PTY API', async () => {
    const state = { ptys: new Map<string, 'running' | 'exited'>() };
    const kilo = startKilo(state);
    const { terminals } = terminalsFor(kilo.url);

    const pty = await terminals.createPty({
      sessionId,
      cwd: directory,
      title: 'Workspace terminal',
      env: { TERM_PROGRAM: 'cloud' },
    });
    expect(pty).toEqual({
      id: 'pty_persistent_1',
      title: 'Workspace terminal',
      command: '/bin/bash',
      args: [],
      cwd: directory,
      status: 'running',
      pid: 41,
    });
    await terminals.resizePty(pty.id, { cols: 120, rows: 40 });
    expect(await terminals.deletePty(pty.id)).toBe(true);
    // A terminal already gone counts as removed.
    expect(await terminals.deletePty(pty.id)).toBe(true);

    expect(kilo.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      {
        method: 'POST',
        path: `/api/experimental/session/${sessionId}/terminal`,
        body: {
          args: [],
          cwd: directory,
          title: 'Workspace terminal',
          env: { TERM_PROGRAM: 'cloud' },
        },
      },
      {
        method: 'PUT',
        path: '/api/experimental/persistent-pty/pty_persistent_1',
        body: { size: { cols: 120, rows: 40 } },
      },
      {
        method: 'DELETE',
        path: '/api/experimental/persistent-pty/pty_persistent_1',
        body: undefined,
      },
      {
        method: 'DELETE',
        path: '/api/experimental/persistent-pty/pty_persistent_1',
        body: undefined,
      },
    ]);
    expect(kilo.requests.some(request => request.path.startsWith('/api/pty'))).toBe(false);
  });

  it('greets each connection with the snapshot and streams from where it ends', async () => {
    const state = { ptys: new Map<string, 'running' | 'exited'>() };
    const kilo = startKilo(state);
    const { terminals } = terminalsFor(kilo.url);
    const pty = await terminals.createPty({ sessionId, cwd: directory, title: 't', env: {} });

    const connection = await terminals.connectPty(pty.id, directory, 'bridge-generation-1');
    await new Promise((resolve, reject) => {
      connection.socket.onopen = resolve;
      connection.socket.onerror = reject;
    });
    connection.socket.close(1000);

    expect(JSON.parse(connection.greeting ?? '')).toEqual({
      type: 'snapshot',
      size: { cols: 100, rows: 30 },
      checkpoint: 'c2NyZWVu',
    });
    const [upgrade] = kilo.upgrades;
    expect(upgrade?.authorization).toBe(authorization);
    expect(Object.fromEntries(upgrade?.search ?? [])).toEqual({
      cursor: '1234',
      attachment_id: 'bridge-generation-1',
      takeover: 'true',
      input_protocol: '1',
    });
  });

  it('reports busy while a created terminal runs in the directory', async () => {
    const state = { ptys: new Map<string, 'running' | 'exited'>() };
    const kilo = startKilo(state);
    const { terminals } = terminalsFor(kilo.url);
    const signal = AbortSignal.timeout(5000);

    expect(await terminals.isIdle(directory, signal)).toBe(true);
    const pty = await terminals.createPty({ sessionId, cwd: directory, title: 't', env: {} });
    expect(await terminals.isIdle(directory, signal)).toBe(false);
    expect(await terminals.isIdle('/workspace/other', signal)).toBe(true);
    state.ptys.set(pty.id, 'exited');
    expect(await terminals.isIdle(directory, signal)).toBe(true);

    const gone = await terminals.createPty({ sessionId, cwd: directory, title: 'gone', env: {} });
    state.ptys.delete(gone.id);
    const beforeProbe = kilo.requests.length;
    expect(await terminals.isIdle(directory, signal)).toBe(true);
    expect(await terminals.isIdle(directory, signal)).toBe(true);
    expect(kilo.requests.slice(beforeProbe).map(({ path }) => path)).toEqual([
      `/api/experimental/persistent-pty/${gone.id}`,
    ]);
  });

  it('checks live terminal statuses concurrently', async () => {
    const bothReadsStarted = Promise.withResolvers<void>();
    let reads = 0;
    const ptys = new Map<string, 'running' | 'exited'>();
    const kilo = startKilo({
      ptys,
      beforePtyRead: async () => {
        if (++reads === 2) bothReadsStarted.resolve();
        await bothReadsStarted.promise;
      },
    });
    const { terminals } = terminalsFor(kilo.url);
    const first = await terminals.createPty({ sessionId, cwd: directory, title: 'a', env: {} });
    await terminals.createPty({ sessionId, cwd: directory, title: 'b', env: {} });
    ptys.set(first.id, 'exited');

    try {
      expect(await terminals.isIdle(directory, AbortSignal.timeout(1000))).toBe(false);
      expect(reads).toBe(2);
    } finally {
      bothReadsStarted.resolve();
    }
  });

  it('closes every session terminal in a directory', async () => {
    const state = { ptys: new Map<string, 'running' | 'exited'>() };
    const kilo = startKilo(state);
    const kilo2 = terminalsFor(kilo.url);
    await kilo2.terminals.createPty({ sessionId, cwd: directory, title: 'a', env: {} });
    await kilo2.terminals.createPty({ sessionId, cwd: directory, title: 'b', env: {} });

    await kilo2.closeDirectory(directory);

    expect(state.ptys.size).toBe(0);
    expect(await kilo2.terminals.isIdle(directory, AbortSignal.timeout(5000))).toBe(true);
  });

  it('continues session cleanup and removes unlisted exited PTYs after a session list fails', async () => {
    const ptys = new Map<string, 'running' | 'exited'>([['pty_untracked', 'running']]);
    const kilo = startKilo({ ptys, listedPtys: ['pty_untracked'] });
    const kilo2 = terminalsFor(kilo.url, ['ses_unavailable', sessionId]);
    const pty = await kilo2.terminals.createPty({ sessionId, cwd: directory, title: 't', env: {} });
    ptys.set(pty.id, 'exited');
    expect(await kilo2.terminals.isIdle(directory, AbortSignal.timeout(5000))).toBe(true);

    await kilo2.closeDirectory(directory);

    expect(ptys.size).toBe(0);
  });
});
