import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
  SessionRequestIdentity,
  SessionTerminalConnectPayload,
  SessionTerminalCreatePayload,
} from '../../../src/shared/sandbox-control-protocol.js';
import { PNPM_STORE_DIR, PNPM_STORE_ENV_VAR } from '../../../src/shared/runtime-environment.js';
import type { WrapperKiloClient, WrapperPty } from '../kilo-api.js';
import type { WorktreeKiloRuntime } from './worktree-runtime.js';
import { createControlTerminalRuntime, type ControlTerminalRuntime } from './terminal-runtime.js';
import { rememberAttachedRoot, resetSessionDirectoryState } from './session-directories.js';

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
  const worktrees = new Map<string, WorktreeKiloRuntime>();
  const runtime = createControlTerminalRuntime({
    controlUrl,
    wrapperInstanceId,
    getKiloRuntime: identity => {
      const key = `${identity.sessionId}\0${identity.kiloSessionId}\0${identity.directory}`;
      let worktree = worktrees.get(key);
      if (!worktree) {
        worktree = {
          identity: { ...identity },
          scopeId: identity.directory,
          directory: identity.directory,
          env: { WORKTREE_VALUE: identity.directory },
          kiloClient,
          signal: new AbortController().signal,
        };
        worktrees.set(key, worktree);
      }
      return worktree;
    },
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

  it('creates an idempotent directory-scoped PTY with its worktree environment', async () => {
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
          WORKTREE_VALUE: firstSession.directory,
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

  it.each([secondSession, { ...secondSession, directory: firstSession.directory }])(
    'fences every PTY operation from a sibling in $directory',
    async secondSession => {
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
        await terminalFailure(
          runtime.resize(secondSession, { ptyId: 'pty_1', cols: 100, rows: 30 })
        )
      ).toMatchObject({ code: 'unauthorized', retryable: false });
      expect(await terminalFailure(runtime.close(secondSession, { ptyId: 'pty_1' }))).toMatchObject(
        {
          code: 'unauthorized',
          retryable: false,
        }
      );
      expect(
        await terminalFailure(runtime.connect(secondSession, connectionPayload({ ptyId: 'pty_1' })))
      ).toMatchObject({ code: 'unauthorized', retryable: false });
      expect(
        await terminalFailure(runtime.create(secondSession, creationPayload(firstOperationId)))
      ).toMatchObject({ code: 'idempotency_conflict', retryable: false });
      expect(
        await terminalFailure(
          runtime.resize(
            { ...firstSession, directory: '/workspace/unowned' },
            { ptyId: 'pty_1', cols: 100, rows: 30 }
          )
        )
      ).toMatchObject({ code: 'unauthorized', retryable: false });

      await runtime.detachSession(firstSession);
      expect(deleted).toEqual([{ ptyId: 'pty_1', directory: firstSession.directory }]);
      expect(await terminalFailure(runtime.create(firstSession, creationPayload()))).toMatchObject({
        code: 'not_ready',
        message: 'Terminal session is not attached',
      });

      expect(await runtime.resize(secondSession, { ptyId: 'pty_2', cols: 110, rows: 40 })).toEqual({
        pty: makePty(secondSession.directory, 'pty_2'),
      });
      expect(resized).toEqual([{ ptyId: 'pty_2', directory: secondSession.directory }]);
      attach(runtime, firstSession);
      expect(await runtime.create(firstSession, creationPayload(firstOperationId))).toEqual({
        pty: makePty(firstSession.directory, 'pty_3'),
      });
    }
  );

  it('fences all same-directory PTYs before waiting for pending creation and preserves another worktree', async () => {
    const sibling = { ...secondSession, directory: firstSession.directory };
    const unrelated = {
      ...secondSession,
      sessionId: 'workspace_other',
      kiloSessionId: 'kilo_other',
    };
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const deleted: Array<{ ptyId: string; directory?: string }> = [];
    let created = 0;
    const runtime = createRuntime(
      fakeKilo({
        createPty: async input => {
          const id = `pty_${++created}`;
          if (id === 'pty_3') {
            started.resolve();
            await release.promise;
          }
          return makePty(input.cwd, id);
        },
        deletePty: async (ptyId, directory) => {
          deleted.push({ ptyId, directory });
          return true;
        },
      })
    );
    for (const identity of [firstSession, sibling, unrelated]) attach(runtime, identity);
    await runtime.create(sibling, creationPayload(secondOperationId));
    await runtime.create(unrelated, creationPayload(crypto.randomUUID()));
    const creation = terminalFailure(
      runtime.create(firstSession, creationPayload(firstOperationId))
    );
    await started.promise;
    let settled = false;
    const detaching = runtime.detachDirectory(firstSession.directory).then(() => {
      settled = true;
    });
    try {
      expect(
        await terminalFailure(runtime.resize(sibling, { ptyId: 'pty_1', cols: 90, rows: 30 }))
      ).toMatchObject({ code: 'not_ready' });
      expect(await terminalFailure(runtime.create(firstSession, creationPayload()))).toMatchObject({
        code: 'not_ready',
      });
      expect(deleted).toEqual([{ ptyId: 'pty_1', directory: firstSession.directory }]);
      expect(settled).toBe(false);
      expect(await runtime.resize(unrelated, { ptyId: 'pty_2', cols: 90, rows: 30 })).toEqual({
        pty: makePty(unrelated.directory, 'pty_2'),
      });
      release.resolve();
      expect(await creation).toMatchObject({
        code: 'not_ready',
        message: 'Terminal session is no longer attached',
      });
      await detaching;
      expect(deleted).toEqual([
        { ptyId: 'pty_1', directory: firstSession.directory },
        { ptyId: 'pty_3', directory: firstSession.directory },
      ]);
      attach(runtime, sibling);
      expect(await runtime.create(sibling, creationPayload(secondOperationId))).toEqual({
        pty: makePty(sibling.directory, 'pty_4'),
      });
    } finally {
      release.resolve();
      await Promise.allSettled([creation, detaching]);
    }
  });

  it('keeps independent same-worktree roots eligible when a sibling detaches', async () => {
    const sibling = { ...secondSession, directory: firstSession.directory };
    let count = 0;
    const deleted: string[] = [];
    const runtime = createRuntime(
      fakeKilo({
        createPty: async input => makePty(input.cwd, `pty_${++count}`),
        deletePty: async id => {
          deleted.push(id);
          return true;
        },
      })
    );
    attach(runtime, firstSession);
    attach(runtime, sibling);
    await runtime.create(firstSession, creationPayload(firstOperationId));
    await runtime.create(sibling, creationPayload(secondOperationId));

    expect(await terminalFailure(runtime.close(sibling, { ptyId: 'pty_1' }))).toMatchObject({
      code: 'unauthorized',
    });
    await runtime.detachSession(sibling);
    expect(deleted).toEqual(['pty_2']);
    expect(await runtime.resize(firstSession, { ptyId: 'pty_1', cols: 100, rows: 30 })).toEqual({
      pty: makePty(firstSession.directory, 'pty_1'),
    });
    expect(await runtime.create(firstSession, creationPayload(firstOperationId))).toEqual({
      pty: makePty(firstSession.directory, 'pty_1'),
    });
  });

  it('rejects a same-directory sibling when lookup returns another root runtime', async () => {
    const sibling = { ...secondSession, directory: firstSession.directory };
    const firstRuntime: WorktreeKiloRuntime = {
      identity: { ...firstSession },
      directory: firstSession.directory,
      scopeId: firstSession.directory,
      env: { HOME: '/home/first', KILOCODE_TOKEN: 'first-token' },
      kiloClient: fakeKilo(),
      signal: new AbortController().signal,
    };
    const runtime = createControlTerminalRuntime({
      controlUrl: 'ws://127.0.0.1:1/sandbox-control/sandbox',
      wrapperInstanceId,
      getKiloRuntime: identity =>
        identity.directory === firstSession.directory ? firstRuntime : undefined,
    });
    activeRuntimes.add(runtime);

    attach(runtime, firstSession);
    expect(() => runtime.rememberAttachedSession(sibling)).toThrow(
      /Terminal session ownership mismatch/
    );
    expect(await runtime.create(firstSession, creationPayload())).toMatchObject({
      pty: { cwd: firstSession.directory },
    });
  });

  it('uses the owning worktree client and credentials for every PTY operation', async () => {
    const calls: Array<{ operation: string; directory: string; env?: Record<string, string> }> = [];
    const worktrees = new Map<string, WorktreeKiloRuntime>();
    for (const identity of [firstSession, secondSession]) {
      const directory = identity.directory;
      worktrees.set(identity.kiloSessionId, {
        identity: { ...identity },
        directory,
        scopeId: directory,
        env: { HOME: `/home/${identity.sessionId}`, KILOCODE_TOKEN: `guest-${identity.sessionId}` },
        signal: new AbortController().signal,
        kiloClient: fakeKilo({
          createPty: async input => {
            calls.push({ operation: 'create', directory, env: input.env });
            return makePty(input.cwd, `pty_${identity.sessionId}`);
          },
          resizePty: async (id, _size, cwd) => {
            calls.push({ operation: 'resize', directory });
            return makePty(cwd ?? '', id);
          },
          deletePty: async () => {
            calls.push({ operation: 'delete', directory });
            return true;
          },
        }),
      });
    }
    const runtime = createControlTerminalRuntime({
      controlUrl: 'ws://127.0.0.1:1/sandbox-control/sandbox',
      wrapperInstanceId,
      getKiloRuntime: identity => worktrees.get(identity.kiloSessionId),
    });
    activeRuntimes.add(runtime);
    attach(runtime, firstSession);
    attach(runtime, secondSession);

    for (const identity of [firstSession, secondSession]) {
      const created = await runtime.create(identity, creationPayload(crypto.randomUUID()));
      await runtime.resize(identity, { ptyId: created.pty.id, cols: 90, rows: 30 });
      await runtime.close(identity, { ptyId: created.pty.id });
      expect(calls.at(-3)).toMatchObject({
        operation: 'create',
        directory: identity.directory,
        env: worktrees.get(identity.kiloSessionId)?.env,
      });
      expect(calls.at(-3)?.env).not.toHaveProperty('SANDBOX_CONTROL_CREDENTIAL');
      expect(calls.slice(-2)).toEqual([
        { operation: 'resize', directory: identity.directory },
        { operation: 'delete', directory: identity.directory },
      ]);
    }

    worktrees.delete(firstSession.kiloSessionId);
    expect(
      await terminalFailure(runtime.create(firstSession, creationPayload(crypto.randomUUID())))
    ).toMatchObject({ code: 'not_ready', message: 'Kilo worktree is not available' });
  });

  it('compensates late PTY creation without disturbing a reattached session', async () => {
    const releaseCreation = Promise.withResolvers<void>();
    const deleted: Array<{ ptyId: string; directory?: string }> = [];
    let creations = 0;
    const kiloClient = fakeKilo({
      createPty: async input => {
        const id = ++creations;
        if (id === 1) await releaseCreation.promise;
        return makePty(input.cwd, `pty_${id}`);
      },
      deletePty: async (ptyId, directory) => {
        deleted.push({ ptyId, directory });
        return true;
      },
    });
    const runtime = createRuntime(kiloClient);
    attach(runtime, firstSession);

    const creation = runtime.create(firstSession, creationPayload());
    const failure = terminalFailure(creation);
    await Promise.resolve();
    const detached = runtime.detachSession(firstSession);
    try {
      attach(runtime, firstSession);
      const replacement = await runtime.create(firstSession, creationPayload());
      expect(replacement.pty.id).toBe('pty_2');
      releaseCreation.resolve();
      expect(await failure).toMatchObject({
        code: 'not_ready',
        message: 'Terminal session is no longer attached',
        retryable: false,
      });
      await detached;
      expect(deleted).toEqual([{ ptyId: 'pty_1', directory: firstSession.directory }]);
      expect(await runtime.create(firstSession, creationPayload())).toEqual(replacement);
      expect(await runtime.resize(firstSession, { ptyId: 'pty_2', cols: 100, rows: 30 })).toEqual({
        pty: makePty(firstSession.directory, 'pty_2'),
      });
    } finally {
      releaseCreation.resolve();
      await detached;
      await failure;
    }
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
  it('closes every bridge in a deleted directory without closing an unrelated worktree', async () => {
    const servers = createBridgeServers();
    const sibling = { ...secondSession, directory: firstSession.directory };
    const unrelated = {
      ...secondSession,
      sessionId: 'workspace_other',
      kiloSessionId: 'kilo_other',
    };
    let count = 0;
    const deleted: string[] = [];
    const runtime = createRuntime(
      fakeKilo({
        serverUrl: servers.localUrl,
        createPty: async input => makePty(input.cwd, `pty_${++count}`),
        deletePty: async id => {
          deleted.push(id);
          return true;
        },
      }),
      servers.controlUrl
    );
    try {
      for (const identity of [firstSession, sibling, unrelated]) {
        attach(runtime, identity);
        const { pty } = await runtime.create(identity, creationPayload(crypto.randomUUID()));
        await runtime.connect(identity, connectionPayload({ ptyId: pty.id }));
      }
      await runtime.detachDirectory(firstSession.directory);
      expect(deleted).toEqual(['pty_1', 'pty_2']);
      for (let index = 0; index < 2; index++) {
        expect((await servers.reverseCloses.next()).code).toBe(1000);
        expect((await servers.localCloses.next()).code).toBe(1000);
      }
      const unrelatedSocket = servers.reverseSockets[2];
      if (!unrelatedSocket) throw new Error('Expected unrelated bridge');
      unrelatedSocket.send('still connected');
      expect(await servers.localFrames.next()).toBe('still connected');
      expect(await servers.reverseFrames.next()).toBe('still connected');
    } finally {
      runtime.shutdown();
      servers.stop();
    }
  });

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

  it('connects each terminal bridge to its owning worktree server', async () => {
    const firstServers = createBridgeServers('first worktree');
    const secondServers = createBridgeServers('second worktree');
    const worktrees = new Map<string, WorktreeKiloRuntime>();
    for (const [identity, servers, id] of [
      [firstSession, firstServers, 'pty_first'],
      [secondSession, secondServers, 'pty_second'],
    ] as const) {
      worktrees.set(identity.kiloSessionId, {
        identity: { ...identity },
        scopeId: identity.directory,
        directory: identity.directory,
        env: {},
        signal: new AbortController().signal,
        kiloClient: fakeKilo({
          serverUrl: servers.localUrl,
          createPty: async input => makePty(input.cwd, id),
        }),
      });
    }
    const runtime = createControlTerminalRuntime({
      controlUrl: firstServers.controlUrl,
      wrapperInstanceId,
      getKiloRuntime: identity => worktrees.get(identity.kiloSessionId),
    });
    activeRuntimes.add(runtime);
    attach(runtime, firstSession);
    attach(runtime, secondSession);

    try {
      await runtime.create(firstSession, creationPayload(firstOperationId));
      await runtime.create(secondSession, creationPayload(secondOperationId));
      await runtime.connect(secondSession, connectionPayload({ ptyId: 'pty_second' }));
      expect(await firstServers.reverseFrames.next()).toBe('second worktree');
      expect(firstServers.localRequests).toEqual([]);
      expect(secondServers.localRequests[0]?.searchParams.get('directory')).toBe(
        secondSession.directory
      );
      await runtime.connect(firstSession, connectionPayload());
      expect(await firstServers.reverseFrames.next()).toBe('first worktree');
      expect(firstServers.localRequests[0]?.searchParams.get('directory')).toBe(
        firstSession.directory
      );
    } finally {
      runtime.shutdown();
      firstServers.stop();
      secondServers.stop();
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
