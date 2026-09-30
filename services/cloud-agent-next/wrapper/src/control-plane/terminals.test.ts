import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { WrapperKiloClient, WrapperPty, WrapperPtySize } from '../kilo-api.js';
import type { KiloRuntime, KiloRuntimes } from './kilo-runtime.js';
import { createControlPlaneTerminals } from './terminals.js';
import { forgetAttachedRoot, rootForSession } from '../control/session-directories.js';

const session = {
  sessionId: 'workspace_terminal',
  kiloSessionId: 'kilo_terminal',
  directory: '/workspace/terminal',
};
const ptyId = 'pty_1';

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition was not met');
}

function fakeClient(serverUrl: string): WrapperKiloClient {
  return {
    serverUrl,
    createPty: async (input: { cwd: string }): Promise<WrapperPty> => ({
      id: ptyId,
      title: 'Terminal',
      command: '/bin/sh',
      args: [],
      cwd: input.cwd,
      status: 'running',
      pid: 73,
    }),
    resizePty: async (
      id: string,
      _size: WrapperPtySize,
      directory?: string
    ): Promise<WrapperPty> => ({
      id,
      title: 'Terminal',
      command: '/bin/sh',
      args: [],
      cwd: directory ?? session.directory,
      status: 'running',
      pid: 73,
    }),
    deletePty: async () => true,
  } as unknown as WrapperKiloClient;
}

function fakeRuntime(client: WrapperKiloClient): KiloRuntime {
  return {
    directory: session.directory,
    env: { TERMINAL: '1' },
    client,
    ensure: async () => client,
    installCredentials: async () => undefined,
    applyPendingCredentials: async () => false,
    isSuspected: () => false,
    isRestarting: () => false,
    isUnavailable: () => false,
    shutdown: async () => undefined,
  };
}

function fakeRuntimes(runtime: KiloRuntime | undefined): KiloRuntimes {
  return {
    async ensure() {
      throw new Error('unused');
    },
    get: () => runtime,
    remove: () => undefined,
    suspected: () => false,
    unavailable: () => false,
    runtimesForDirectory: () => (runtime ? [runtime] : []),
    async retireDirectory() {},
    async shutdown() {},
  };
}

let server: Bun.Server<{ path: string }>;
let serverUrl: string;
const sockets: { reverse?: Bun.ServerWebSocket<{ path: string }> } = {};

beforeAll(() => {
  server = Bun.serve<{ path: string }>({
    port: 0,
    fetch(request, instance) {
      const path = new URL(request.url).pathname;
      if (instance.upgrade(request, { data: { path } })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(socket) {
        if (socket.data.path.startsWith('/sandbox-terminal/')) sockets.reverse = socket;
      },
      message() {},
      close() {},
    },
  });
  serverUrl = `ws://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

function attachedTerminals(client: WrapperKiloClient) {
  const terminals = createControlPlaneTerminals({
    controlUrl: serverUrl,
    wrapperId: 'wrapper_test',
    runtimes: fakeRuntimes(fakeRuntime(client)),
  });
  terminals.rememberAttachedSession(session, session.sessionId);
  return terminals;
}

describe('control-plane terminal adapter (B10)', () => {
  it('rolls back the global root when attachment reads a restarting runtime client', () => {
    const runtime = fakeRuntime(fakeClient(serverUrl));
    Object.defineProperty(runtime, 'client', {
      get() {
        throw new Error('not started');
      },
    });
    const terminals = createControlPlaneTerminals({
      controlUrl: serverUrl,
      wrapperId: 'wrapper_test',
      runtimes: fakeRuntimes(runtime),
    });
    expect(() => terminals.rememberAttachedSession(session, session.sessionId)).toThrow(
      'not started'
    );
    expect(rootForSession(session.kiloSessionId)).toBeUndefined();
    terminals.shutdown();
  });

  it('preserves an existing root when re-attachment fails', () => {
    const runtime = fakeRuntime(fakeClient(serverUrl));
    const terminals = createControlPlaneTerminals({
      controlUrl: serverUrl,
      wrapperId: 'wrapper_test',
      runtimes: fakeRuntimes(runtime),
    });
    terminals.rememberAttachedSession(session, session.sessionId);
    Object.defineProperty(runtime, 'client', {
      get() {
        throw new Error('not started');
      },
    });
    expect(() => terminals.rememberAttachedSession(session, session.sessionId)).toThrow(
      'not started'
    );
    expect(rootForSession(session.kiloSessionId)).toBe(session.kiloSessionId);
    forgetAttachedRoot(session.kiloSessionId, session.directory);
    terminals.shutdown();
  });

  it('detaches without reading the client of a restarting runtime', async () => {
    for (const detachDirectory of [false, true]) {
      const runtime = fakeRuntime(fakeClient(serverUrl));
      const terminals = createControlPlaneTerminals({
        controlUrl: serverUrl,
        wrapperId: 'wrapper_test',
        runtimes: fakeRuntimes(runtime),
      });
      terminals.rememberAttachedSession(session, session.sessionId);
      const created = await terminals.handle({
        type: 'terminal.create',
        requestId: 'restart_detach',
        session,
        payload: { operationId: crypto.randomUUID() },
      });
      expect(created).toMatchObject({ ok: true, result: { pty: { id: ptyId } } });
      Object.defineProperty(runtime, 'client', {
        get() {
          throw new Error('not started');
        },
      });
      if (detachDirectory) await terminals.detachDirectory(session.directory);
      else await terminals.forgetSession(session.sessionId);
      if (!detachDirectory) expect(rootForSession(session.kiloSessionId)).toBeUndefined();
      forgetAttachedRoot(session.kiloSessionId, session.directory);
      terminals.shutdown();
    }
  });
  it('answers an unattached terminal request with a mapped not_ready result', async () => {
    const terminals = createControlPlaneTerminals({
      controlUrl: serverUrl,
      wrapperId: 'wrapper_test',
      runtimes: fakeRuntimes(undefined),
    });

    const result = await terminals.handle({
      type: 'terminal.create',
      requestId: 'request_1',
      session,
      payload: { operationId: '00000000-0000-4000-8000-000000000001' },
    });

    expect(result).toMatchObject({
      type: 'terminal.result',
      requestId: 'request_1',
      ok: false,
      error: { code: 'not_ready', retryable: true },
    });
    terminals.shutdown();
  });

  it('routes create, resize, close and connect to their own runtime operation', async () => {
    sockets.reverse = undefined;
    const terminals = attachedTerminals(fakeClient(serverUrl));

    const created = await terminals.handle({
      type: 'terminal.create',
      requestId: 'request_create',
      session,
      payload: { operationId: '00000000-0000-4000-8000-000000000002' },
    });
    expect(created).toMatchObject({
      type: 'terminal.result',
      requestId: 'request_create',
      ok: true,
      result: { pty: { id: ptyId, cwd: session.directory } },
    });

    const resized = await terminals.handle({
      type: 'terminal.resize',
      requestId: 'request_resize',
      session,
      payload: { ptyId, cols: 80, rows: 24 },
    });
    expect(resized).toMatchObject({
      type: 'terminal.result',
      requestId: 'request_resize',
      ok: true,
      result: { pty: { id: ptyId } },
    });

    const connected = terminals.handle({
      type: 'terminal.connect',
      requestId: 'request_connect',
      session,
      payload: {
        ownerId: 'user_1',
        ptyId,
        bridgeGeneration: crypto.randomUUID(),
        capability: 'a'.repeat(64),
      },
    });
    await waitFor(() => sockets.reverse !== undefined);
    const connectResult = await connected;
    expect(connectResult).toMatchObject({
      type: 'terminal.result',
      requestId: 'request_connect',
      ok: true,
      result: { connected: true },
    });

    const closed = await terminals.handle({
      type: 'terminal.close',
      requestId: 'request_close',
      session,
      payload: { ptyId },
    });
    expect(closed).toMatchObject({
      type: 'terminal.result',
      requestId: 'request_close',
      ok: true,
      result: { success: true },
    });

    terminals.shutdown();
  });

  it('reports heartbeat activity only for recent browser→PTY input', async () => {
    sockets.reverse = undefined;
    const terminals = attachedTerminals(fakeClient(serverUrl));
    expect(terminals.hasRecentInput()).toBe(false);

    await terminals.handle({
      type: 'terminal.create',
      requestId: 'request_create',
      session,
      payload: { operationId: '00000000-0000-4000-8000-000000000003' },
    });
    const connected = terminals.handle({
      type: 'terminal.connect',
      requestId: 'request_connect',
      session,
      payload: {
        ownerId: 'user_1',
        ptyId,
        bridgeGeneration: crypto.randomUUID(),
        capability: 'a'.repeat(64),
      },
    });
    await waitFor(() => sockets.reverse !== undefined);
    await connected;

    // An open, idle PTY is not activity.
    expect(terminals.hasRecentInput()).toBe(false);
    const reverse = sockets.reverse as Bun.ServerWebSocket<{ path: string }> | undefined;
    if (!reverse) throw new Error('reverse socket was not opened');
    reverse.send('keystroke');
    await waitFor(() => terminals.hasRecentInput());

    await terminals.forgetSession(session.sessionId);
    expect(terminals.hasRecentInput()).toBe(false);
    terminals.shutdown();
  });
});
