import { afterEach, describe, expect, it } from 'bun:test';
import { createServer as createNetServer } from 'node:net';
import { WrapperState } from './state';
import {
  bindSessionContext,
  createFetchHandler,
  createServer,
  resolvePtyClientClose,
  type WrapperServer,
} from './server';
import type { WrapperKiloClient, WrapperPty, WrapperPtySize } from './kilo-api';

type PtyCall = {
  cwd: string;
  title: string;
  env: Record<string, string>;
};

const servers: WrapperServer[] = [];

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
          return;
        }
        reject(new Error('Failed to allocate test port'));
      });
    });
  });
}

function createTestFetch(overrides?: {
  ptyCalls?: PtyCall[];
  resizeCalls?: Array<{ ptyId: string; cols: number; rows: number }>;
  deleteCalls?: string[];
  runtimeEnvironmentUpdates?: Array<Record<string, string>>;
  resizeError?: Error;
}) {
  const ptyCalls = overrides?.ptyCalls ?? [];
  const resizeCalls = overrides?.resizeCalls ?? [];
  const deleteCalls = overrides?.deleteCalls ?? [];
  const runtimeEnvironmentUpdates = overrides?.runtimeEnvironmentUpdates ?? [];

  const pty: WrapperPty = {
    id: 'pty_123',
    title: 'Workspace terminal',
    command: '',
    args: [],
    cwd: '/workspace/repo',
    status: 'running',
    pid: 123,
  };

  const kiloClient = {
    createPty: async (input: { cwd: string; title: string; env: Record<string, string> }) => {
      ptyCalls.push({ cwd: input.cwd, title: input.title, env: input.env });
      return { ...pty, cwd: input.cwd, title: input.title };
    },
    resizePty: async (ptyId: string, size: WrapperPtySize) => {
      resizeCalls.push({ ptyId, cols: size.cols, rows: size.rows });
      if (overrides?.resizeError) throw overrides.resizeError;
      return pty;
    },
    deletePty: async (ptyId: string) => {
      deleteCalls.push(ptyId);
      return true;
    },
  } as unknown as WrapperKiloClient;

  const fetchHandler = createFetchHandler(
    {
      port: 5000,
      workspacePath: '/workspace/repo',
      version: 'test',
      sessionId: 'kilo_sess_test',
      agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
      userId: 'user_test',
      wrapperInstanceId: 'instance_test',
      wrapperInstanceGeneration: 8,
    },
    {
      state: new WrapperState(),
      kiloClient,
      openConnection: async () => {},
      closeConnection: async () => {},
      setAborted: () => {},
      resetLifecycle: () => {},
      setPerTurnConfig: () => {},
      updateRuntimeEnvironment: async env => {
        runtimeEnvironmentUpdates.push(env);
      },
    },
    () => {}
  );
  return { fetchHandler, ptyCalls, resizeCalls, deleteCalls, runtimeEnvironmentUpdates };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
});

describe('wrapper health', () => {
  it('reports leased physical wrapper identity separately from session identity', async () => {
    const { fetchHandler } = createTestFetch();
    const response = await fetchHandler(new Request('http://wrapper.test/health'));
    if (!response) throw new Error('Expected health response');

    const body = await response.json();
    expect(body).toMatchObject({
      sessionId: 'kilo_sess_test',
      wrapperInstanceId: 'instance_test',
      wrapperInstanceGeneration: 8,
    });
  });
});

describe('wrapper PTY routes', () => {
  it('creates a workspace PTY and applies the requested size', async () => {
    const { fetchHandler, ptyCalls, resizeCalls } = createTestFetch();

    const response = await fetchHandler(
      new Request('http://wrapper.test/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 120, rows: 32 }),
      })
    );

    expect(response).toBeDefined();
    if (!response) throw new Error('Expected PTY create response');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id: 'pty_123',
      cwd: '/workspace/repo',
      title: 'Workspace terminal',
    });
    expect(ptyCalls).toEqual([
      {
        cwd: '/workspace/repo',
        title: 'Workspace terminal',
        env: {
          PROMPT_COMMAND: "PS1='\\n\\W\\n\\$ '",
          PS1: '\\n\\W\\n\\$ ',
        },
      },
    ]);
    expect(resizeCalls).toEqual([{ ptyId: 'pty_123', cols: 120, rows: 32 }]);
  });

  it('deletes the PTY when applying the initial size fails', async () => {
    const { fetchHandler, deleteCalls, resizeCalls } = createTestFetch({
      resizeError: new Error('resize failed'),
    });

    const response = await fetchHandler(
      new Request('http://wrapper.test/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 120, rows: 32 }),
      })
    );

    expect(response).toBeDefined();
    if (!response) throw new Error('Expected PTY create response');
    expect(response.status).toBe(500);
    expect(resizeCalls).toEqual([{ ptyId: 'pty_123', cols: 120, rows: 32 }]);
    expect(deleteCalls).toEqual(['pty_123']);
  });

  it('upgrades PTY websocket connections and proxies to the SDK PTY endpoint', async () => {
    const upstreamPort = await getFreePort();
    const wrapperPort = await getFreePort();
    let upstreamPath: string | undefined;
    const upstream = Bun.serve<{ pty: true }>({
      port: upstreamPort,
      fetch(req, server) {
        upstreamPath = new URL(req.url).pathname + new URL(req.url).search;
        if (server.upgrade(req, { data: { pty: true } })) return undefined;
        return new Response('upgrade failed', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send('ready');
        },
        message(ws, message) {
          ws.send(message);
        },
      },
    });

    const kiloClient = {
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
    } as unknown as WrapperKiloClient;

    const wrapper = createServer(
      {
        port: wrapperPort,
        workspacePath: '/workspace/repo',
        version: 'test',
        sessionId: 'kilo_sess_test',
        agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
        userId: 'user_test',
      },
      {
        state: new WrapperState(),
        kiloClient,
        openConnection: async () => {},
        closeConnection: async () => {},
        setAborted: () => {},
        resetLifecycle: () => {},
        setPerTurnConfig: () => {},
      },
      () => {}
    );

    try {
      const message = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('wrapper websocket timed out')), 1_000);
        const ws = new WebSocket(`ws://127.0.0.1:${wrapperPort}/pty/pty_123/connect`);
        ws.addEventListener('message', event => {
          clearTimeout(timeout);
          ws.close();
          resolve(String(event.data));
        });
        ws.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('wrapper websocket failed'));
        });
      });

      expect(message).toBe('ready');
      expect(upstreamPath).toBe('/pty/pty_123/connect?directory=%2Fworkspace%2Frepo');
    } finally {
      await wrapper.server.stop(true);
      await upstream.stop(true);
    }
  });

  it('preserves abnormal upstream PTY websocket close codes', () => {
    expect(resolvePtyClientClose({ code: 1011, reason: 'container restarting' })).toEqual({
      code: 1011,
      reason: 'container restarting',
    });
    expect(resolvePtyClientClose({ code: 1006, reason: '' })).toEqual({
      code: 1011,
      reason: 'PTY upstream closed',
    });
    expect(resolvePtyClientClose({ code: 1000, reason: '' })).toEqual({
      code: 1000,
      reason: 'PTY session ended',
    });
  });
});

describe('wrapper runtime environment', () => {
  it('delegates environment updates to the active runtime updater', async () => {
    const runtimeEnvironmentUpdates: Array<Record<string, string>> = [];
    const { fetchHandler } = createTestFetch({ runtimeEnvironmentUpdates });

    const response = await fetchHandler(
      new Request('http://wrapper.test/session/environment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: { GH_TOKEN: 'next-token' } }),
      })
    );

    expect(response).toBeDefined();
    if (!response) throw new Error('Expected runtime environment response');
    expect(response.status).toBe(200);
    expect(runtimeEnvironmentUpdates).toEqual([{ GH_TOKEN: 'next-token' }]);
  });
});

describe('wrapper Kilo proxy route', () => {
  it('requests an identity response from private Kilo even when the client accepts gzip', async () => {
    const upstreamPort = await getFreePort();
    const wrapperPort = await getFreePort();
    const upstreamAcceptEncodings: Array<string | null> = [];
    const upstream = Bun.serve({
      port: upstreamPort,
      fetch(req) {
        upstreamAcceptEncodings.push(req.headers.get('accept-encoding'));
        return new Response('proxied');
      },
    });
    const kiloClient = {
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
    } as unknown as WrapperKiloClient;
    const wrapper = createServer(
      {
        port: wrapperPort,
        workspacePath: '/workspace/repo',
        version: 'test',
        sessionId: 'kilo_sess_test',
        agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
        userId: 'user_test',
      },
      {
        state: new WrapperState(),
        kiloClient,
        openConnection: async () => {},
        closeConnection: async () => {},
        setAborted: () => {},
        resetLifecycle: () => {},
      },
      () => {}
    );

    try {
      const response = await fetch(`http://127.0.0.1:${wrapperPort}/kilo-proxy/session/ses_123`, {
        headers: { 'Accept-Encoding': 'gzip' },
      });

      expect(response.status).toBe(200);
      expect(upstreamAcceptEncodings).toEqual(['identity']);
    } finally {
      await wrapper.server.stop(true);
      await upstream.stop(true);
    }
  });
});

describe('wrapper session binding', () => {
  it('keeps bootstrap rebindings close-only until runtime readiness is verified', async () => {
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_test',
      ingestUrl: 'ws://worker.test/ingest',
      workerAuthToken: 'worker-token',
      wrapperRunId: 'run_1',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_1',
      agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
    });
    state.setConnections({ readyState: WebSocket.OPEN } as WebSocket, new AbortController());

    const closeOrder: string[] = [];
    const response = await bindSessionContext(
      {
        ingestUrl: 'ws://worker.test/ingest',
        workerAuthToken: 'worker-token',
        wrapperRunId: 'run_2',
        wrapperGeneration: 2,
        wrapperConnectionId: 'conn_2',
      },
      {
        port: 5000,
        workspacePath: '/workspace/repo',
        version: 'test',
        sessionId: 'kilo_sess_test',
        agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
        userId: 'user_test',
      },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        openConnection: async () => {},
        closeConnection: async () => {
          closeOrder.push('ingest');
        },
        setAborted: () => {},
        resetLifecycle: () => {},
        onSessionBound: feedPolicy => {
          closeOrder.push(feedPolicy);
        },
      },
      'close-until-runtime-ready'
    );

    expect(response).toBeNull();
    expect(closeOrder).toEqual(['close-until-runtime-ready', 'ingest']);
  });

  it('closes the bootstrap feed for an unchanged binding until runtime readiness is verified', async () => {
    const state = new WrapperState();
    const sessionBinding = {
      kiloSessionId: 'kilo_sess_test',
      ingestUrl: 'ws://worker.test/ingest',
      workerAuthToken: 'worker-token',
      wrapperRunId: 'run_1',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_1',
      agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
    };
    state.bindSession(sessionBinding);

    const feedPolicies: string[] = [];
    let closeConnectionCalls = 0;
    let resetLifecycleCalls = 0;
    const response = await bindSessionContext(
      sessionBinding,
      {
        port: 5000,
        workspacePath: '/workspace/repo',
        version: 'test',
        sessionId: 'kilo_sess_test',
        agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
        userId: 'user_test',
      },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        openConnection: async () => {},
        closeConnection: async () => {
          closeConnectionCalls += 1;
        },
        setAborted: () => {},
        resetLifecycle: () => {
          resetLifecycleCalls += 1;
        },
        onSessionBound: feedPolicy => {
          feedPolicies.push(feedPolicy);
        },
      },
      'close-until-runtime-ready'
    );

    expect(response).toBeNull();
    expect(feedPolicies).toEqual(['close-until-runtime-ready']);
    expect(closeConnectionCalls).toBe(0);
    expect(resetLifecycleCalls).toBe(0);
  });

  it('keeps restart behavior for legacy direct rebindings', async () => {
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_test',
      ingestUrl: 'ws://worker.test/ingest',
      workerAuthToken: 'worker-token',
      wrapperRunId: 'run_1',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_1',
      agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
    });

    const feedPolicies: string[] = [];
    const response = await bindSessionContext(
      {
        ingestUrl: 'ws://worker.test/ingest',
        workerAuthToken: 'worker-token',
        wrapperRunId: 'run_2',
        wrapperGeneration: 2,
        wrapperConnectionId: 'conn_2',
      },
      {
        port: 5000,
        workspacePath: '/workspace/repo',
        version: 'test',
        sessionId: 'kilo_sess_test',
        agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
        userId: 'user_test',
      },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        openConnection: async () => {},
        closeConnection: async () => {},
        setAborted: () => {},
        resetLifecycle: () => {},
        onSessionBound: feedPolicy => {
          feedPolicies.push(feedPolicy);
        },
      }
    );

    expect(response).toBeNull();
    expect(feedPolicies).toEqual(['restart']);
  });

  it('resets lifecycle state when warm rebinding an existing connected session', async () => {
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_test',
      ingestUrl: 'ws://worker.test/ingest',
      workerAuthToken: 'worker-token',
      wrapperRunId: 'run_1',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_1',
      agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
    });
    state.setConnections({ readyState: WebSocket.OPEN } as WebSocket, new AbortController());

    let closeConnectionCalls = 0;
    let resetLifecycleCalls = 0;
    const response = await bindSessionContext(
      {
        ingestUrl: 'ws://worker.test/ingest',
        workerAuthToken: 'worker-token',
        wrapperRunId: 'run_2',
        wrapperGeneration: 2,
        wrapperConnectionId: 'conn_2',
      },
      {
        port: 5000,
        workspacePath: '/workspace/repo',
        version: 'test',
        sessionId: 'kilo_sess_test',
        agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
        userId: 'user_test',
      },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        openConnection: async () => {},
        closeConnection: async () => {
          closeConnectionCalls += 1;
          state.clearConnectionRefs();
        },
        setAborted: () => {},
        resetLifecycle: () => {
          resetLifecycleCalls += 1;
        },
      }
    );

    expect(response).toBeNull();
    expect(closeConnectionCalls).toBe(1);
    expect(resetLifecycleCalls).toBe(1);
  });
});
