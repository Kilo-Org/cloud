import { describe, expect, it, vi } from 'vitest';
import { SANDBOX_CONTROL_PROTOCOL_VERSION } from '../shared/sandbox-control-protocol.js';
import { createSandboxControlSocketHandler } from './socket.js';
import { createControlRequestWaiters } from './waiters.js';

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
  deserializeAttachment: () => unknown;
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
  let stored =
    typeof attachment === 'object' && attachment !== null && !('connectionId' in attachment)
      ? { ...attachment, connectionId: crypto.randomUUID() }
      : attachment;
  const socket: FakeWebSocket = {
    deserializeAttachment: vi.fn(() => stored),
    serializeAttachment: vi.fn((next: unknown) => {
      stored = next;
    }),
    send: vi.fn(),
    close: vi.fn(() => {
      socket.readyState = 2;
    }),
    readyState: 1,
  };
  return socket;
}

function asWs(ws: FakeWebSocket): WebSocket {
  return ws as unknown as WebSocket;
}

function helloFrame(
  providerInstanceId: string,
  wrapperInstanceId?: string,
  requestId = 'req_hello'
): string {
  return JSON.stringify({
    type: 'request',
    requestId,
    operation: 'sandbox.hello',
    payload: {
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId,
      ...(wrapperInstanceId ? { wrapperInstanceId } : {}),
    },
  });
}

const WRAPPER_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const REPLACEMENT_WRAPPER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

describe('sandbox control socket handler', () => {
  it('does not replace the current socket until sandbox.hello succeeds', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const incoming = createFakeWebSocket({ handshakeComplete: false, acceptedAt: Date.now() });
    const state = createFakeState([current, incoming]);
    const handler = createSandboxControlSocketHandler(state, 'sbx_test');

    await handler.handleMessage(
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

  it('replaces the previous handshaken socket after sandbox.hello and probes status', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const incoming = createFakeWebSocket({ handshakeComplete: false, acceptedAt: Date.now() });
    const state = createFakeState([current, incoming]);
    const handler = createSandboxControlSocketHandler(state, 'sbx_test');

    await handler.handleMessage(
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
      connectionId: expect.any(String),
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

  it('exposes the authenticated connection and wrapper identities', async () => {
    const incoming = createFakeWebSocket();
    const onHandshakeComplete = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([incoming]),
      'sbx_test',
      undefined,
      { onHandshakeComplete }
    );

    await handler.handleMessage(asWs(incoming), helloFrame('inst_1', WRAPPER_INSTANCE_ID));

    const identity = {
      connectionId: expect.any(String),
      providerInstanceId: 'inst_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    };
    expect(handler.getConnectionIdentity()).toEqual(identity);
    expect(incoming.deserializeAttachment()).toMatchObject({
      handshakeComplete: true,
      ...identity,
    });
    expect(onHandshakeComplete).toHaveBeenCalledWith(handler.getConnectionIdentity());
  });

  it('rejects duplicate hellos without replacing the current connection', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    const provisional = createFakeWebSocket();
    const handler = createSandboxControlSocketHandler(
      createFakeState([current, provisional]),
      'sbx_test'
    );
    const identity = handler.getConnectionIdentity();

    await handler.handleMessage(
      asWs(current),
      helloFrame('inst_replacement', REPLACEMENT_WRAPPER_INSTANCE_ID, 'req_duplicate')
    );

    expect(handler.getConnectionIdentity()).toEqual(identity);
    expect(current.close).not.toHaveBeenCalled();
    expect(provisional.close).not.toHaveBeenCalled();
    expect(current.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'response',
        requestId: 'req_duplicate',
        ok: false,
        error: {
          code: 'protocol_error',
          message: 'sandbox.hello requires an unconsumed provisional connection',
          retryable: false,
        },
      })
    );
  });

  it('ignores closing provisional hellos without replacing the current connection', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const incoming = createFakeWebSocket();
    incoming.readyState = 2;
    const onHandshakeComplete = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([current, incoming]),
      'sbx_test',
      undefined,
      { onHandshakeComplete }
    );

    await handler.handleMessage(asWs(incoming), helloFrame('inst_2', WRAPPER_INSTANCE_ID));

    expect(current.close).not.toHaveBeenCalled();
    expect(incoming.send).not.toHaveBeenCalled();
    expect(onHandshakeComplete).not.toHaveBeenCalled();
    expect(handler.getConnectionIdentity()).toMatchObject({ providerInstanceId: 'inst_1' });
  });

  it('rejects provisional hellos without an original connection identity', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const incoming = createFakeWebSocket({
      handshakeComplete: false,
      acceptedAt: Date.now(),
      connectionId: undefined,
    });
    const handler = createSandboxControlSocketHandler(
      createFakeState([current, incoming]),
      'sbx_test'
    );

    await handler.handleMessage(asWs(incoming), helloFrame('inst_2', WRAPPER_INSTANCE_ID));

    expect(current.close).not.toHaveBeenCalled();
    expect(incoming.close).toHaveBeenCalledWith(1008, 'invalid_handshake');
    expect(handler.getConnectionIdentity()).toMatchObject({ providerInstanceId: 'inst_1' });
  });

  it('rejects provisional sockets that share another connection identity', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const connectionId = crypto.randomUUID();
    const incoming = createFakeWebSocket({
      handshakeComplete: false,
      acceptedAt: Date.now(),
      connectionId,
    });
    const duplicate = createFakeWebSocket({
      handshakeComplete: false,
      acceptedAt: Date.now(),
      connectionId,
    });
    const handler = createSandboxControlSocketHandler(
      createFakeState([current, incoming, duplicate]),
      'sbx_test'
    );

    await handler.handleMessage(asWs(incoming), helloFrame('inst_2', WRAPPER_INSTANCE_ID));

    expect(incoming.close).toHaveBeenCalledWith(1008, 'invalid_handshake');
    expect(current.close).not.toHaveBeenCalled();
    expect(duplicate.close).not.toHaveBeenCalled();
    expect(handler.getConnectionIdentity()).toMatchObject({ providerInstanceId: 'inst_1' });
  });

  it('revokes superseded provisional identities before closing their sockets', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const incoming = createFakeWebSocket();
    const superseded = createFakeWebSocket();
    const handler = createSandboxControlSocketHandler(
      createFakeState([current, incoming, superseded]),
      'sbx_test'
    );

    await handler.handleMessage(asWs(incoming), helloFrame('inst_2', WRAPPER_INSTANCE_ID));

    expect(superseded.deserializeAttachment()).toEqual({
      handshakeComplete: false,
      acceptedAt: expect.any(Number),
    });
    expect(superseded.close).toHaveBeenCalledWith(1008, 'handshake_required');

    superseded.readyState = 1;
    await handler.handleMessage(
      asWs(superseded),
      helloFrame('inst_stale', REPLACEMENT_WRAPPER_INSTANCE_ID, 'req_stale')
    );

    expect(incoming.close).not.toHaveBeenCalled();
    expect(handler.getConnectionIdentity()).toMatchObject({
      providerInstanceId: 'inst_2',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
  });

  it('activates the replacement identity before exposing handshake or readiness', async () => {
    const incoming = createFakeWebSocket();
    let finishActivation: (() => void) | undefined;
    const activation = new Promise<void>(resolve => {
      finishActivation = resolve;
    });
    const onHandshakeComplete = vi.fn(() => activation);
    const onReady = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([incoming]),
      'sbx_test',
      undefined,
      { onHandshakeComplete, onReady }
    );
    const pending = handler.handleMessage(
      asWs(incoming),
      helloFrame('inst_1', WRAPPER_INSTANCE_ID)
    );

    expect(onHandshakeComplete).toHaveBeenCalledWith(handler.getConnectionIdentity());
    expect(incoming.send).not.toHaveBeenCalled();

    await handler.handleMessage(
      asWs(incoming),
      JSON.stringify({
        type: 'event',
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      })
    );
    expect(onReady).not.toHaveBeenCalled();

    finishActivation?.();
    await pending;

    expect(incoming.send).toHaveBeenCalledTimes(2);
    await handler.handleMessage(
      asWs(incoming),
      JSON.stringify({
        type: 'event',
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      })
    );
    expect(onReady).toHaveBeenCalledWith(handler.getConnectionIdentity());
  });

  it('does not acknowledge an activation superseded by a newer connection', async () => {
    const first = createFakeWebSocket();
    const sockets = [first];
    const firstAttachment = first.deserializeAttachment() as { connectionId: string };
    let finishActivation: (() => void) | undefined;
    const activation = new Promise<void>(resolve => {
      finishActivation = resolve;
    });
    const onHandshakeComplete = vi.fn((identity: { connectionId: string }) =>
      identity.connectionId === firstAttachment.connectionId ? activation : undefined
    );
    const handler = createSandboxControlSocketHandler(
      createFakeState(sockets),
      'sbx_test',
      undefined,
      { onHandshakeComplete }
    );
    const firstHandshake = handler.handleMessage(
      asWs(first),
      helloFrame('inst_1', WRAPPER_INSTANCE_ID, 'req_first')
    );
    const second = createFakeWebSocket();
    sockets.push(second);

    await handler.handleMessage(
      asWs(second),
      helloFrame('inst_2', REPLACEMENT_WRAPPER_INSTANCE_ID, 'req_second')
    );
    finishActivation?.();
    await firstHandshake;

    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalledTimes(2);
    expect(handler.getConnectionIdentity()).toMatchObject({
      providerInstanceId: 'inst_2',
      wrapperInstanceId: REPLACEMENT_WRAPPER_INSTANCE_ID,
    });
  });

  it('rejects inbound sandbox.status after handshake as not implemented', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    await handler.handleMessage(
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

  it('closes a provisional socket that misses the hello deadline', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: false,
      acceptedAt: Date.now() - 11_000,
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    await handler.handleMessage(
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

  it('closes oversized frames with payload_too_large', async () => {
    const ws = createFakeWebSocket();
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    await handler.handleMessage(asWs(ws), 'x'.repeat(1 * 1024 * 1024 + 1));
    expect(ws.close).toHaveBeenCalledWith(1009, 'payload_too_large');
  });

  it('rejects inbound session.prompt with an invalid payload', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    await handler.handleMessage(
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

  it('keeps the expected runtime fence off the wire and settles the outbound request', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    const pending = handler.sendRequest({
      operation: 'sandbox.status',
      payload: {},
      expectedWrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    const sent = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as {
      requestId: string;
      operation: string;
    };
    expect(sent.operation).toBe('sandbox.status');
    expect(sent).not.toHaveProperty('expectedWrapperInstanceId');
    await handler.handleMessage(
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

  it('prevents provisional responses from settling current connection waiters', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const provisional = createFakeWebSocket();
    const waiters = createControlRequestWaiters();
    const handler = createSandboxControlSocketHandler(
      createFakeState([current, provisional]),
      'sbx_test',
      waiters
    );
    const pending = handler.sendRequest({ operation: 'sandbox.status', payload: {} });
    const request = JSON.parse(current.send.mock.calls[0]?.[0] as string) as { requestId: string };
    const response = JSON.stringify({
      type: 'response',
      requestId: request.requestId,
      ok: true,
      result: { healthy: true, state: 'idle', version: 'test' },
    });

    await handler.handleMessage(asWs(provisional), response);

    expect(waiters.pendingCount()).toBe(1);
    expect(provisional.close).toHaveBeenCalledWith(1008, 'handshake_required');
    await handler.handleMessage(asWs(current), response);
    await expect(pending).resolves.toMatchObject({ ok: true, requestId: request.requestId });
  });

  it('prevents replaced socket responses from settling replacement waiters', async () => {
    const previous = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    const incoming = createFakeWebSocket();
    const waiters = createControlRequestWaiters();
    const handler = createSandboxControlSocketHandler(
      createFakeState([previous, incoming]),
      'sbx_test',
      waiters
    );
    await handler.handleMessage(
      asWs(incoming),
      helloFrame('inst_2', REPLACEMENT_WRAPPER_INSTANCE_ID)
    );
    const pending = handler.sendRequest({ operation: 'sandbox.status', payload: {} });
    const request = JSON.parse(incoming.send.mock.calls[2]?.[0] as string) as { requestId: string };
    const response = JSON.stringify({
      type: 'response',
      requestId: request.requestId,
      ok: true,
      result: { healthy: true, state: 'idle', version: 'test' },
    });

    previous.readyState = 1;
    await handler.handleMessage(asWs(previous), response);

    expect(waiters.pendingCount()).toBe(1);
    expect(handler.getConnectionIdentity()).toMatchObject({
      wrapperInstanceId: REPLACEMENT_WRAPPER_INSTANCE_ID,
    });
    await handler.handleMessage(asWs(incoming), response);
    await expect(pending).resolves.toMatchObject({ ok: true, requestId: request.requestId });
  });

  it('rejects stale readiness, heartbeat, and session events before their hooks', async () => {
    const previous = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    const incoming = createFakeWebSocket();
    const hooks = {
      onReady: vi.fn(),
      onHeartbeat: vi.fn(),
      onSessionEvent: vi.fn(),
      onSessionPreparing: vi.fn(),
    };
    const handler = createSandboxControlSocketHandler(
      createFakeState([previous, incoming]),
      'sbx_test',
      undefined,
      hooks
    );
    await handler.handleMessage(
      asWs(incoming),
      helloFrame('inst_2', REPLACEMENT_WRAPPER_INSTANCE_ID)
    );
    const events = [
      {
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      },
      {
        event: 'sandbox.heartbeat',
        payload: { state: 'idle', kilo: { ready: true }, sessions: [] },
      },
      {
        event: 'session.event',
        session: { directory: '/workspace/a', kiloSessionId: 'kilo_1' },
        payload: { type: 'message.updated', properties: { id: 'msg_1' } },
      },
      {
        event: 'session.preparing',
        session: { directory: '/workspace/a', kiloSessionId: 'kilo_1' },
        payload: {
          version: 2,
          attemptId: 'att_1',
          triggerMessageId: 'msg_1',
          revision: 1,
          timestamp: 10,
          step: 'cloning',
          message: 'Cloning repository',
          action: 'step_started',
        },
      },
    ];

    for (const event of events) {
      previous.readyState = 1;
      await handler.handleMessage(asWs(previous), JSON.stringify({ type: 'event', ...event }));
    }

    expect(hooks.onReady).not.toHaveBeenCalled();
    expect(hooks.onHeartbeat).not.toHaveBeenCalled();
    expect(hooks.onSessionEvent).not.toHaveBeenCalled();
    expect(hooks.onSessionPreparing).not.toHaveBeenCalled();
    expect(handler.getConnectionIdentity()).toMatchObject({
      wrapperInstanceId: REPLACEMENT_WRAPPER_INSTANCE_ID,
    });
  });

  it('rejects stale authenticated requests before responding or changing authority', async () => {
    const stale = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      connectionId: undefined,
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_stale',
    });
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_current',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    const handler = createSandboxControlSocketHandler(
      createFakeState([stale, current]),
      'sbx_test'
    );

    await handler.handleMessage(
      asWs(stale),
      JSON.stringify({
        type: 'request',
        requestId: 'req_stale',
        operation: 'sandbox.status',
        payload: {},
      })
    );

    expect(stale.send).not.toHaveBeenCalled();
    expect(stale.close).toHaveBeenCalledWith(1008, 'stale_connection');
    expect(current.close).not.toHaveBeenCalled();
    expect(handler.getConnectionIdentity()).toMatchObject({ providerInstanceId: 'inst_current' });
  });

  it('passes the authoritative connection identity to heartbeat hooks', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    const onHeartbeat = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([current]),
      'sbx_test',
      undefined,
      { onHeartbeat }
    );
    const payload = { state: 'idle', kilo: { ready: true }, sessions: [] };

    await handler.handleMessage(
      asWs(current),
      JSON.stringify({ type: 'event', event: 'sandbox.heartbeat', payload })
    );

    expect(onHeartbeat).toHaveBeenCalledWith(payload, handler.getConnectionIdentity());
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
    await handler.handleClose(asWs(ws));
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
      { type: 'message.updated', properties: { id: 'msg_1' } },
      handler.getConnectionIdentity()
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
      payload,
      handler.getConnectionIdentity()
    );
  });

  it('reports the identity when the authoritative connection closes', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    const onSocketClosed = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([current]),
      'sbx_test',
      undefined,
      { onSocketClosed }
    );
    const identity = handler.getConnectionIdentity();
    current.readyState = 3;

    await handler.handleClose(asWs(current));

    expect(onSocketClosed).toHaveBeenCalledWith(true, identity);
    expect(handler.getConnectionIdentity()).toBeNull();
  });

  it('preserves wrapper identity across reconnects and ignores replaced socket closes', async () => {
    const previous = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    const incoming = createFakeWebSocket();
    const waiters = createControlRequestWaiters();
    const onHandshakeComplete = vi.fn();
    const onSocketClosed = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([previous, incoming]),
      'sbx_test',
      waiters,
      { onHandshakeComplete, onSocketClosed }
    );
    const previousIdentity = handler.getConnectionIdentity();

    await handler.handleMessage(asWs(incoming), helloFrame('inst_1', WRAPPER_INSTANCE_ID));

    const currentIdentity = handler.getConnectionIdentity();
    expect(currentIdentity).toMatchObject({
      providerInstanceId: 'inst_1',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    expect(currentIdentity?.connectionId).not.toBe(previousIdentity?.connectionId);
    expect(onHandshakeComplete).toHaveBeenCalledWith(currentIdentity);

    const pending = handler.sendRequest({ operation: 'sandbox.status', payload: {} });
    const request = JSON.parse(incoming.send.mock.calls[2]?.[0] as string) as { requestId: string };
    await handler.handleClose(asWs(previous));

    expect(onSocketClosed).not.toHaveBeenCalled();
    expect(waiters.pendingCount()).toBe(1);
    await handler.handleMessage(
      asWs(incoming),
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: true,
        result: { healthy: true, state: 'idle', version: 'test' },
      })
    );
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('reconstructs the open authoritative connection without relying on timestamps', () => {
    const acceptedAt = Date.now();
    const closing = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt,
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_old',
      wrapperInstanceId: WRAPPER_INSTANCE_ID,
    });
    closing.readyState = 2;
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt,
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_current',
      wrapperInstanceId: REPLACEMENT_WRAPPER_INSTANCE_ID,
    });
    const state = createFakeState([current, closing]);
    const initial = createSandboxControlSocketHandler(state, 'sbx_test').getConnectionIdentity();
    const reconstructed = createSandboxControlSocketHandler(state, 'sbx_test');

    expect(reconstructed.getConnectionIdentity()).toEqual(initial);
    expect(reconstructed.getConnectionIdentity()).toMatchObject({
      providerInstanceId: 'inst_current',
      wrapperInstanceId: REPLACEMENT_WRAPPER_INSTANCE_ID,
    });
  });

  it('upgrades one legacy handshaken attachment with a unique connection identity', () => {
    const legacy = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      connectionId: undefined,
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_legacy',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([legacy]), 'sbx_test');

    const identity = handler.getConnectionIdentity();

    expect(identity).toEqual({
      connectionId: expect.any(String),
      providerInstanceId: 'inst_legacy',
    });
    expect(legacy.serializeAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        handshakeComplete: true,
        connectionId: identity?.connectionId,
      })
    );
  });

  it('fails closed when multiple legacy attachments cannot establish authority', async () => {
    const acceptedAt = Date.now();
    const first = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt,
      connectionId: undefined,
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_1',
    });
    const second = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt,
      connectionId: undefined,
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_2',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([first, second]), 'sbx_test');

    expect(handler.getConnectionIdentity()).toBeNull();
    expect(handler.hasHandshakenSocket()).toBe(false);
    expect(first.serializeAttachment).not.toHaveBeenCalled();
    expect(second.serializeAttachment).not.toHaveBeenCalled();
    await expect(handler.sendRequest({ operation: 'sandbox.status', payload: {} })).rejects.toThrow(
      'No ready wrapper socket'
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
    await handler.handleMessage(
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
