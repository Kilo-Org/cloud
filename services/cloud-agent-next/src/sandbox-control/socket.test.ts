import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  sandboxControlSocketAttachmentSchema,
  sandboxHeartbeatPayloadSchema,
  type SandboxHeartbeatPayload,
} from '../shared/sandbox-control-protocol.js';
import { createSandboxControlSocketHandler, readSandboxControlConnection } from './socket.js';
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
  serializeAttachment: ReturnType<typeof vi.fn<(attachment: unknown) => void>>;
  send: ReturnType<typeof vi.fn<(message: string) => void>>;
  close: ReturnType<typeof vi.fn<(code: number, reason: string) => void>>;
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
  requestId = 'req_hello',
  capabilities?: { nativeRuntimeRetirement?: boolean }
): string {
  return JSON.stringify({
    type: 'request',
    requestId,
    operation: 'sandbox.hello',
    payload: {
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId,
      ...(wrapperInstanceId ? { wrapperInstanceId } : {}),
      ...(capabilities ? { capabilities } : {}),
    },
  });
}

const WRAPPER_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const REPLACEMENT_WRAPPER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

describe('sandbox control socket handler', () => {
  it('accepts old heartbeats and ignores invalid optional versions without rejecting readiness', () => {
    const heartbeat = { state: 'idle', kilo: { ready: true }, sessions: [] };
    expect(sandboxHeartbeatPayloadSchema.parse(heartbeat)).toEqual(heartbeat);
    for (const version of ['7.4.20', null]) {
      expect(
        sandboxHeartbeatPayloadSchema.parse({ ...heartbeat, kilo: { ready: true, version } }).kilo
      ).toEqual({ ready: true, version });
    }
    for (const version of ['private-error', '7.4.20\n', { token: 'private' }]) {
      const parsed = sandboxHeartbeatPayloadSchema.parse({
        ...heartbeat,
        kilo: { ready: true, version },
      });
      expect(parsed.kilo.ready).toBe(true);
      expect(parsed.kilo.version).toBeUndefined();
      expect(JSON.stringify(parsed)).not.toContain('private');
    }
  });
  it.each([
    ['2.4.0', '2.4.0'],
    [undefined, null],
    ['https://private.invalid/error', null],
    ['2.4.0-private-instance', null],
  ])('retains only safe hello wrapper metadata: %s', async (wrapperVersion, expected) => {
    const incoming = createFakeWebSocket();
    const onHandshakeComplete = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([incoming]),
      'sbx_test',
      undefined,
      {
        validateHandshake: () => true,
        onHandshakeComplete,
      }
    );
    await handler.handleMessage(
      asWs(incoming),
      JSON.stringify({
        type: 'request',
        requestId: 'hello_metadata',
        operation: 'sandbox.hello',
        payload: {
          protocolVersion: 1,
          providerInstanceId: 'inst_1',
          wrapperInstanceId: WRAPPER_INSTANCE_ID,
          wrapperVersion,
        },
      })
    );
    expect(onHandshakeComplete).toHaveBeenCalledWith(handler.getConnectionIdentity(), {
      wrapperVersion: expected,
    });
    await handler.handleMessage(
      asWs(incoming),
      JSON.stringify({
        type: 'request',
        requestId: 'replayed_metadata',
        operation: 'sandbox.hello',
        payload: { protocolVersion: 1, providerInstanceId: 'inst_1', wrapperVersion: '9.9.9' },
      })
    );
    expect(onHandshakeComplete).toHaveBeenCalledTimes(1);
  });

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

  it('rejects an invalid provisional handshake without replacing the current valid socket', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
      providerInstanceId: 'inst_current',
    });
    const incoming = createFakeWebSocket({ handshakeComplete: false, acceptedAt: Date.now() });
    const validateHandshake = vi.fn(async () => false);
    const onHandshakeComplete = vi.fn();
    const handler = createSandboxControlSocketHandler(
      createFakeState([current, incoming]),
      'sbx_test',
      undefined,
      { validateHandshake, onHandshakeComplete }
    );
    const pending = handler.sendRequest({ operation: 'sandbox.status', payload: {} });
    const request = JSON.parse(current.send.mock.calls[0]?.[0] as string) as {
      requestId: string;
    };

    await handler.handleMessage(
      asWs(incoming),
      JSON.stringify({
        type: 'request',
        requestId: 'req_rejected',
        operation: 'sandbox.hello',
        payload: { protocolVersion: 1, providerInstanceId: 'inst_stale' },
      })
    );

    expect(validateHandshake).toHaveBeenCalledWith('inst_stale');
    expect(incoming.deserializeAttachment()).toMatchObject({
      handshakeComplete: false,
      kiloReady: false,
    });
    expect(incoming.close).toHaveBeenCalledWith(1008, 'invalid_provider_instance');
    expect(incoming.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'response',
        requestId: 'req_rejected',
        ok: false,
        error: {
          code: 'unauthorized',
          message: 'Invalid sandbox provider instance',
          retryable: false,
        },
      })
    );
    expect(current.close).not.toHaveBeenCalled();
    expect(onHandshakeComplete).not.toHaveBeenCalled();

    await handler.handleMessage(
      asWs(current),
      JSON.stringify({ type: 'response', requestId: request.requestId, ok: true })
    );
    await expect(pending).resolves.toMatchObject({ ok: true, requestId: request.requestId });
  });

  it.each([true, false])(
    'preserves the replacement connection when superseded provider validation resolves to %s',
    async valid => {
      const first = createFakeWebSocket();
      const sockets = [first];
      let finishValidation: ((valid: boolean) => void) | undefined;
      const validation = new Promise<boolean>(resolve => {
        finishValidation = resolve;
      });
      const onHandshakeComplete = vi.fn();
      const handler = createSandboxControlSocketHandler(
        createFakeState(sockets),
        'sbx_test',
        undefined,
        {
          validateHandshake: providerInstanceId =>
            providerInstanceId === 'inst_pending' ? validation : true,
          onHandshakeComplete,
        }
      );
      const pending = handler.handleMessage(
        asWs(first),
        helloFrame('inst_pending', WRAPPER_INSTANCE_ID, 'req_first')
      );
      const second = createFakeWebSocket();
      sockets.push(second);

      await handler.handleMessage(
        asWs(second),
        helloFrame('inst_current', REPLACEMENT_WRAPPER_INSTANCE_ID, 'req_second')
      );
      first.readyState = 1;
      finishValidation?.(valid);
      await pending;

      expect(first.send).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      expect(handler.getConnectionIdentity()).toMatchObject({
        providerInstanceId: 'inst_current',
        wrapperInstanceId: REPLACEMENT_WRAPPER_INSTANCE_ID,
      });
      expect(onHandshakeComplete).toHaveBeenCalledTimes(1);
    }
  );

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
      kiloReady: false,
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
        result: {
          protocolVersion: 1,
          handshakeComplete: true,
          capabilities: {
            kiloVersionHeartbeat: true,
            sessionOperationResults: true,
            scopedStopAbort: true,
            nativeRuntimeRetirement: true,
          },
        },
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
    expect(onHandshakeComplete).toHaveBeenCalledWith(handler.getConnectionIdentity(), {
      wrapperVersion: null,
    });
  });

  it('reads the native runtime retirement capability from the wrapper handshake', async () => {
    const incoming = createFakeWebSocket();
    const handler = createSandboxControlSocketHandler(createFakeState([incoming]), 'sbx_test');

    await handler.handleMessage(
      asWs(incoming),
      helloFrame('inst_1', WRAPPER_INSTANCE_ID, 'req_native_retirement', {
        nativeRuntimeRetirement: true,
      })
    );

    expect(handler.supportsNativeRuntimeRetirement()).toBe(true);
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
      kiloReady: false,
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

    expect(onHandshakeComplete).toHaveBeenCalledWith(handler.getConnectionIdentity(), {
      wrapperVersion: null,
    });
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
    expect(onHandshakeComplete).toHaveBeenCalledWith(currentIdentity, { wrapperVersion: null });

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

  it('requires readiness on the selected socket only for worktree captures', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      acceptedAt: Date.now(),
      providerInstanceId: 'inst_1',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    const capture = {
      operation: 'session.git.summary' as const,
      session: { sessionId: 'workspace_1', kiloSessionId: 'kilo_1', directory: '/workspace' },
      payload: { revision: 1 },
    };
    await expect(handler.sendRequest(capture)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_ready' },
    });
    expect(ws.send).not.toHaveBeenCalled();
    expect(handler.getReadySocket()).toBeNull();

    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'event',
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      })
    );
    expect(handler.getReadySocket()).toBe(ws);
    const pending = handler.sendRequest(capture);
    const sent = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'response', requestId: sent.requestId, ok: true })
    );
    await expect(pending).resolves.toMatchObject({ ok: true });

    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'event',
        event: 'sandbox.heartbeat',
        payload: { state: 'idle', kilo: { ready: false }, sessions: [] },
      })
    );
    expect(handler.getReadySocket()).toBeNull();
    await expect(handler.sendRequest(capture)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_ready' },
    });
    const status = handler.sendRequest({ operation: 'sandbox.status', payload: {} });
    const statusSent = JSON.parse(ws.send.mock.calls[1]?.[0] as string) as { requestId: string };
    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'response', requestId: statusSent.requestId, ok: true })
    );
    await expect(status).resolves.toMatchObject({ ok: true });
  });

  it('does not accept a response from a provisional or replaced socket', async () => {
    const current = createFakeWebSocket({
      handshakeComplete: true,
      kiloReady: true,
      acceptedAt: 1,
      providerInstanceId: 'inst_1',
    });
    const provisional = createFakeWebSocket({ handshakeComplete: false, acceptedAt: Date.now() });
    const sockets = [current, provisional];
    const waiters = createControlRequestWaiters();
    const handler = createSandboxControlSocketHandler(
      createFakeState(sockets),
      'sbx_test',
      waiters
    );
    const request = {
      operation: 'session.git.summary' as const,
      session: { sessionId: 'workspace_1', kiloSessionId: 'kilo_1', directory: '/workspace' },
      payload: { revision: 1 },
    };
    const pending = handler.sendRequest(request);
    const sent = JSON.parse(current.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await handler.handleMessage(
      asWs(provisional),
      JSON.stringify({ type: 'response', requestId: sent.requestId, ok: true })
    );
    expect(waiters.pendingCount()).toBe(1);
    expect(provisional.close).toHaveBeenCalledWith(1008, 'handshake_required');
    await handler.handleMessage(
      asWs(current),
      JSON.stringify({ type: 'response', requestId: sent.requestId, ok: true })
    );
    await expect(pending).resolves.toMatchObject({ ok: true });

    const replacement = createFakeWebSocket({ handshakeComplete: false, acceptedAt: Date.now() });
    sockets.push(replacement);
    await handler.handleMessage(
      asWs(replacement),
      JSON.stringify({
        type: 'request',
        requestId: 'hello_new',
        operation: 'sandbox.hello',
        payload: { protocolVersion: 1, providerInstanceId: 'inst_2' },
      })
    );
    expect(handler.getReadySocket()).toBeNull();
    await handler.handleMessage(
      asWs(current),
      JSON.stringify({
        type: 'event',
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      })
    );
    expect(handler.getReadySocket()).toBeNull();
    await expect(handler.sendRequest(request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_ready' },
    });

    await handler.handleMessage(
      asWs(replacement),
      JSON.stringify({
        type: 'event',
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      })
    );
    const replacementPending = handler.sendRequest(request);
    const replacementSent = JSON.parse(replacement.send.mock.calls.at(-1)?.[0] as string) as {
      requestId: string;
    };
    await handler.handleMessage(
      asWs(current),
      JSON.stringify({ type: 'response', requestId: replacementSent.requestId, ok: true })
    );
    expect(waiters.pendingCount()).toBe(1);
    await handler.handleMessage(
      asWs(replacement),
      JSON.stringify({ type: 'response', requestId: replacementSent.requestId, ok: true })
    );
    await expect(replacementPending).resolves.toMatchObject({ ok: true });
  });

  it('rejects a capture if readiness changes before its response is accepted', async () => {
    const ws = createFakeWebSocket({
      handshakeComplete: true,
      kiloReady: true,
      acceptedAt: Date.now(),
      providerInstanceId: 'inst_1',
    });
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    const pending = handler.sendRequest({
      operation: 'session.git.summary',
      session: { sessionId: 'workspace_1', kiloSessionId: 'kilo_1', directory: '/workspace' },
      payload: { revision: 1 },
    });
    const sent = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'event',
        event: 'sandbox.heartbeat',
        payload: { state: 'idle', kilo: { ready: false }, sessions: [] },
      })
    );
    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({ type: 'response', requestId: sent.requestId, ok: true })
    );
    await expect(pending).rejects.toThrow('Worktree capture connection changed');
  });
});

const now = 1_000_000;
const handshaken = {
  handshakeComplete: true,
  acceptedAt: now - 1_000,
  protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
  providerInstanceId: 'inst_1',
};
const idleHeartbeat: SandboxHeartbeatPayload = {
  state: 'idle',
  pendingMessages: 0,
  kilo: { ready: true },
  sessions: [{ kiloSessionId: 'kilo_1', state: 'idle', idleForMs: 0 }],
};
const readyFrame = JSON.stringify({
  type: 'event',
  event: 'sandbox.ready',
  payload: { kiloReady: true, globalFeedAttached: true },
});
const busyFrame = JSON.stringify({
  type: 'event',
  event: 'session.event',
  session: { directory: '/workspace/a', kiloSessionId: 'kilo_1' },
  payload: {
    type: 'session.status',
    properties: { sessionID: 'kilo_1', status: { type: 'busy' } },
  },
});
function heartbeatFrame(payload: SandboxHeartbeatPayload = idleHeartbeat) {
  return JSON.stringify({ type: 'event', event: 'sandbox.heartbeat', payload });
}
function statusHelloFrame() {
  return JSON.stringify({
    type: 'request',
    requestId: 'hello-observation',
    operation: 'sandbox.hello',
    payload: { protocolVersion: 1, providerInstanceId: 'inst_1' },
  });
}

function readTestConnection(
  state: Pick<DurableObjectState, 'getWebSockets'>,
  providerRef: string | null
) {
  const socket = state.getWebSockets().find(ws => {
    const parsed = sandboxControlSocketAttachmentSchema.safeParse(ws.deserializeAttachment());
    return ws.readyState === 1 && parsed.success && parsed.data.handshakeComplete;
  });
  const parsed = sandboxControlSocketAttachmentSchema.safeParse(socket?.deserializeAttachment());
  return readSandboxControlConnection(
    state,
    providerRef,
    parsed.success ? { ...parsed.data, readyConnectionId: parsed.data.connectionId } : null
  );
}

function attachmentOf(ws: FakeWebSocket) {
  return sandboxControlSocketAttachmentSchema.parse(ws.deserializeAttachment());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('connection-local sandbox observations', () => {
  it('records ready and explicit false heartbeats across handler reconstruction without frames', async () => {
    vi.useFakeTimers({ now });
    const ws = createFakeWebSocket(handshaken);
    const state = createFakeState([ws]);
    const onReady = vi.fn();
    const onHeartbeat = vi.fn();
    const handler = createSandboxControlSocketHandler(state, 'sbx_test', undefined, {
      onReady,
      onHeartbeat,
    });
    await handler.handleMessage(asWs(ws), readyFrame);
    expect(attachmentOf(ws).observation).toEqual({ ready: true, receivedAt: now, idle: null });
    await handler.handleMessage(asWs(ws), heartbeatFrame());
    expect(attachmentOf(ws).observation).toEqual({
      ready: true,
      receivedAt: now,
      idle: { sessionCount: 1, sessionIdsHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    vi.advanceTimersByTime(5);
    const notReady = { ...idleHeartbeat, kilo: { ready: false } };
    await handler.handleMessage(asWs(ws), heartbeatFrame(notReady));
    createSandboxControlSocketHandler(state, 'sbx_test');
    expect(readTestConnection(state, 'inst_1')).toEqual({
      state: 'connected',
      acceptedAt: handshaken.acceptedAt,
      observation: { ready: false, receivedAt: now + 5, idle: null },
    });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onHeartbeat.mock.calls.map(call => call[0])).toEqual([idleHeartbeat, notReady]);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('resets observation on every handshake and ignores late replaced-socket readiness', async () => {
    vi.useFakeTimers({ now });
    const previous = createFakeWebSocket(handshaken);
    const replacement = createFakeWebSocket({ handshakeComplete: false, acceptedAt: now });
    const sockets = [previous, replacement];
    const state = createFakeState(sockets);
    const handler = createSandboxControlSocketHandler(state, 'sbx_test');
    await handler.handleMessage(asWs(previous), heartbeatFrame());
    await handler.handleMessage(asWs(replacement), statusHelloFrame());
    previous.readyState = 2;
    expect(attachmentOf(replacement).observation).toBeUndefined();
    await handler.handleMessage(asWs(previous), readyFrame);
    await handler.handleMessage(asWs(previous), heartbeatFrame());
    expect(readTestConnection(state, 'inst_1')).toEqual({ state: 'unknown' });
    await handler.handleMessage(
      asWs(replacement),
      heartbeatFrame({ ...idleHeartbeat, kilo: { ready: false } })
    );
    expect(readTestConnection(state, 'inst_1')).toMatchObject({
      state: 'connected',
      observation: { ready: false, idle: null },
    });
    await handler.handleMessage(asWs(replacement), readyFrame);
    expect(readTestConnection(state, 'inst_1')).toMatchObject({
      state: 'connected',
      observation: { ready: true, idle: null },
    });
    const beforeDuplicate = attachmentOf(replacement);
    await handler.handleMessage(asWs(replacement), statusHelloFrame());
    expect(attachmentOf(replacement)).toEqual(beforeDuplicate);
    expect(replacement.send).toHaveBeenLastCalledWith(expect.stringContaining('protocol_error'));
  });

  it.each(['unhealthy', 'closed', 'replaced'] as const)(
    'keeps capture readiness fenced when a delayed heartbeat is overtaken by %s',
    async change => {
      vi.useFakeTimers({ now });
      const ws = createFakeWebSocket({ ...handshaken, wrapperInstanceId: WRAPPER_INSTANCE_ID });
      const sockets = [ws];
      const state = createFakeState(sockets);
      const firstHook = Promise.withResolvers<void>();
      const handler = createSandboxControlSocketHandler(state, 'sbx_test', undefined, {
        onHeartbeat: vi.fn().mockImplementationOnce(() => firstHook.promise),
      });
      await handler.handleMessage(asWs(ws), readyFrame);
      const identity = handler.getConnectionIdentity();
      const earlier = handler.handleMessage(asWs(ws), heartbeatFrame());
      expect(handler.getReadySocket()).toBe(ws);
      expect(attachmentOf(ws)).toMatchObject({ ...identity, kiloReady: true });
      const pending = handler.sendRequest({
        operation: 'session.git.summary',
        session: { sessionId: 'workspace_1', kiloSessionId: 'kilo_1', directory: '/workspace' },
        payload: { revision: 1 },
      });
      const rejected = expect(pending).rejects.toThrow();
      const sent = JSON.parse(ws.send.mock.calls.at(-1)?.[0] as string) as { requestId: string };
      if (change === 'unhealthy') {
        await handler.handleMessage(
          asWs(ws),
          heartbeatFrame({
            ...idleHeartbeat,
            kilo: { ready: false, reason: 'credential_refresh_failed' },
          })
        );
      } else if (change === 'closed') {
        handler.closeAll('runtime closed');
      } else {
        const replacement = createFakeWebSocket({ handshakeComplete: false, acceptedAt: now });
        sockets.push(replacement);
        await handler.handleMessage(asWs(replacement), helloFrame('inst_1', WRAPPER_INSTANCE_ID));
      }
      const fencedAttachment = attachmentOf(ws);
      firstHook.resolve();
      await earlier;
      expect(attachmentOf(ws)).toEqual(fencedAttachment);
      expect(handler.getReadySocket()).toBeNull();
      await handler.handleMessage(
        asWs(ws),
        JSON.stringify({ type: 'response', requestId: sent.requestId, ok: true })
      );
      await rejected;
    }
  );

  it('does not overwrite newer false evidence when an earlier idle hook completes late', async () => {
    vi.useFakeTimers({ now });
    const ws = createFakeWebSocket(handshaken);
    const firstHook = Promise.withResolvers<void>();
    const onHeartbeat = vi.fn().mockImplementationOnce(() => firstHook.promise);
    const handler = createSandboxControlSocketHandler(
      createFakeState([ws]),
      'sbx_test',
      undefined,
      {
        onHeartbeat,
      }
    );
    const earlier = handler.handleMessage(asWs(ws), heartbeatFrame());
    await handler.handleMessage(
      asWs(ws),
      heartbeatFrame({ ...idleHeartbeat, kilo: { ready: false } })
    );
    firstHook.resolve();
    await earlier;
    expect(attachmentOf(ws).observation).toEqual({ ready: false, receivedAt: now, idle: null });
  });

  it.each([
    ['busy', busyFrame],
    [
      'message',
      JSON.stringify({
        type: 'event',
        event: 'session.event',
        session: { directory: '/workspace/a', kiloSessionId: 'kilo_1' },
        payload: { type: 'message.updated', properties: { id: 'msg_1' } },
      }),
    ],
    [
      'preparing',
      JSON.stringify({
        type: 'event',
        event: 'session.preparing',
        session: { directory: '/workspace/a', kiloSessionId: 'kilo_1' },
        payload: {
          version: 2,
          attemptId: 'att_1',
          triggerMessageId: 'msg_1',
          revision: 1,
          timestamp: now,
          step: 'cloning',
          message: 'Cloning repository',
          action: 'step_started',
        },
      }),
    ],
  ])(
    'invalidates persisted idle evidence on a newer %s event without refreshing readiness',
    async (_name, frame) => {
      vi.useFakeTimers({ now });
      const ws = createFakeWebSocket(handshaken);
      const state = createFakeState([ws]);
      await createSandboxControlSocketHandler(state, 'sbx_test').handleMessage(
        asWs(ws),
        heartbeatFrame()
      );
      expect(attachmentOf(ws).observation?.idle).toMatchObject({ sessionCount: 1 });
      vi.advanceTimersByTime(5);
      const handler = createSandboxControlSocketHandler(state, 'sbx_test');
      await handler.handleMessage(asWs(ws), frame);
      expect(attachmentOf(ws).observation).toEqual({ ready: true, receivedAt: now, idle: null });
      expect(ws.send).not.toHaveBeenCalled();
      await handler.handleMessage(asWs(ws), heartbeatFrame());
      expect(attachmentOf(ws).observation).toMatchObject({
        ready: true,
        receivedAt: now + 5,
        idle: { sessionCount: 1 },
      });
    }
  );

  it('fences an in-flight idle heartbeat before forwarding a newer busy event in the same millisecond', async () => {
    vi.useFakeTimers({ now });
    const ws = createFakeWebSocket(handshaken);
    const heartbeatHook = Promise.withResolvers<void>();
    const eventHook = Promise.withResolvers<void>();
    const handler = createSandboxControlSocketHandler(
      createFakeState([ws]),
      'sbx_test',
      undefined,
      {
        onHeartbeat: () => heartbeatHook.promise,
        onSessionEvent: () => eventHook.promise,
      }
    );
    const heartbeat = handler.handleMessage(asWs(ws), heartbeatFrame());
    const event = handler.handleMessage(asWs(ws), busyFrame);
    heartbeatHook.resolve();
    try {
      await heartbeat;
      expect(attachmentOf(ws).observation).toEqual({ ready: true, receivedAt: now, idle: null });
    } finally {
      eventHook.resolve();
      await event;
    }
  });

  it('ignores replaced-socket activity without invalidating current idle evidence', async () => {
    vi.useFakeTimers({ now });
    const previous = createFakeWebSocket(handshaken);
    const replacement = createFakeWebSocket({ ...handshaken, acceptedAt: now });
    const handler = createSandboxControlSocketHandler(
      createFakeState([previous, replacement]),
      'sbx_test'
    );
    previous.readyState = 2;
    await handler.handleMessage(asWs(replacement), heartbeatFrame());
    const attachment = attachmentOf(replacement);
    await handler.handleMessage(asWs(previous), busyFrame);
    expect(attachmentOf(replacement)).toEqual(attachment);
    expect(attachment.observation?.idle).toMatchObject({ sessionCount: 1 });
    expect(previous.serializeAttachment).not.toHaveBeenCalled();
  });

  it('does not expose readiness during activation or under another persisted runtime identity', async () => {
    vi.useFakeTimers({ now });
    const previous = createFakeWebSocket({ ...handshaken, wrapperInstanceId: WRAPPER_INSTANCE_ID });
    const replacement = createFakeWebSocket({ handshakeComplete: false, acceptedAt: now });
    const state = createFakeState([previous, replacement]);
    const activation = Promise.withResolvers<void>();
    const onReady = vi.fn();
    const handler = createSandboxControlSocketHandler(state, 'sbx_test', undefined, {
      onHandshakeComplete: () => activation.promise,
      onReady,
    });
    const oldRuntime = attachmentOf(previous);
    const handshake = handler.handleMessage(
      asWs(replacement),
      helloFrame('inst_1', REPLACEMENT_WRAPPER_INSTANCE_ID)
    );
    await handler.handleMessage(asWs(replacement), readyFrame);
    expect(onReady).not.toHaveBeenCalled();
    expect(attachmentOf(replacement).observation).toBeUndefined();
    activation.resolve();
    await handshake;
    await handler.handleMessage(asWs(replacement), readyFrame);
    const current = attachmentOf(replacement);
    expect(onReady).toHaveBeenCalledWith({
      connectionId: current.connectionId,
      providerInstanceId: 'inst_1',
      wrapperInstanceId: REPLACEMENT_WRAPPER_INSTANCE_ID,
    });
    const runtime = { ...current, readyConnectionId: current.connectionId };
    for (const stale of [
      undefined,
      oldRuntime,
      { ...runtime, readyConnectionId: oldRuntime.connectionId },
      { ...runtime, wrapperInstanceId: WRAPPER_INSTANCE_ID },
    ]) {
      expect(readSandboxControlConnection(state, 'inst_1', stale)).toEqual({ state: 'unknown' });
    }
    const serialize = replacement.serializeAttachment.mock.calls.length;
    expect(readSandboxControlConnection(state, 'inst_1', runtime)).toMatchObject({
      state: 'connected',
      observation: { ready: true, receivedAt: now },
    });
    expect(replacement.serializeAttachment).toHaveBeenCalledTimes(serialize);
  });

  it('does not let an in-flight heartbeat populate a same-provider replacement', async () => {
    vi.useFakeTimers({ now });
    const previous = createFakeWebSocket(handshaken);
    const replacement = createFakeWebSocket({ handshakeComplete: false, acceptedAt: now });
    const state = createFakeState([previous, replacement]);
    const hook = Promise.withResolvers<void>();
    const handler = createSandboxControlSocketHandler(state, 'sbx_test', undefined, {
      onHeartbeat: () => hook.promise,
    });
    const heartbeat = handler.handleMessage(asWs(previous), heartbeatFrame());
    await handler.handleMessage(asWs(replacement), statusHelloFrame());
    previous.readyState = 2;
    hook.resolve();
    await heartbeat;
    expect(attachmentOf(replacement).observation).toBeUndefined();
    expect(readTestConnection(state, 'inst_1')).toEqual({ state: 'unknown' });
  });

  it('retains no unbounded session payload in attachments', async () => {
    vi.useFakeTimers({ now });
    const ws = createFakeWebSocket(handshaken);
    const payload: SandboxHeartbeatPayload = {
      ...idleHeartbeat,
      sessions: Array.from({ length: 2_000 }, (_, index) => ({
        kiloSessionId: `kilo_${index}`,
        state: 'idle',
        idleForMs: 0,
      })),
    };
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    await handler.handleMessage(asWs(ws), heartbeatFrame(payload));
    expect(attachmentOf(ws).observation?.idle?.sessionCount).toBe(2_000);
    const serialized = JSON.stringify(ws.deserializeAttachment());
    expect(serialized.length).toBeLessThan(512);
    expect(serialized).not.toContain('kilo_1999');
  });

  it.each([
    { event: 'sandbox.ready', payload: { kiloReady: false, globalFeedAttached: true } },
    { event: 'sandbox.ready', payload: { kiloReady: true } },
    { event: 'sandbox.heartbeat', payload: { ...idleHeartbeat, kilo: { ready: 'true' } } },
    { event: 'sandbox.heartbeat', payload: { ...idleHeartbeat, sessions: undefined } },
    { event: 'unknown', payload: idleHeartbeat },
  ])('does not record invalid or unrelated $event evidence', async frame => {
    const ws = createFakeWebSocket(handshaken);
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    await handler.handleMessage(asWs(ws), JSON.stringify({ type: 'event', ...frame }));
    expect(ws.serializeAttachment).not.toHaveBeenCalled();
  });

  it('does not derive readiness from an operational sandbox.status response', async () => {
    const ws = createFakeWebSocket(handshaken);
    const handler = createSandboxControlSocketHandler(createFakeState([ws]), 'sbx_test');
    await handler.handleMessage(
      asWs(ws),
      JSON.stringify({
        type: 'response',
        requestId: 'probe',
        ok: true,
        result: { healthy: true, kiloReady: true, state: 'idle', version: 'test' },
      })
    );
    expect(ws.serializeAttachment).not.toHaveBeenCalled();
  });

  it.each([
    null,
    handshaken,
    { ...handshaken, observation: { ready: true, receivedAt: NaN, idle: null } },
    { ...handshaken, observation: { ready: true, receivedAt: now, idle: { sessionCount: 1 } } },
    { ...handshaken, observation: { ready: true, receivedAt: now - 2_000, idle: null } },
    {
      ...handshaken,
      protocolVersion: undefined,
      observation: { ready: true, receivedAt: now, idle: null },
    },
  ])('treats old or invalid attachments as unknown without rewriting them: %j', attachment => {
    const ws = createFakeWebSocket(attachment);
    const state = createFakeState([ws]);
    expect(readTestConnection(state, 'inst_1')).toEqual({ state: 'unknown' });
    expect(ws.serializeAttachment).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('requires one matching open handshaken socket, without choosing by acceptance time', () => {
    const attachment = { ...handshaken, observation: { ready: true, receivedAt: now, idle: null } };
    const older = createFakeWebSocket(attachment);
    const newer = createFakeWebSocket({ ...attachment, acceptedAt: now });
    expect(readTestConnection(createFakeState([older, newer]), 'inst_1')).toEqual({
      state: 'unknown',
    });
    expect(readTestConnection(createFakeState([older]), 'different')).toEqual({
      state: 'unknown',
    });
    older.readyState = 2;
    expect(readTestConnection(createFakeState([older]), 'inst_1')).toEqual({
      state: 'disconnected',
    });
    const provisional = createFakeWebSocket({ handshakeComplete: false, acceptedAt: now });
    expect(readTestConnection(createFakeState([provisional]), 'inst_1')).toEqual({
      state: 'disconnected',
    });
    expect(
      readTestConnection(createFakeState([older, newer, provisional]), 'inst_1')
    ).toMatchObject({ state: 'connected' });
  });

  it('keeps operational dispatch usable when only the optional observation is invalid', async () => {
    const ws = createFakeWebSocket({ ...handshaken, observation: { ready: 'invalid' } });
    const state = createFakeState([ws]);
    const handler = createSandboxControlSocketHandler(state, 'sbx_test');
    expect(handler.hasHandshakenSocket()).toBe(true);
    expect(readTestConnection(state, 'inst_1')).toEqual({ state: 'unknown' });
    await handler.handleMessage(asWs(ws), readyFrame);
    expect(attachmentOf(ws).observation?.ready).toBe(true);
  });
});
