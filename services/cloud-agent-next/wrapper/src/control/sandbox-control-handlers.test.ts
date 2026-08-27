import { describe, expect, it } from 'bun:test';
import type { WrapperKiloClient, WrapperPty } from '../kilo-api';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import {
  buildHeartbeatPayload,
  handleControlRequest,
  type HandlerDeps,
} from './sandbox-control-handlers';
import { ControlTerminalRuntimeError, type ControlTerminalRuntime } from './terminal-runtime';

const session = {
  sessionId: 'ses_1',
  kiloSessionId: 'kilo_1',
  directory: '/workspace',
};

function fakeKilo(overrides: Partial<WrapperKiloClient> = {}): WrapperKiloClient {
  return {
    getSession: async id => ({ id }),
    ensureSession: async () => undefined,
    sendPromptAsync: async () => {},
    sendCommand: async () => undefined,
    abortSession: async () => true,
    answerPermission: async () => true,
    answerQuestion: async () => true,
    rejectQuestion: async () => true,
    getSessionStatuses: async () => ({}),
    getQuestions: async () => [],
    getPermissions: async () => [],
    ...overrides,
  } as WrapperKiloClient;
}

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    kiloClient: fakeKilo(),
    version: '2.4.0',
    kiloReady: true,
    getStatus: () => ({ state: 'idle', pendingMessages: [] }),
    sessions: [],
    ...overrides,
  };
}

const pty: WrapperPty = {
  id: 'pty_1',
  title: 'Workspace terminal',
  command: '/bin/bash',
  args: [],
  cwd: session.directory,
  status: 'running',
  pid: 17,
};

function fakeTerminalRuntime(
  overrides: Partial<ControlTerminalRuntime> = {}
): ControlTerminalRuntime {
  return {
    rememberAttachedSession: () => {},
    detachSession: async () => {},
    create: async () => ({ pty }),
    resize: async () => ({ pty }),
    close: async () => ({ success: true }),
    connect: async () => ({ connected: true }),
    shutdown: () => {},
    ...overrides,
  };
}

describe('handleControlRequest', () => {
  it('returns sandbox.status from deps', async () => {
    const result = await handleControlRequest('sandbox.status', undefined, {}, deps());
    expect(result).toEqual({
      ok: true,
      result: {
        healthy: true,
        state: 'idle',
        version: '2.4.0',
        kiloReady: true,
      },
    });
  });

  it('calls sendPromptAsync with kiloSessionId and messageId', async () => {
    const calls: unknown[] = [];
    const kiloClient = fakeKilo({
      sendPromptAsync: async opts => {
        calls.push(opts);
      },
    });

    const result = await handleControlRequest(
      'session.prompt',
      session,
      {
        messageId: 'msg_1',
        turn: { type: 'prompt', prompt: 'hello' },
        agent: { mode: 'architect', model: 'kilo/example', variant: 'high' },
      },
      deps({ kiloClient })
    );

    expect(result).toEqual({ ok: true, result: { messageId: 'msg_1', status: 'accepted' } });
    expect(calls).toEqual([
      {
        sessionId: 'kilo_1',
        messageId: 'msg_1',
        prompt: 'hello',
        agent: 'architect',
        model: { providerID: 'kilo', modelID: 'kilo/example' },
        variant: 'high',
      },
    ]);
  });

  it('calls sendCommand with the structured command and messageId', async () => {
    const commands: unknown[] = [];
    const prompts: unknown[] = [];
    const kiloClient = fakeKilo({
      sendCommand: async opts => {
        commands.push(opts);
      },
      sendPromptAsync: async opts => {
        prompts.push(opts);
      },
    });

    const result = await handleControlRequest(
      'session.prompt',
      session,
      {
        messageId: 'msg_command',
        turn: { type: 'command', command: 'review', arguments: '--all changes' },
        agent: { mode: 'architect', model: 'kilo/example', variant: 'high' },
      },
      deps({ kiloClient })
    );

    expect(result).toEqual({ ok: true, result: { messageId: 'msg_command', status: 'accepted' } });
    expect(commands).toEqual([
      {
        sessionId: 'kilo_1',
        command: 'review',
        args: '--all changes',
        messageId: 'msg_command',
        agent: 'architect',
        model: { providerID: 'kilo', modelID: 'kilo/example' },
        variant: 'high',
      },
    ]);
    expect(prompts).toEqual([]);
  });

  it('preserves command model omission with agent and variant', async () => {
    const commands: unknown[] = [];
    const kiloClient = fakeKilo({
      sendCommand: async opts => {
        commands.push(opts);
      },
    });

    const result = await handleControlRequest(
      'session.prompt',
      session,
      {
        messageId: 'msg_command',
        turn: { type: 'command', command: 'review', arguments: '' },
        agent: { mode: 'reviewer', variant: 'high' },
      },
      deps({ kiloClient })
    );

    expect(result).toEqual({
      ok: true,
      result: { messageId: 'msg_command', status: 'accepted' },
    });
    expect(commands).toEqual([
      {
        sessionId: 'kilo_1',
        command: 'review',
        args: '',
        messageId: 'msg_command',
        agent: 'reviewer',
        variant: 'high',
      },
    ]);
  });

  it('rejects a missing prompt model before calling Kilo', async () => {
    const calls: unknown[] = [];
    const kiloClient = fakeKilo({
      sendPromptAsync: async opts => {
        calls.push(opts);
      },
      sendCommand: async opts => {
        calls.push(opts);
      },
    });

    const result = await handleControlRequest(
      'session.prompt',
      session,
      {
        messageId: 'msg_1',
        turn: { type: 'prompt', prompt: 'hello' },
        agent: { mode: 'code' },
      },
      deps({ kiloClient })
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'Invalid payload', retryable: false },
    });
    expect(calls).toEqual([]);
  });

  it('returns protocol_error for session.prompt without session', async () => {
    const result = await handleControlRequest(
      'session.prompt',
      undefined,
      {
        messageId: 'msg_1',
        turn: { type: 'prompt', prompt: 'hello' },
        agent: { mode: 'code', model: 'kilo-model' },
      },
      deps()
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'session identity is required', retryable: false },
    });
  });

  it('attaches by verifying the kilo session', async () => {
    const result = await handleControlRequest('session.attach', session, {}, deps());
    expect(result).toEqual({ ok: true, result: { attached: true } });
  });

  it('registers terminal eligibility only after successful session attachment', async () => {
    const attached: unknown[] = [];
    const terminalRuntime = fakeTerminalRuntime({
      rememberAttachedSession: identity => attached.push(identity),
    });

    const request = handleControlRequest('session.attach', session, {}, deps({ terminalRuntime }));
    expect(attached).toEqual([]);

    expect(await request).toEqual({ ok: true, result: { attached: true } });
    expect(attached).toEqual([session]);

    const failed = await handleControlRequest(
      'session.attach',
      { ...session, sessionId: 'ses_missing', kiloSessionId: 'kilo_missing' },
      {},
      deps({ kiloClient: undefined, terminalRuntime })
    );
    expect(failed.ok).toBe(false);
    expect(attached).toEqual([session]);
  });

  it('keeps mismatched attachment roots ineligible without breaking chat attachment', async () => {
    const attached: unknown[] = [];
    const terminalRuntime = fakeTerminalRuntime({
      rememberAttachedSession: identity => attached.push(identity),
    });

    const result = await handleControlRequest(
      'session.attach',
      session,
      { snapshotIdentity: 'kilo_other' },
      deps({ terminalRuntime })
    );

    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(attached).toEqual([]);
  });

  it('keeps mismatched attachment directories ineligible without breaking chat attachment', async () => {
    const attached: unknown[] = [];
    const terminalRuntime = fakeTerminalRuntime({
      rememberAttachedSession: identity => attached.push(identity),
    });

    const result = await handleControlRequest(
      'session.attach',
      session,
      { directory: '/workspace/different' },
      deps({ terminalRuntime })
    );

    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(attached).toEqual([]);
  });

  it('rejects reserved control environment values before attachment starts', async () => {
    let kiloRequests = 0;
    const kiloClient = fakeKilo({
      getSession: async id => {
        kiloRequests += 1;
        return { id };
      },
    });

    for (const name of CONTROL_RUNTIME_RESERVED_ENV_VARS) {
      const result = await handleControlRequest(
        'session.attach',
        session,
        { env: { [name]: 'sensitive-value' } },
        deps({ kiloClient })
      );
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'protocol_error',
          message: 'Reserved control runtime environment variable',
          retryable: false,
        },
      });
    }

    expect(kiloRequests).toBe(0);
  });

  it('resolves a pending permission', async () => {
    const answered: unknown[] = [];
    const kiloClient = fakeKilo({
      answerPermission: async (permissionId, response) => {
        answered.push({ permissionId, response });
        return true;
      },
    });

    const result = await handleControlRequest(
      'session.permission.resolve',
      session,
      { permissionId: 'perm_1', response: 'once' },
      deps({ kiloClient })
    );
    expect(result).toEqual({ ok: true, result: { success: true } });
    expect(answered).toEqual([{ permissionId: 'perm_1', response: 'once' }]);
  });

  it('aborts the kilo session', async () => {
    const aborted: string[] = [];
    const kiloClient = fakeKilo({
      abortSession: async opts => {
        aborted.push(opts.sessionId);
        return true;
      },
    });

    const result = await handleControlRequest('session.abort', session, {}, deps({ kiloClient }));
    expect(result).toEqual({ ok: true, result: { status: 'aborted' } });
    expect(aborted).toEqual(['kilo_1']);
  });

  it('routes validated terminal lifecycle requests to the exact session', async () => {
    const calls: Array<{ operation: string; identity: unknown; payload: unknown }> = [];
    const terminalRuntime = fakeTerminalRuntime({
      create: async (identity, payload) => {
        calls.push({ operation: 'create', identity, payload });
        return { pty };
      },
      resize: async (identity, payload) => {
        calls.push({ operation: 'resize', identity, payload });
        return { pty };
      },
      close: async (identity, payload) => {
        calls.push({ operation: 'close', identity, payload });
        return { success: true };
      },
      connect: async (identity, payload) => {
        calls.push({ operation: 'connect', identity, payload });
        return { connected: true };
      },
    });
    const createPayload = {
      operationId: '00000000-0000-4000-8000-000000000001',
      cols: 120,
      rows: 35,
    };
    const resizePayload = { ptyId: pty.id, cols: 100, rows: 30 };
    const closePayload = { ptyId: pty.id };
    const connectPayload = {
      ownerId: 'oauth/google:account%2Fsegment',
      ptyId: pty.id,
      bridgeGeneration: '00000000-0000-4000-8000-000000000002',
      capability: 'a'.repeat(64),
    };
    const handlerDeps = deps({ terminalRuntime });

    expect(
      await handleControlRequest('session.terminal.create', session, createPayload, handlerDeps)
    ).toEqual({ ok: true, result: { pty } });
    expect(
      await handleControlRequest('session.terminal.resize', session, resizePayload, handlerDeps)
    ).toEqual({ ok: true, result: { pty } });
    expect(
      await handleControlRequest('session.terminal.close', session, closePayload, handlerDeps)
    ).toEqual({ ok: true, result: { success: true } });
    expect(
      await handleControlRequest('session.terminal.connect', session, connectPayload, handlerDeps)
    ).toEqual({ ok: true, result: { connected: true } });
    expect(calls).toEqual([
      { operation: 'create', identity: session, payload: createPayload },
      { operation: 'resize', identity: session, payload: resizePayload },
      { operation: 'close', identity: session, payload: closePayload },
      { operation: 'connect', identity: session, payload: connectPayload },
    ]);
  });

  it('rejects malformed terminal payloads and caller-controlled destinations', async () => {
    const terminalRuntime = fakeTerminalRuntime();
    const invalidPayloads: Array<[string, unknown]> = [
      ['session.terminal.create', { operationId: 'not-a-uuid', cols: 120, rows: 30 }],
      [
        'session.terminal.create',
        { operationId: '00000000-0000-4000-8000-000000000001', cols: 120 },
      ],
      ['session.terminal.resize', { ptyId: '../other', cols: 120, rows: 30 }],
      ['session.terminal.resize', { ptyId: pty.id, cols: 501, rows: 30 }],
      ['session.terminal.close', { ptyId: pty.id, unexpected: true }],
      [
        'session.terminal.connect',
        {
          ownerId: 'owner',
          ptyId: pty.id,
          bridgeGeneration: '00000000-0000-4000-8000-000000000002',
          capability: 'a'.repeat(64),
          url: 'wss://untrusted.example/steal',
        },
      ],
    ];

    for (const [operation, payload] of invalidPayloads) {
      expect(
        await handleControlRequest(operation, session, payload, deps({ terminalRuntime }))
      ).toEqual({
        ok: false,
        error: { code: 'protocol_error', message: 'Invalid payload', retryable: false },
      });
    }
  });

  it('returns safe terminal ownership errors without leaking unexpected failures', async () => {
    const payload = { ptyId: pty.id, cols: 100, rows: 30 };
    const ownedFailure = await handleControlRequest(
      'session.terminal.resize',
      session,
      payload,
      deps({
        terminalRuntime: fakeTerminalRuntime({
          resize: async () => {
            throw new ControlTerminalRuntimeError(
              'unauthorized',
              'Terminal ownership mismatch',
              false
            );
          },
        }),
      })
    );
    expect(ownedFailure).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'Terminal ownership mismatch', retryable: false },
    });

    const unexpectedFailure = await handleControlRequest(
      'session.terminal.resize',
      session,
      payload,
      deps({
        terminalRuntime: fakeTerminalRuntime({
          resize: async () => {
            throw new Error('sensitive-capability-value');
          },
        }),
      })
    );
    expect(unexpectedFailure).toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'Terminal request failed', retryable: false },
    });
  });

  it('rejects invalid terminal runtime results', async () => {
    const result = await handleControlRequest(
      'session.terminal.connect',
      session,
      {
        ownerId: 'owner',
        ptyId: pty.id,
        bridgeGeneration: '00000000-0000-4000-8000-000000000002',
        capability: 'a'.repeat(64),
      },
      deps({
        terminalRuntime: fakeTerminalRuntime({
          connect: async () => {
            const result: { connected: true } = { connected: true };
            Reflect.set(result, 'connected', false);
            return result;
          },
        }),
      })
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'Invalid terminal result', retryable: false },
    });
  });

  it('cleans up only the detached session and shuts down on sandbox shutdown', async () => {
    const detached: unknown[] = [];
    let shutdowns = 0;
    const terminalRuntime = fakeTerminalRuntime({
      detachSession: async identity => {
        detached.push(identity);
      },
      shutdown: () => {
        shutdowns += 1;
      },
    });

    expect(
      await handleControlRequest('session.detach', session, {}, deps({ terminalRuntime }))
    ).toEqual({ ok: true, result: { detached: true } });
    expect(
      await handleControlRequest('sandbox.shutdown', undefined, {}, deps({ terminalRuntime }))
    ).toEqual({ ok: true, result: { shuttingDown: true } });
    expect(detached).toEqual([session]);
    expect(shutdowns).toBe(1);
  });

  it('rejects terminal operations when the runtime is unavailable', async () => {
    const result = await handleControlRequest(
      'session.terminal.close',
      session,
      { ptyId: pty.id },
      deps()
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'Terminal is not available', retryable: false },
    });
  });

  it('rejects unknown operations', async () => {
    const result = await handleControlRequest('sandbox.nope', undefined, {}, deps());
    expect(result).toEqual({
      ok: false,
      error: { code: 'unknown_operation', message: 'Unknown operation', retryable: false },
    });
  });
});

describe('buildHeartbeatPayload', () => {
  it('includes kilo.ready and a sessions array', () => {
    const payload = buildHeartbeatPayload(
      deps({
        kiloReady: true,
        getStatus: () => ({ state: 'active', pendingMessages: ['msg_1'] }),
        sessions: [{ kiloSessionId: 'kilo_1', state: 'active', idleForMs: 12, waitingOn: 'model' }],
      })
    );
    expect(payload.kilo.ready).toBe(true);
    expect(payload.sessions).toEqual([
      { kiloSessionId: 'kilo_1', state: 'active', idleForMs: 12, waitingOn: 'model' },
    ]);
    expect(payload.state).toBe('active');
    expect(payload.pendingMessages).toBe(1);
  });
});
