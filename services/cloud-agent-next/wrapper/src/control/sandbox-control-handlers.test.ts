import { describe, expect, it } from 'bun:test';
import type { WrapperKiloClient } from '../kilo-api';
import {
  buildHeartbeatPayload,
  handleControlRequest,
  type HandlerDeps,
} from './sandbox-control-handlers';

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
        agent: { mode: 'code', model: 'kilo-model' },
      },
      deps({ kiloClient })
    );

    expect(result).toEqual({ ok: true, result: { messageId: 'msg_1', status: 'accepted' } });
    expect(calls).toEqual([
      {
        sessionId: 'kilo_1',
        messageId: 'msg_1',
        prompt: 'hello',
        agent: 'code',
        model: { modelID: 'kilo-model' },
      },
    ]);
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
