import { afterEach, describe, expect, it } from 'bun:test';
import fsp from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { WrapperState } from './state';
import {
  bindSessionContext,
  createCommandHandler,
  createFetchHandler,
  createPromptHandler,
  createServer,
  createSessionReadyHandler,
  resolvePtyClientClose,
  type ServerDependencies,
  type WrapperServer,
} from './server';
import type { WrapperKiloClient, WrapperPty, WrapperPtySize } from './kilo-api';
import { PNPM_STORE_DIR, PNPM_STORE_ENV_VAR } from '../../src/shared/runtime-environment.js';
import type { WrapperSessionReadyRequest } from '../../src/shared/wrapper-bootstrap.js';

type PtyCall = {
  cwd: string;
  title: string;
  env: Record<string, string>;
};

const servers: WrapperServer[] = [];
const states: WrapperState[] = [];
const originalFetch = globalThis.fetch;
const originalLogPath = process.env.WRAPPER_LOG_PATH;
const temporaryDirectories: string[] = [];

function createTestState(): WrapperState {
  const state = new WrapperState();
  states.push(state);
  return state;
}

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
      state: createTestState(),
      kiloClient,
      openConnection: async () => {},
      closeConnection: async () => {},
      setAborted: () => {},
      resetLifecycle: () => {},
      updateRuntimeEnvironment: async env => {
        runtimeEnvironmentUpdates.push(env);
      },
    },
    () => {}
  );
  return { fetchHandler, ptyCalls, resizeCalls, deleteCalls, runtimeEnvironmentUpdates };
}

afterEach(async () => {
  for (const state of states.splice(0)) state.clearSession();
  await Promise.all(servers.splice(0).map(server => server.stop()));
  globalThis.fetch = originalFetch;
  if (originalLogPath === undefined) delete process.env.WRAPPER_LOG_PATH;
  else process.env.WRAPPER_LOG_PATH = originalLogPath;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => fsp.rm(directory, { recursive: true, force: true }))
  );
});

describe('kilo server unreachable recovery', () => {
  const sessionBinding = {
    kiloSessionId: 'kilo_sess_test',
    ingestUrl: 'ws://worker.test/ingest',
    workerAuthToken: 'worker-token',
    wrapperRunId: 'run_1',
    wrapperGeneration: 1,
    wrapperConnectionId: 'conn_1',
    agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
  };

  function boundState(): WrapperState {
    const state = createTestState();
    state.bindSession(sessionBinding);
    return state;
  }

  const config = {
    port: 5000,
    workspacePath: '/workspace/repo',
    version: 'test',
    sessionId: 'kilo_sess_test',
    agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
    userId: 'user_test',
  };

  it('restarts the runtime when a prompt fails because the kilo server is unreachable', async () => {
    let restartCalls = 0;
    const kiloClient = {
      sendPromptAsync: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    } as unknown as WrapperKiloClient;
    const handler = createPromptHandler(config, {
      state: boundState(),
      kiloClient,
      openConnection: async () => {},
      closeConnection: async () => {},
      setAborted: () => {},
      resetLifecycle: () => {},
      restartKiloRuntime: async () => {
        restartCalls += 1;
      },
    });

    const response = await handler(
      new Request('http://wrapper.test/job/prompt', {
        method: 'POST',
        body: JSON.stringify({
          session: sessionBinding,
          message: { id: 'msg_1', prompt: 'hello' },
        }),
      })
    );

    expect(response.status).toBe(500);
    expect(restartCalls).toBe(1);
  });

  it('does not restart the runtime on an application-level prompt failure', async () => {
    let restartCalls = 0;
    const kiloClient = {
      sendPromptAsync: async () => {
        throw new Error('Async prompt for session kilo_sess_test failed: invalid model');
      },
    } as unknown as WrapperKiloClient;
    const handler = createPromptHandler(config, {
      state: boundState(),
      kiloClient,
      openConnection: async () => {},
      closeConnection: async () => {},
      setAborted: () => {},
      resetLifecycle: () => {},
      restartKiloRuntime: async () => {
        restartCalls += 1;
      },
    });

    const response = await handler(
      new Request('http://wrapper.test/job/prompt', {
        method: 'POST',
        body: JSON.stringify({
          session: sessionBinding,
          message: { id: 'msg_2', prompt: 'hello' },
        }),
      })
    );

    expect(response.status).toBe(500);
    expect(restartCalls).toBe(0);
  });

  it('restarts the runtime when a command fails because the kilo server is unreachable', async () => {
    let restartCalls = 0;
    const kiloClient = {
      sendCommand: async () => {
        throw new Error('fetch failed');
      },
    } as unknown as WrapperKiloClient;
    const handler = createCommandHandler(config, {
      state: boundState(),
      kiloClient,
      openConnection: async () => {},
      closeConnection: async () => {},
      setAborted: () => {},
      resetLifecycle: () => {},
      restartKiloRuntime: async () => {
        restartCalls += 1;
      },
    });

    const response = await handler(
      new Request('http://wrapper.test/job/command', {
        method: 'POST',
        body: JSON.stringify({
          session: sessionBinding,
          command: 'status',
        }),
      })
    );

    expect(response.status).toBe(500);
    expect(restartCalls).toBe(1);
  });

  it('does not restart the runtime on an application-level command failure', async () => {
    let restartCalls = 0;
    const kiloClient = {
      sendCommand: async () => {
        throw new Error('Command for session kilo_sess_test failed: unknown command');
      },
    } as unknown as WrapperKiloClient;
    const handler = createCommandHandler(config, {
      state: boundState(),
      kiloClient,
      openConnection: async () => {},
      closeConnection: async () => {},
      setAborted: () => {},
      resetLifecycle: () => {},
      restartKiloRuntime: async () => {
        restartCalls += 1;
      },
    });

    const response = await handler(
      new Request('http://wrapper.test/job/command', {
        method: 'POST',
        body: JSON.stringify({
          session: sessionBinding,
          command: 'status',
        }),
      })
    );

    expect(response.status).toBe(500);
    expect(restartCalls).toBe(0);
  });
});

describe('session readiness errors', () => {
  it('forwards validated workspace subtype and safe diagnostic fields', async () => {
    const { fetchHandler } = createTestFetch();
    const handler = createSessionReadyHandler({
      state: createTestState(),
      kiloClient: {} as WrapperKiloClient,
      openConnection: async () => {},
      closeConnection: async () => {},
      setAborted: () => {},
      resetLifecycle: () => {},
      readySession: async () => ({
        status: 'error',
        error: {
          code: 'WORKSPACE_SETUP_FAILED',
          subtype: 'git_clone_timeout',
          message: 'Repository clone timed out',
          detail: 'termination timeout, output truncated',
          retryable: true,
        },
      }),
    });
    const request = new Request('http://wrapper.test/session/ready', {
      method: 'POST',
      body: JSON.stringify({
        agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
        userId: 'user_test',
        sandboxId: 'sandbox_test',
        kiloSessionId: 'kilo_test',
        workspace: {
          workspacePath: '/workspace/repo',
          sessionHome: '/home/session',
          branchName: 'main',
        },
        materialized: { env: {} },
        session: {
          ingestUrl: 'wss://example.test/ingest',
          workerAuthToken: 'secret',
          wrapperRunId: 'wr_test',
          wrapperGeneration: 1,
          wrapperConnectionId: 'conn_test',
        },
      }),
    });

    const response = await handler(request);
    const body: unknown = await response.json();

    expect(body).toMatchObject({
      error: 'WORKSPACE_SETUP_FAILED',
      subtype: 'git_clone_timeout',
      message: 'Repository clone timed out',
      detail: 'termination timeout, output truncated',
      retryable: true,
    });
    expect(fetchHandler).toBeDefined();
  });
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
  it('creates a workspace PTY with the stable pnpm store and applies the requested size', async () => {
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
          [PNPM_STORE_ENV_VAR]: PNPM_STORE_DIR,
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
        state: createTestState(),
        kiloClient,
        openConnection: async () => {},
        closeConnection: async () => {},
        setAborted: () => {},
        resetLifecycle: () => {},
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
        state: createTestState(),
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

describe('wrapper log archive retention', () => {
  const binding = {
    ingestUrl: 'wss://worker.test/ingest',
    workerAuthToken: 'kka1.first-ticket',
    wrapperRunId: 'run_1',
    wrapperGeneration: 1,
    wrapperConnectionId: 'conn_1',
  };
  const config = {
    port: 5000,
    workspacePath: '/workspace/repo',
    version: 'test',
    sessionId: 'kilo_sess_test',
    agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
    userId: 'user_test',
  };
  const readyRequest: WrapperSessionReadyRequest = {
    agentSessionId: config.agentSessionId,
    userId: config.userId,
    sandboxId: 'sandbox_test',
    kiloSessionId: config.sessionId,
    workspace: {
      workspacePath: config.workspacePath,
      sessionHome: '/home/session',
      branchName: 'main',
    },
    materialized: { env: {} },
    preparation: { attemptId: 'preparation_1', triggerMessageId: 'message_1' },
    session: binding,
  };

  function requestReady(): Request {
    return new Request('http://wrapper.test/session/ready', {
      method: 'POST',
      body: JSON.stringify(readyRequest),
    });
  }

  async function createArchiveFixture() {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrapper-archive-test-'));
    temporaryDirectories.push(directory);
    const wrapperLogPath = path.join(directory, 'wrapper.log');
    await fsp.writeFile(wrapperLogPath, 'wrapper started\n');
    process.env.WRAPPER_LOG_PATH = wrapperLogPath;
    const archives = new Map<string, string>();
    const uploads: Array<{ url: URL; authorization: string | null }> = [];
    const state = createTestState();
    const deps: ServerDependencies = {
      state,
      kiloClient: {} as WrapperKiloClient,
      openConnection: async () => {},
      closeConnection: async () => {},
      setAborted: () => {},
      resetLifecycle: () => {},
    };
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const bytes = await new Response(init?.body).arrayBuffer();
        uploads.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
        archives.set(url.pathname, gunzipSync(bytes).toString());
        return new Response(null, { status: 204 });
      },
      { preconnect: originalFetch.preconnect }
    );
    return { state, deps, wrapperLogPath, archives, uploads };
  }

  it('retains the old archive and captured credentials when a warm wrapper changes runs', async () => {
    const { state, deps, wrapperLogPath, archives, uploads } = await createArchiveFixture();
    await bindSessionContext(binding, config, deps);
    const first = state.logUploader;
    if (!first) throw new Error('Expected first archive');
    const recordUpload = globalThis.fetch;
    const periodicStarted = Promise.withResolvers<void>();
    const releasePeriodic = Promise.withResolvers<void>();
    let firstUpload = true;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await recordUpload(input, init);
        if (firstUpload) {
          firstUpload = false;
          periodicStarted.resolve();
          await releasePeriodic.promise;
        }
        return response;
      },
      { preconnect: originalFetch.preconnect }
    );
    first.start(5);
    await periodicStarted.promise;
    await fsp.appendFile(wrapperLogPath, 'original run failed\n');

    const rebind = bindSessionContext(
      {
        ...binding,
        ingestUrl: 'wss://next-worker.test/ingest',
        workerAuthToken: 'kka1.next-run-ticket',
        wrapperRunId: 'run_2',
        wrapperGeneration: 2,
        wrapperConnectionId: 'conn_2',
      },
      config,
      deps,
      'restart',
      'kilo_sess_next'
    );
    expect(await Promise.race([rebind.then(() => true), Bun.sleep(100).then(() => false)])).toBe(
      true
    );
    const second = state.logUploader;
    if (!second) throw new Error('Expected second archive');
    expect(second.archiveId).toMatch(/^run_2--[a-f0-9-]+$/);
    expect(second.archiveId).not.toBe(first.archiveId);
    expect(state.currentSession?.wrapperRunId).toBe('run_2');

    await second.uploadNow();
    releasePeriodic.resolve();
    await first.finalize();
    const firstPath = `/sessions/user_test/${config.agentSessionId}/logs/${first.archiveId}/logs.tar.gz`;
    const firstArchive = archives.get(firstPath);
    await fsp.appendFile(wrapperLogPath, 'later run completed\n');
    await second.uploadNow();

    expect(archives.size).toBe(2);
    expect(firstArchive).toContain('original run failed');
    expect(firstArchive).not.toContain('later run completed');
    expect(archives.get(firstPath)).toBe(firstArchive);
    for (const upload of uploads) {
      if (upload.url.pathname === firstPath) {
        expect(upload.url.origin).toBe('https://worker.test');
        expect(upload.url.searchParams.get('kiloSessionId')).toBe(config.sessionId);
        expect(upload.authorization).toBe('Bearer kka1.first-ticket');
      } else {
        expect(upload.url.origin).toBe('https://next-worker.test');
        expect(upload.url.searchParams.get('kiloSessionId')).toBe('kilo_sess_next');
        expect(upload.authorization).toBe('Bearer kka1.next-run-ticket');
      }
    }
  });

  it('keeps the archive for same-run credential refreshes and refreshes the Kilo session', async () => {
    const { state, deps, uploads } = await createArchiveFixture();
    await bindSessionContext(binding, config, deps);
    const uploader = state.logUploader;
    if (!uploader) throw new Error('Expected archive');
    await uploader.uploadNow();
    const refreshedBinding = {
      ...binding,
      ingestUrl: 'wss://refreshed-worker.test/ingest',
      workerAuthToken: 'kka1.refreshed-ticket',
      ingestToken: 'refreshed-ingest-ticket',
      wrapperConnectionId: 'conn_refreshed',
    };
    await bindSessionContext(refreshedBinding, config, deps, 'restart', 'kilo_sess_refreshed');
    await state.logUploader?.uploadNow();
    await bindSessionContext(refreshedBinding, config, deps, 'restart', 'kilo_sess_latest');
    await state.logUploader?.uploadNow();

    expect(state.logUploader).toBe(uploader);
    expect(state.currentSession?.workerAuthToken).toBe(refreshedBinding.workerAuthToken);
    expect(state.currentSession?.kiloSessionId).toBe('kilo_sess_latest');
    expect(new Set(uploads.map(upload => upload.url.pathname)).size).toBe(1);
    expect(uploads.map(upload => upload.url.searchParams.get('kiloSessionId'))).toEqual([
      config.sessionId,
      'kilo_sess_refreshed',
      'kilo_sess_latest',
    ]);
    expect(uploads.map(upload => upload.authorization)).toEqual([
      'Bearer kka1.first-ticket',
      'Bearer kka1.refreshed-ticket',
      'Bearer kka1.refreshed-ticket',
    ]);
    expect(uploads[1]?.url.origin).toBe('https://refreshed-worker.test');
  });

  it('retains a failed bootstrap archive when retrying the same run and preparation attempt', async () => {
    const { state, deps, wrapperLogPath, archives, uploads } = await createArchiveFixture();
    let attempts = 0;
    deps.readySession = async (request, archiveId) => {
      attempts++;
      await bindSessionContext(
        request.session,
        config,
        deps,
        'close-until-runtime-ready',
        request.kiloSessionId,
        archiveId
      );
      if (attempts === 1) {
        await fsp.appendFile(wrapperLogPath, 'failed bootstrap evidence\n');
        return {
          status: 'error',
          error: {
            code: 'WORKSPACE_SETUP_FAILED',
            message: 'Workspace setup failed',
            retryable: true,
          },
        };
      }
      await fsp.appendFile(wrapperLogPath, 'bootstrap retry ready\n');
      return {
        status: 'ready',
        kiloSessionId: request.kiloSessionId,
        workspaceReady: {
          ...request.workspace,
          sandboxId: request.sandboxId,
          kiloSessionId: request.kiloSessionId,
        },
      };
    };
    const handler = createSessionReadyHandler(deps);
    const firstResponse = await handler(requestReady());
    const firstPath = uploads[0]?.url.pathname;
    if (!firstPath) throw new Error('Expected failed bootstrap upload');
    const failedArchive = archives.get(firstPath);
    expect(state.logUploader).toBeNull();

    const retryResponse = await handler(requestReady());
    await state.logUploader?.uploadNow();
    await state.logUploader?.uploadNow();

    expect(firstResponse.status).toBe(503);
    expect(retryResponse.status).toBe(200);
    expect(attempts).toBe(2);
    expect(archives.size).toBe(2);
    expect(failedArchive).toContain('failed bootstrap evidence');
    expect(failedArchive).not.toContain('bootstrap retry ready');
    expect(archives.get(firstPath)).toBe(failedArchive);
    expect(uploads[1]?.url.pathname).not.toBe(firstPath);
    expect(uploads[2]?.url.pathname).toBe(uploads[1]?.url.pathname);
    expect(state.logUploader?.archiveId).toMatch(/^run_1--[a-f0-9-]+$/);
  });

  it('shares an archive for duplicate in-flight ready requests but rotates for the next bootstrap', async () => {
    const { state, deps, archives } = await createArchiveFixture();
    const bootstrapStarted = Promise.withResolvers<void>();
    const releaseBootstrap = Promise.withResolvers<void>();
    let attempts = 0;
    deps.readySession = async (request, archiveId) => {
      attempts++;
      await bindSessionContext(
        request.session,
        config,
        deps,
        'close-until-runtime-ready',
        request.kiloSessionId,
        archiveId
      );
      bootstrapStarted.resolve();
      await releaseBootstrap.promise;
      return {
        status: 'ready',
        kiloSessionId: request.kiloSessionId,
        workspaceReady: {
          ...request.workspace,
          sandboxId: request.sandboxId,
          kiloSessionId: request.kiloSessionId,
        },
      };
    };
    const handler = createSessionReadyHandler(deps);
    const firstRequest = handler(requestReady());
    await bootstrapStarted.promise;
    const first = state.logUploader;
    if (!first) throw new Error('Expected bootstrap archive');
    const duplicate = handler(requestReady());
    await Bun.sleep(10);
    await first.uploadNow();

    expect(attempts).toBe(1);
    expect(state.logUploader).toBe(first);
    expect(archives.size).toBe(1);
    releaseBootstrap.resolve();
    const responses = await Promise.all([firstRequest, duplicate]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);

    const nextResponse = await handler(requestReady());
    await first.finalize();
    await state.logUploader?.uploadNow();
    expect(nextResponse.status).toBe(200);
    expect(attempts).toBe(2);
    expect(state.logUploader?.archiveId).not.toBe(first.archiveId);
    expect(archives.size).toBe(2);
  });

  it('does not replace a bootstrap failure with a log upload failure or log its credential', async () => {
    const { deps, state, wrapperLogPath } = await createArchiveFixture();
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error(`Authorization: Bearer ${binding.workerAuthToken}`);
      },
      { preconnect: originalFetch.preconnect }
    );
    deps.readySession = async (request, archiveId) => {
      await bindSessionContext(
        request.session,
        config,
        deps,
        'close-until-runtime-ready',
        request.kiloSessionId,
        archiveId
      );
      return {
        status: 'error',
        error: { code: 'KILO_SERVER_FAILED', message: 'Kilo server failed', retryable: true },
      };
    };

    const response = await createSessionReadyHandler(deps)(requestReady());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'KILO_SERVER_FAILED',
      message: 'Kilo server failed',
      retryable: true,
    });
    expect(state.logUploader).toBeNull();
    expect(await fsp.readFile(wrapperLogPath, 'utf8')).not.toContain(binding.workerAuthToken);
  });
});

describe('wrapper session binding', () => {
  it('binds the kiloSessionId supplied by the caller even when config has not been updated yet', async () => {
    // A freshly bootstrapped wrapper's ServerConfig.sessionId starts out empty
    // and is only set by the caller after the ready request's binding is
    // processed. bindSessionContext must use the id the caller already knows
    // (from the ready request), not a stale config value, since that id also
    // seeds the log uploader's kiloSessionId for the wrapper's entire life.
    const state = createTestState();

    const response = await bindSessionContext(
      {
        ingestUrl: 'ws://worker.test/ingest',
        workerAuthToken: 'worker-token',
        wrapperRunId: 'run_1',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_1',
      },
      {
        port: 5000,
        workspacePath: '/workspace/repo',
        version: 'test',
        sessionId: '',
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
      },
      'close-until-runtime-ready',
      'kilo_sess_real'
    );

    expect(response).toBeNull();
    expect(state.currentSession?.kiloSessionId).toBe('kilo_sess_real');
  });

  it('rejects even the current binding while the wrapper is finalizing', async () => {
    const state = createTestState();
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
    state.blockAdmissions();

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
        closeConnection: async () => {},
        setAborted: () => {},
        resetLifecycle: () => {},
      },
      'close-until-runtime-ready'
    );

    if (!response) throw new Error('Expected finalizing binding rejection');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'WRAPPER_FINALIZING',
      wrapperRunId: 'run_1',
    });
  });

  it('keeps bootstrap rebindings close-only until runtime readiness is verified', async () => {
    const state = createTestState();
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
    const state = createTestState();
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
    const state = createTestState();
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
    const state = createTestState();
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
