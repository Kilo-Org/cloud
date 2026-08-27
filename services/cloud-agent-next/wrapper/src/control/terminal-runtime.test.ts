import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
  SessionRequestIdentity,
  SessionTerminalConnectPayload,
  SessionTerminalCreatePayload,
} from '../../../src/shared/sandbox-control-protocol.js';
import { PNPM_STORE_DIR, PNPM_STORE_ENV_VAR } from '../../../src/shared/runtime-environment.js';
import type { WrapperKiloClient, WrapperPty } from '../kilo-api.js';
import { createControlTerminalRuntime, type ControlTerminalRuntime } from './terminal-runtime.js';
import {
  rememberAttachedRoot,
  resetSessionDirectoryState,
  rootForSession,
} from './session-directories.js';

const firstSession: SessionRequestIdentity = {
  sessionId: 'workspace_first',
  kiloSessionId: 'kilo_first',
  directory: '/workspace/first',
};

const secondSession: SessionRequestIdentity = {
  sessionId: 'workspace_second',
  kiloSessionId: 'kilo_second',
  directory: '/workspace/second',
};

const firstOperationId = '00000000-0000-4000-8000-000000000001';
const secondOperationId = '00000000-0000-4000-8000-000000000002';
const wrapperInstanceId = '00000000-0000-4000-8000-000000000010';
const activeRuntimes = new Set<ControlTerminalRuntime>();

type PtyClientOverrides = Partial<
  Pick<WrapperKiloClient, 'serverUrl' | 'createPty' | 'resizePty' | 'deletePty'>
>;

type TerminalFrame = string | Uint8Array;

type TestClose = { code: number; reason: string };

function makePty(directory: string, id = 'pty_first'): WrapperPty {
  return {
    id,
    title: 'Workspace terminal',
    command: '/bin/bash',
    args: [],
    cwd: directory,
    status: 'running',
    pid: 73,
  };
}

function fakeKilo(overrides: PtyClientOverrides = {}): WrapperKiloClient {
  return {
    serverUrl: 'http://127.0.0.1:1',
    createPty: async input => makePty(input.cwd),
    resizePty: async (ptyId, _size, directory) =>
      makePty(directory ?? firstSession.directory, ptyId),
    deletePty: async () => true,
    ...overrides,
  } as WrapperKiloClient;
}

function createRuntime(
  kiloClient: WrapperKiloClient,
  controlUrl = 'ws://127.0.0.1:1/sandbox-control/sandbox'
): ControlTerminalRuntime {
  const runtime = createControlTerminalRuntime({
    controlUrl,
    wrapperInstanceId,
    kiloClient,
  });
  activeRuntimes.add(runtime);
  return runtime;
}

function attach(runtime: ControlTerminalRuntime, identity: SessionRequestIdentity): void {
  rememberAttachedRoot(identity.kiloSessionId, identity.directory);
  runtime.rememberAttachedSession(identity);
}

function creationPayload(
  operationId = firstOperationId,
  size?: { cols: number; rows: number }
): SessionTerminalCreatePayload {
  return { operationId, ...(size ?? {}) };
}

function connectionPayload(
  overrides: Partial<SessionTerminalConnectPayload> = {}
): SessionTerminalConnectPayload {
  return {
    ownerId: 'oauth/google:account%2Fsegment',
    ptyId: 'pty_first',
    bridgeGeneration: crypto.randomUUID(),
    capability: 'a'.repeat(64),
    ...overrides,
  };
}

function createQueue<Value>(name: string) {
  const values: Value[] = [];
  const waiting: Array<(value: Value) => void> = [];
  return {
    push(value: Value): void {
      const resolve = waiting.shift();
      if (resolve) {
        resolve(value);
        return;
      }
      values.push(value);
    },
    next(): Promise<Value> {
      if (values.length > 0) {
        const value = values.shift();
        if (value !== undefined) return Promise.resolve(value);
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${name} timed out`)), 500);
        waiting.push(value => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
    },
  };
}

function normalizeFrame(frame: string | Buffer): TerminalFrame {
  return typeof frame === 'string' ? frame : new Uint8Array(frame);
}

async function terminalFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected terminal operation to fail');
}

function createBridgeServers(initialOutput?: string) {
  const events: string[] = [];
  const reverseRequests: Array<{ url: URL; authorization: string | null }> = [];
  const localRequests: URL[] = [];
  const reverseSockets: Array<Bun.ServerWebSocket<{ role: 'reverse' }>> = [];
  const localSockets: Array<Bun.ServerWebSocket<{ role: 'local' }>> = [];
  const reverseFrames = createQueue<TerminalFrame>('reverse frame');
  const localFrames = createQueue<TerminalFrame>('local frame');
  const reverseCloses = createQueue<TestClose>('reverse close');
  const localCloses = createQueue<TestClose>('local close');

  const reverse = Bun.serve<{ role: 'reverse' }>({
    port: 0,
    fetch(request, server) {
      events.push('reverse-request');
      reverseRequests.push({
        url: new URL(request.url),
        authorization: request.headers.get('authorization'),
      });
      if (server.upgrade(request, { data: { role: 'reverse' } })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(socket) {
        events.push('reverse-open');
        reverseSockets.push(socket);
      },
      message(_socket, frame) {
        reverseFrames.push(normalizeFrame(frame));
      },
      close(_socket, code, reason) {
        reverseCloses.push({ code, reason });
      },
    },
  });

  const local = Bun.serve<{ role: 'local' }>({
    port: 0,
    fetch(request, server) {
      events.push('local-request');
      localRequests.push(new URL(request.url));
      if (server.upgrade(request, { data: { role: 'local' } })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(socket) {
        events.push('local-open');
        localSockets.push(socket);
        if (initialOutput !== undefined) socket.send(initialOutput);
      },
      message(socket, frame) {
        localFrames.push(normalizeFrame(frame));
        socket.send(frame);
      },
      close(_socket, code, reason) {
        localCloses.push({ code, reason });
      },
    },
  });

  return {
    controlUrl: `ws://127.0.0.1:${reverse.port}/sandbox-control/sandbox?ignored=true#fragment`,
    localUrl: `http://127.0.0.1:${local.port}`,
    events,
    reverseRequests,
    localRequests,
    reverseSockets,
    localSockets,
    reverseFrames,
    localFrames,
    reverseCloses,
    localCloses,
    stop(): void {
      void reverse.stop(true);
      void local.stop(true);
    },
  };
}

beforeEach(() => {
  resetSessionDirectoryState();
});

afterEach(() => {
  for (const runtime of activeRuntimes) runtime.shutdown();
  activeRuntimes.clear();
  resetSessionDirectoryState();
});

describe('control terminal PTY ownership', () => {
  it('requires a successfully attached exact root and directory', async () => {
    const runtime = createRuntime(fakeKilo());

    expect(await terminalFailure(runtime.create(firstSession, creationPayload()))).toMatchObject({
      code: 'not_ready',
      retryable: true,
    });

    rememberAttachedRoot(firstSession.kiloSessionId, '/workspace/different');
    expect(() => runtime.rememberAttachedSession(firstSession)).toThrow(
      'Terminal session ownership mismatch'
    );
  });

  it('creates an idempotent directory-scoped PTY with the safe legacy terminal environment', async () => {
    const createCalls: Array<{ cwd: string; title: string; env: Record<string, string> }> = [];
    const resizeCalls: Array<{ ptyId: string; cols: number; rows: number; directory?: string }> =
      [];
    let releaseCreation: (() => void) | undefined;
    const creationGate = new Promise<void>(resolve => {
      releaseCreation = resolve;
    });
    const kiloClient = fakeKilo({
      createPty: async input => {
        createCalls.push(input);
        await creationGate;
        return makePty(input.cwd);
      },
      resizePty: async (ptyId, size, directory) => {
        resizeCalls.push({ ptyId, ...size, directory });
        return makePty(directory ?? '', ptyId);
      },
    });
    const runtime = createRuntime(kiloClient);
    attach(runtime, firstSession);
    const payload = creationPayload(firstOperationId, { cols: 120, rows: 35 });

    const first = runtime.create(firstSession, payload);
    const concurrent = runtime.create(firstSession, payload);
    await Promise.resolve();
    expect(createCalls).toHaveLength(1);

    releaseCreation?.();
    const [created, duplicate] = await Promise.all([first, concurrent]);
    expect(created).toEqual({ pty: makePty(firstSession.directory) });
    expect(duplicate).toEqual(created);
    expect(await runtime.create(firstSession, payload)).toEqual(created);
    expect(createCalls).toEqual([
      {
        cwd: firstSession.directory,
        title: 'Workspace terminal',
        env: {
          PROMPT_COMMAND: "PS1='\\n\\W\\n\\$ '",
          PS1: '\\n\\W\\n\\$ ',
          [PNPM_STORE_ENV_VAR]: PNPM_STORE_DIR,
          SANDBOX_CONTROL_CREDENTIAL: '',
        },
      },
    ]);
    expect(resizeCalls).toEqual([
      { ptyId: 'pty_first', cols: 120, rows: 35, directory: firstSession.directory },
    ]);
  });

  it('rejects operation IDs reused for different dimensions or session identities', async () => {
    const runtime = createRuntime(fakeKilo());
    attach(runtime, firstSession);
    attach(runtime, secondSession);
    await runtime.create(firstSession, creationPayload(firstOperationId, { cols: 100, rows: 30 }));

    expect(
      await terminalFailure(
        runtime.create(firstSession, creationPayload(firstOperationId, { cols: 101, rows: 30 }))
      )
    ).toMatchObject({ code: 'idempotency_conflict', retryable: false });
    expect(
      await terminalFailure(
        runtime.create(secondSession, creationPayload(firstOperationId, { cols: 100, rows: 30 }))
      )
    ).toMatchObject({ code: 'idempotency_conflict', retryable: false });
  });

  it('deletes a created PTY in its exact directory when initial resize fails', async () => {
    const deleted: Array<{ ptyId: string; directory?: string }> = [];
    let failResize = true;
    let createdCount = 0;
    const kiloClient = fakeKilo({
      createPty: async input => {
        createdCount += 1;
        return makePty(input.cwd, `pty_${createdCount}`);
      },
      resizePty: async (ptyId, _size, directory) => {
        if (failResize) throw new Error('private upstream detail');
        return makePty(directory ?? '', ptyId);
      },
      deletePty: async (ptyId, directory) => {
        deleted.push({ ptyId, directory });
        return true;
      },
    });
    const runtime = createRuntime(kiloClient);
    attach(runtime, firstSession);
    const payload = creationPayload(firstOperationId, { cols: 100, rows: 30 });

    expect(await terminalFailure(runtime.create(firstSession, payload))).toMatchObject({
      code: 'not_ready',
      message: 'Terminal creation failed',
      retryable: false,
    });
    expect(deleted).toEqual([{ ptyId: 'pty_1', directory: firstSession.directory }]);

    failResize = false;
    expect(await runtime.create(firstSession, payload)).toEqual({
      pty: makePty(firstSession.directory, 'pty_2'),
    });
  });

  it('rejects a Kilo PTY returned for a different workspace directory', async () => {
    const deleted: Array<{ ptyId: string; directory?: string }> = [];
    const kiloClient = fakeKilo({
      createPty: async () => makePty('/workspace/unowned'),
      deletePty: async (ptyId, directory) => {
        deleted.push({ ptyId, directory });
        return true;
      },
    });
    const runtime = createRuntime(kiloClient);
    attach(runtime, firstSession);

    expect(await terminalFailure(runtime.create(firstSession, creationPayload()))).toMatchObject({
      code: 'protocol_error',
      message: 'Invalid terminal response',
      retryable: false,
    });
    expect(deleted).toEqual([{ ptyId: 'pty_first', directory: firstSession.directory }]);
  });

  it('fences every PTY operation to its owning session and preserves unrelated sessions on detach', async () => {
    const resized: Array<{ ptyId: string; directory?: string }> = [];
    const deleted: Array<{ ptyId: string; directory?: string }> = [];
    let createdCount = 0;
    const kiloClient = fakeKilo({
      createPty: async input => makePty(input.cwd, `pty_${++createdCount}`),
      resizePty: async (ptyId, _size, directory) => {
        resized.push({ ptyId, directory });
        return makePty(directory ?? '', ptyId);
      },
      deletePty: async (ptyId, directory) => {
        deleted.push({ ptyId, directory });
        return true;
      },
    });
    const runtime = createRuntime(kiloClient);
    attach(runtime, firstSession);
    attach(runtime, secondSession);
    await runtime.create(firstSession, creationPayload(firstOperationId));
    await runtime.create(secondSession, creationPayload(secondOperationId));

    expect(
      await terminalFailure(runtime.resize(secondSession, { ptyId: 'pty_1', cols: 100, rows: 30 }))
    ).toMatchObject({ code: 'unauthorized', retryable: false });
    expect(await terminalFailure(runtime.close(secondSession, { ptyId: 'pty_1' }))).toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
    expect(
      await terminalFailure(
        runtime.resize(
          { ...firstSession, directory: secondSession.directory },
          { ptyId: 'pty_1', cols: 100, rows: 30 }
        )
      )
    ).toMatchObject({ code: 'unauthorized', retryable: false });

    await runtime.detachSession(firstSession);
    expect(deleted).toEqual([{ ptyId: 'pty_1', directory: firstSession.directory }]);
    expect(rootForSession(firstSession.kiloSessionId)).toBeUndefined();
    expect(rootForSession(secondSession.kiloSessionId)).toBe(secondSession.kiloSessionId);

    expect(await runtime.resize(secondSession, { ptyId: 'pty_2', cols: 110, rows: 40 })).toEqual({
      pty: makePty(secondSession.directory, 'pty_2'),
    });
    expect(resized).toEqual([{ ptyId: 'pty_2', directory: secondSession.directory }]);
  });

  it('compensates PTY creation that finishes after its session detaches', async () => {
    let releaseCreation: (() => void) | undefined;
    const creationGate = new Promise<void>(resolve => {
      releaseCreation = resolve;
    });
    const deleted: Array<{ ptyId: string; directory?: string }> = [];
    const kiloClient = fakeKilo({
      createPty: async input => {
        await creationGate;
        return makePty(input.cwd);
      },
      deletePty: async (ptyId, directory) => {
        deleted.push({ ptyId, directory });
        return true;
      },
    });
    const runtime = createRuntime(kiloClient);
    attach(runtime, firstSession);

    const creation = runtime.create(firstSession, creationPayload());
    await Promise.resolve();
    const detached = runtime.detachSession(firstSession);
    releaseCreation?.();

    expect(await terminalFailure(creation)).toMatchObject({
      code: 'not_ready',
      message: 'Terminal session is no longer attached',
      retryable: false,
    });
    await detached;
    expect(deleted).toEqual([{ ptyId: 'pty_first', directory: firstSession.directory }]);
  });

  it('removes completed creation-operation state when its PTY is closed', async () => {
    let createdCount = 0;
    const kiloClient = fakeKilo({
      createPty: async input => makePty(input.cwd, `pty_${++createdCount}`),
    });
    const runtime = createRuntime(kiloClient);
    attach(runtime, firstSession);
    const payload = creationPayload();
    await runtime.create(firstSession, payload);

    expect(await runtime.close(firstSession, { ptyId: 'pty_1' })).toEqual({
      success: true,
    });
    expect(await runtime.create(firstSession, payload)).toEqual({
      pty: makePty(firstSession.directory, 'pty_2'),
    });
  });
});

describe('control terminal reverse WebSocket bridge', () => {
  it('authenticates the trusted reverse origin and relays initial, text, control, and binary frames unchanged', async () => {
    const servers = createBridgeServers('initial output');
    const kiloClient = fakeKilo({ serverUrl: servers.localUrl });
    const runtime = createRuntime(kiloClient, servers.controlUrl);
    attach(runtime, firstSession);
    await runtime.create(firstSession, creationPayload());
    const payload = connectionPayload();

    try {
      expect(await runtime.connect(firstSession, payload)).toEqual({ connected: true });
      expect(await runtime.connect(firstSession, payload)).toEqual({ connected: true });
      expect(await servers.reverseFrames.next()).toBe('initial output');
      expect(servers.reverseRequests).toHaveLength(1);
      expect(servers.reverseRequests[0]?.url.pathname).toBe(
        `/sandbox-terminal/${encodeURIComponent(payload.ownerId)}/${firstSession.sessionId}/${payload.ptyId}`
      );
      expect(servers.reverseRequests[0]?.url.search).toBe('');
      expect(servers.reverseRequests[0]?.url.hash).toBe('');
      expect(servers.reverseRequests[0]?.authorization).toBe(`Bearer ${payload.capability}`);
      expect(servers.localRequests[0]?.pathname).toBe(`/pty/${payload.ptyId}/connect`);
      expect(servers.localRequests[0]?.searchParams.get('directory')).toBe(firstSession.directory);
      expect(servers.events.indexOf('reverse-open')).toBeLessThan(
        servers.events.indexOf('local-request')
      );

      const reverse = servers.reverseSockets[0];
      if (!reverse) throw new Error('Expected reverse terminal socket');
      for (const frame of ['ping', 'pong', '\u0000cursor-control']) {
        reverse.send(frame);
        expect(await servers.localFrames.next()).toBe(frame);
        expect(await servers.reverseFrames.next()).toBe(frame);
      }

      const binary = new Uint8Array([0, 255, 17, 128]);
      reverse.send(binary);
      expect(await servers.localFrames.next()).toEqual(binary);
      expect(await servers.reverseFrames.next()).toEqual(binary);
    } finally {
      runtime.shutdown();
      servers.stop();
    }
  });

  it('does not subscribe to the local PTY when the reverse capability is rejected', async () => {
    const servers = createBridgeServers();
    const denied = Bun.serve({
      port: 0,
      fetch: () => new Response('unauthorized', { status: 401 }),
    });
    const runtime = createRuntime(
      fakeKilo({ serverUrl: servers.localUrl }),
      `ws://127.0.0.1:${denied.port}/sandbox-control/sandbox`
    );
    attach(runtime, firstSession);
    await runtime.create(firstSession, creationPayload());

    try {
      expect(
        await terminalFailure(runtime.connect(firstSession, connectionPayload()))
      ).toMatchObject({
        code: 'not_ready',
        message: 'Terminal transport failed',
        retryable: true,
      });
      expect(servers.localRequests).toEqual([]);
    } finally {
      runtime.shutdown();
      void denied.stop(true);
      servers.stop();
    }
  });

  it('replaces bridge generations and reconnects without deleting the underlying PTY', async () => {
    const servers = createBridgeServers();
    let deleted = 0;
    const kiloClient = fakeKilo({
      serverUrl: servers.localUrl,
      deletePty: async () => {
        deleted += 1;
        return true;
      },
    });
    const runtime = createRuntime(kiloClient, servers.controlUrl);
    attach(runtime, firstSession);
    await runtime.create(firstSession, creationPayload());

    try {
      const first = connectionPayload();
      await runtime.connect(firstSession, first);
      const second = connectionPayload({ bridgeGeneration: crypto.randomUUID() });
      await runtime.connect(firstSession, second);
      expect((await servers.reverseCloses.next()).code).toBe(4000);
      expect((await servers.localCloses.next()).code).toBe(4000);

      const replacement = servers.reverseSockets[1];
      if (!replacement) throw new Error('Expected replacement reverse terminal socket');
      replacement.send('replacement input');
      expect(await servers.localFrames.next()).toBe('replacement input');
      expect(await servers.reverseFrames.next()).toBe('replacement input');

      replacement.close(1000, 'browser disconnected');
      expect((await servers.localCloses.next()).code).toBe(1000);
      expect(deleted).toBe(0);

      expect(
        await runtime.connect(
          firstSession,
          connectionPayload({ bridgeGeneration: crypto.randomUUID() })
        )
      ).toEqual({ connected: true });
      expect(servers.localRequests).toHaveLength(3);
      expect(deleted).toBe(0);
    } finally {
      runtime.shutdown();
      servers.stop();
    }
  });

  it('rejects reconnects that change the terminal owner', async () => {
    const servers = createBridgeServers();
    const runtime = createRuntime(fakeKilo({ serverUrl: servers.localUrl }), servers.controlUrl);
    attach(runtime, firstSession);
    await runtime.create(firstSession, creationPayload());

    try {
      await runtime.connect(firstSession, connectionPayload());
      expect(
        await terminalFailure(
          runtime.connect(firstSession, connectionPayload({ ownerId: 'different-owner' }))
        )
      ).toMatchObject({ code: 'unauthorized', retryable: false });
      expect(servers.reverseRequests).toHaveLength(1);
    } finally {
      runtime.shutdown();
      servers.stop();
    }
  });

  it('delivers final PTY output before the normal terminal-ended close', async () => {
    const servers = createBridgeServers();
    const runtime = createRuntime(fakeKilo({ serverUrl: servers.localUrl }), servers.controlUrl);
    attach(runtime, firstSession);
    await runtime.create(firstSession, creationPayload());

    try {
      await runtime.connect(firstSession, connectionPayload());
      const local = servers.localSockets[0];
      if (!local) throw new Error('Expected local terminal socket');
      local.send('final output');
      local.close(1000, 'shell exited');

      expect(await servers.reverseFrames.next()).toBe('final output');
      expect((await servers.reverseCloses.next()).code).toBe(1000);
      expect(
        await terminalFailure(runtime.connect(firstSession, connectionPayload()))
      ).toMatchObject({
        code: 'not_ready',
        message: 'PTY session ended',
        retryable: false,
      });
    } finally {
      runtime.shutdown();
      servers.stop();
    }
  });

  it('translates abnormal local transport closures into safe retryable bridge failures', async () => {
    const servers = createBridgeServers();
    const runtime = createRuntime(fakeKilo({ serverUrl: servers.localUrl }), servers.controlUrl);
    attach(runtime, firstSession);
    await runtime.create(firstSession, creationPayload());

    try {
      await runtime.connect(firstSession, connectionPayload());
      const local = servers.localSockets[0];
      if (!local) throw new Error('Expected local terminal socket');
      local.close(1011, 'private upstream failure');

      expect((await servers.reverseCloses.next()).code).toBe(1011);
    } finally {
      runtime.shutdown();
      servers.stop();
    }
  });

  it('closes a bridge when its Bun socket output buffer exceeds the fixed bound', async () => {
    const servers = createBridgeServers();
    const runtime = createRuntime(fakeKilo({ serverUrl: servers.localUrl }), servers.controlUrl);
    attach(runtime, firstSession);
    await runtime.create(firstSession, creationPayload());
    const bufferedAmount = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount');
    if (!bufferedAmount) throw new Error('Expected Bun WebSocket bufferedAmount property');

    try {
      await runtime.connect(firstSession, connectionPayload());
      Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
        configurable: true,
        get: () => 1024 * 1024,
      });
      const local = servers.localSockets[0];
      if (!local) throw new Error('Expected local terminal socket');
      local.send('buffered output');

      expect((await servers.reverseCloses.next()).code).toBe(1011);
    } finally {
      Object.defineProperty(WebSocket.prototype, 'bufferedAmount', bufferedAmount);
      runtime.shutdown();
      servers.stop();
    }
  });

  it('closes oversized terminal frames without deleting the PTY', async () => {
    const servers = createBridgeServers();
    let deleted = false;
    const runtime = createRuntime(
      fakeKilo({
        serverUrl: servers.localUrl,
        deletePty: async () => {
          deleted = true;
          return true;
        },
      }),
      servers.controlUrl
    );
    attach(runtime, firstSession);
    await runtime.create(firstSession, creationPayload());

    try {
      await runtime.connect(firstSession, connectionPayload());
      const local = servers.localSockets[0];
      if (!local) throw new Error('Expected local terminal socket');
      local.send(new Uint8Array(1024 * 1024 + 1));

      expect((await servers.reverseCloses.next()).code).toBe(1009);
      expect(deleted).toBe(false);
    } finally {
      runtime.shutdown();
      servers.stop();
    }
  });
});
