import { describe, expect, it, vi } from 'vitest';
import { SANDBOX_CONTROL_PROTOCOL_VERSION } from '../shared/sandbox-control-protocol.js';
import { createSandboxControlSocketHandler } from './socket.js';

vi.mock('../logger.js', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);
  return { logger };
});

type FakeWebSocket = {
  deserializeAttachment: ReturnType<typeof vi.fn>;
  serializeAttachment: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
};

function createFakeState(sockets: FakeWebSocket[] = []) {
  return {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue(sockets),
  } as unknown as DurableObjectState;
}

function createFakeWebSocket(
  attachment: unknown = { handshakeComplete: false, acceptedAt: Date.now() }
): FakeWebSocket {
  let stored = attachment;
  return {
    deserializeAttachment: vi.fn(() => stored),
    serializeAttachment: vi.fn((next: unknown) => {
      stored = next;
    }),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  };
}

function asWs(ws: FakeWebSocket): WebSocket {
  return ws as unknown as WebSocket;
}

describe('sandbox control socket handler', () => {
  it('does not replace the current socket until sandbox.hello succeeds', () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const incoming = createFakeWebSocket({ handshakeComplete: false, acceptedAt: Date.now() });
    const state = createFakeState([current, incoming]);
    const handler = createSandboxControlSocketHandler(state, 'sbx_test');

    handler.handleMessage(
      asWs(incoming),
      JSON.stringify({
        type: 'request',
        requestId: 'req_status',
        operation: 'sandbox.status',
        payload: {},
      })
    );

    expect(current.close).not.toHaveBeenCalled();
    expect(incoming.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'response',
        requestId: 'req_status',
        ok: false,
        error: {
          code: 'handshake_required',
          message: 'sandbox.hello is required first',
          retryable: false,
        },
      })
    );
  });

  it('replaces the previous handshaken socket after sandbox.hello and probes status', () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const incoming = createFakeWebSocket({ handshakeComplete: false, acceptedAt: Date.now() });
    const state = createFakeState([current, incoming]);
    const handler = createSandboxControlSocketHandler(state, 'sbx_test');

    handler.handleMessage(
      asWs(incoming),
      JSON.stringify({
        type: 'request',
        requestId: 'req_hello',
        operation: 'sandbox.hello',
        payload: { protocolVersion: 1, providerInstanceId: 'inst_1' },
      })
    );

    expect(incoming.serializeAttachment).toHaveBeenCalledWith({
      handshakeComplete: true,
      acceptedAt: expect.any(Number),
      protocolVersion: 1,
      providerInstanceId: 'inst_1',
    });
    expect(current.close).toHaveBeenCalledWith(4000, 'Replaced by new handshake');
    expect(incoming.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'response',
        requestId: 'req_hello',
        ok: true,
        result: { protocolVersion: 1, handshakeComplete: true },
      })
    );
    const statusFrame = JSON.parse(incoming.send.mock.calls[1]?.[0] as string) as {
      type: string;
      operation: string;
    };
    expect(statusFrame).toMatchObject({ type: 'request', operation: 'sandbox.status' });
  });

  it('rejects inbound sandbox.status after handshake as not implemented', () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'request',
        requestId: 'req_status',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'response',
        requestId: 'req_status',
        ok: false,
        error: { code: 'not_ready', message: 'Operation is not implemented', retryable: false },
      })
    );
  });

  it('closes a provisional socket that misses the hello deadline', () => {
    const ws = createFakeWebSocket({
      handshakeComplete: false,
      acceptedAt: Date.now() - 11_000,
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'request',
        requestId: 'req_late',
        operation: 'sandbox.hello',
        payload: { protocolVersion: 1, providerInstanceId: 'inst_1' },
      })
    );
    expect(ws.close).toHaveBeenCalledWith(1008, 'handshake_required');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('closes oversized frames with payload_too_large', () => {
    const ws = createFakeWebSocket();
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    handler.handleMessage(asWs(ws), 'x'.repeat(1 * 1024 * 1024 + 1));
    expect(ws.close).toHaveBeenCalledWith(1009, 'payload_too_large');
  });

  it('rejects inbound session.prompt with an invalid payload', () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'request',
        requestId: 'req_prompt',
        operation: 'session.prompt',
        session: { sessionId: 'ses_1', kiloSessionId: 'kilo_1', directory: '/workspace' },
        payload: { wrapperRunId: 'run_1' },
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'response',
        requestId: 'req_prompt',
        ok: false,
        error: {
          code: 'protocol_error',
          message: 'Invalid session.prompt payload',
          retryable: false,
        },
      })
    );
  });

  it('sends an outbound request and settles the waiter from the wrapper response', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    const pending = handler.sendRequest({ operation: 'sandbox.status', payload: {} });
    const sent = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as {
      requestId: string;
      operation: string;
    };
    expect(sent.operation).toBe('sandbox.status');
    handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'response',
        requestId: sent.requestId,
        ok: true,
        result: { healthy: true, state: 'idle', version: 'test' },
      })
    );
    await expect(pending).resolves.toMatchObject({ ok: true, requestId: sent.requestId });
  });

  it('rejects in-flight waiters when the current socket closes', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    const pending = handler.sendRequest({ operation: 'sandbox.status', payload: {} });
    handler.handleClose(asWs(ws));
    await expect(pending).rejects.toMatchObject({
      code: 'not_ready',
      message: 'Wrapper socket closed',
      retryable: true,
    });
  });

  it('closes only handshaken sockets', () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const provisional = createFakeWebSocket({ handshakeComplete: false, acceptedAt: Date.now() });
    const handler = createSandboxControlSocketHandler(
      createFakeState([current, provisional]),
      'sbx_test'
    );
    handler.closeHandshakenSockets(4002, 'heartbeat expired');
    expect(current.close).toHaveBeenCalledWith(4002, 'heartbeat expired');
    expect(provisional.close).not.toHaveBeenCalled();
  });

  it('dispatches session.event to the hook without blocking other sockets', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const onSessionEvent = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([ws]),
      'sbx_test',
      undefined,
      { onSessionEvent }
    );
    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'event',
        event: 'session.event',
        session: {
          directory: '/workspace/a',
          kiloSessionId: 'kilo_child',
          rootKiloSessionId: 'kilo_1',
        },
        payload: { type: 'message.updated', properties: { id: 'msg_1' } },
      })
    );
    expect(onSessionEvent).toHaveBeenCalledWith(
      { directory: '/workspace/a', kiloSessionId: 'kilo_child', rootKiloSessionId: 'kilo_1' },
      { type: 'message.updated', properties: { id: 'msg_1' } }
    );
  });

  it('does not dispatch a session.event with an invalid payload', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const onSessionEvent = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([ws]),
      'sbx_test',
      undefined,
      { onSessionEvent }
    );
    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'event',
        event: 'session.event',
        session: { directory: '/workspace/a' },
        payload: { event: 'message.updated' },
      })
    );
    expect(onSessionEvent).not.toHaveBeenCalled();
  });

  it('dispatches session.preparing to the hook', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const onSessionPreparing = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([ws]),
      'sbx_test',
      undefined,
      { onSessionPreparing }
    );
    const payload = {
      version: 2 as const,
      attemptId: 'att_1',
      triggerMessageId: 'msg_1',
      revision: 1,
      timestamp: 10,
      step: 'cloning',
      message: 'Cloning repository…',
      action: 'step_started',
      stepId: 'phase:cloning',
      kind: 'phase',
      label: 'cloning',
    };
    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'event',
        event: 'session.preparing',
        session: { directory: '/workspace/a', kiloSessionId: 'kilo_1' },
        payload,
      })
    );
    expect(onSessionPreparing).toHaveBeenCalledWith(
      { directory: '/workspace/a', kiloSessionId: 'kilo_1' },
      payload
    );
  });

  it('fails outbound requests when no handshaken socket exists', async () => {
    const handler = createSandboxControlSocketHandler(createFakeState([]), 'sbx_test');
    await expect(
      handler.sendRequest({ operation: 'sandbox.status', payload: {} })
    ).rejects.toMatchObject({
      code: 'not_ready',
      retryable: true,
    });
  });

  it('rejects in-flight waiters when a new handshake replaces the socket', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now() - 1_000,
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const incoming = createFakeWebSocket({ handshakeComplete: false, acceptedAt: Date.now() });
    const handler = createSandboxControlSocketHandler(
      createFakeState([current, incoming]),
      'sbx_test'
    );
    const pending = handler.sendRequest({ operation: 'sandbox.status', payload: {} });
    handler.handleMessage(
      asWs(incoming),
      JSON.stringify({
        type: 'request',
        requestId: 'req_hello',
        operation: 'sandbox.hello',
        payload: { protocolVersion: 1, providerInstanceId: 'inst_2' },
      })
    );
    expect(current.close).toHaveBeenCalledWith(4000, 'Replaced by new handshake');
    await expect(pending).rejects.toMatchObject({
      code: 'not_ready',
      message: 'Wrapper socket replaced',
      retryable: true,
    });
  });

  it('requires session identity for outbound session operations', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    await expect(
      handler.sendRequest({
        operation: 'session.prompt',
        payload: {
          messageId: 'msg_1',
          turn: { type: 'prompt', prompt: 'hi' },
          agent: { mode: 'code', model: 'kilo' },
        },
      })
    ).rejects.toThrow('session identity is required');
    expect(ws.send).not.toHaveBeenCalled();
  });
});
