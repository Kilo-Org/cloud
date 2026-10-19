import { describe, expect, it, vi } from 'vitest';
import type {
  ControlPlaneKiloRequestFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import { createControlPlaneKiloRequests } from './kilo-requests.js';
import type { WrapperKiloClient } from '../kilo-api.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const KILO_SESSION_ID = 'ses_12345678901234567890123456';
const DIRECTORY = '/workspace/private/root';

function frame(operation: ControlPlaneKiloRequestFrame['operation']): ControlPlaneKiloRequestFrame {
  return {
    type: 'kilo.request',
    requestId: 'req_1',
    session: { sessionId: SESSION_ID, kiloSessionId: KILO_SESSION_ID, directory: DIRECTORY },
    operation,
  };
}

function client(overrides: Partial<WrapperKiloClient> = {}): WrapperKiloClient {
  return {
    getSessionDetails: vi.fn(async () => ({ id: KILO_SESSION_ID })),
    getRecentSessionMessages: vi.fn(async () => []),
    getSessionStatuses: vi.fn(async () => ({})),
    getQuestions: vi.fn(async () => []),
    getPermissions: vi.fn(async () => []),
    getSessionTodos: vi.fn(async () => []),
    getSessionDiff: vi.fn(async () => []),
    ...overrides,
  } as unknown as WrapperKiloClient;
}

function harness(nativeClient: WrapperKiloClient | null, route = true) {
  const emitted: ControlPlaneWrapperFrame[] = [];
  const handler = createControlPlaneKiloRequests({
    emit: emittedFrame => emitted.push(emittedFrame),
    preparedRoute: () => (route ? { runtimeKey: 'runtime_1', directory: DIRECTORY } : null),
    clientFor: () => nativeClient,
  });
  return { emitted, handler };
}

describe('control-plane native reads', () => {
  it('reads the requested native session through the prepared runtime', async () => {
    const nativeClient = client();
    const { emitted, handler } = harness(nativeClient);
    await handler.handle(frame({ name: 'session.todo' }));
    expect(nativeClient.getSessionTodos).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      DIRECTORY,
      expect.anything()
    );
    expect(emitted).toEqual([{ type: 'kilo.result', requestId: 'req_1', ok: true, result: [] }]);
  });

  it('scopes pending questions to the requested session', async () => {
    const nativeClient = client({
      getQuestions: vi.fn(async () => [
        { id: 'q1', sessionID: KILO_SESSION_ID },
        { id: 'q2', sessionID: 'ses_sibling_session_identifier_0' },
      ]) as never,
    });
    const { emitted, handler } = harness(nativeClient);
    await handler.handle(frame({ name: 'question.list' }));
    expect(emitted).toEqual([
      {
        type: 'kilo.result',
        requestId: 'req_1',
        ok: true,
        result: [{ id: 'q1', sessionID: KILO_SESSION_ID }],
      },
    ]);
  });

  it('refuses a route that is not prepared instead of starting one', async () => {
    const { emitted, handler } = harness(client(), false);
    await handler.handle(frame({ name: 'session.get' }));
    expect(emitted).toEqual([
      {
        type: 'kilo.result',
        requestId: 'req_1',
        ok: false,
        error: {
          code: 'not_ready',
          message: 'Session directory is not attached',
          retryable: false,
        },
      },
    ]);
  });

  it('always answers exactly once when the native client fails', async () => {
    const { emitted, handler } = harness(
      client({ getSessionStatuses: vi.fn(async () => Promise.reject(new Error('boom'))) as never })
    );
    await handler.handle(frame({ name: 'session.status' }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'kilo.result', ok: false });
  });

  it('bounds a message window to the requested limit', async () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({ info: { id: `m${index}` } }));
    const nativeClient = client({
      getRecentSessionMessages: vi.fn(async () => messages) as never,
    });
    const { emitted, handler } = harness(nativeClient);
    await handler.handle(frame({ name: 'session.messages', limit: 2 }));
    expect(emitted[0]).toMatchObject({
      ok: true,
      result: [{ info: { id: 'm3' } }, { info: { id: 'm4' } }],
    });
  });
});
