import { describe, expect, it, mock, spyOn } from 'bun:test';
import { z } from 'zod';
import { helloResult } from '../../../src/sandbox-control/frames';
import { buildHeartbeatPayload, createControlHandlerDeps } from './sandbox-control-handlers';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  sandboxHeartbeatPayloadSchema,
  sandboxEventPublicationPayloadSchema,
  sessionEventPayloadSchema,
  type SandboxEventPublicationPayload,
  type SessionOperationDelivery,
} from '../../../src/shared/sandbox-control-protocol';
import { unfilteredKiloEvents } from './feed';
import { acknowledgeOperation, operationAuthorization } from './control-test-fixtures';
import { createControlEventFailureHandler } from './control-event-transport';
import {
  createSandboxControlClient,
  type SandboxControlClientOptions,
} from './sandbox-control-client';

class FakeWebSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(event: MessageEvent | Event) => void>>();

  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', new Event('close'));
  }

  error(): void {
    this.emit('error', new Event('error'));
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', new Event('open'));
  }

  respond(data: string): void {
    this.emit('message', { data } as MessageEvent);
  }

  private emit(type: string, event: MessageEvent | Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createClientFixture(options: Partial<SandboxControlClientOptions> = {}) {
  const sockets: FakeWebSocket[] = [];
  const onDisconnected = mock(() => {});
  const openWebSocket = mock(() => {
    const socket = new FakeWebSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const client = createSandboxControlClient({
    url: 'wss://example.test/sandbox-control/sbx_1',
    credential: 'secret',
    providerInstanceId: 'inst_1',
    reconnectDelayMs: () => 0,
    openWebSocket,
    onDisconnected,
    ...options,
  });
  return { client, sockets, openWebSocket, onDisconnected };
}

const previousHelloResultSchema = z.object({
  protocolVersion: z.literal(1),
  handshakeComplete: z.literal(true),
});

const previousHeartbeatSchema = z
  .object({
    state: z.enum(['idle', 'active', 'finalizing']),
    activeKiloSessions: z.number().int().nonnegative().optional(),
    pendingMessages: z.number().int().nonnegative().optional(),
    kilo: z
      .object({
        ready: z.boolean(),
        reason: z
          .enum([
            'feed_stale',
            'feed_reconnected',
            'feed_ended',
            'feed_failed',
            'process_exited',
            'credential_refresh_failed',
            'control_disconnected',
            'shutdown',
          ])
          .optional(),
      })
      .strict(),
    sessions: z.array(
      z
        .object({
          kiloSessionId: z.string().min(1),
          state: z.enum(['idle', 'active', 'finalizing']),
          idleForMs: z.number().int().nonnegative(),
          waitingOn: z.enum(['model', 'tool', 'finalizing', 'preparation', 'input']).optional(),
        })
        .strict()
    ),
  })
  .strict();

function versionHeartbeat(version: string | null) {
  return buildHeartbeatPayload(
    createControlHandlerDeps({
      kiloRuntimes: {
        kiloCliVersion: version,
        attach() {
          throw new Error('Unexpected attach');
        },
        detach: () => false,
        deleteDirectory: async () => {},
        get: () => undefined,
        isHealthy: () => true,
        shutdown() {},
      },
      version: '2.4.0',
      kiloReady: true,
      sessions: [],
      emitSessionEvent() {},
      retireRuntime() {},
    })
  );
}

describe('heartbeat version rollout compatibility', () => {
  it.each(['7.4.20', null])(
    'reproduces the previous exact strict contract rejection of version %j',
    version => {
      expect(previousHeartbeatSchema.safeParse(versionHeartbeat(version)).success).toBe(false);
    }
  );

  it.each(['7.4.20', null])(
    'new wrapper omits unnegotiated version %j for an old Worker',
    async version => {
      const fake = new FakeWebSocket();
      const { client } = createClientFixture({ openWebSocket: () => fake as unknown as WebSocket });
      try {
        const connecting = client.connect();
        await handshake(fake);
        await connecting;
        const heartbeat = versionHeartbeat(version);
        const before = structuredClone(heartbeat);
        for (const kilo of [
          heartbeat.kilo,
          { ...heartbeat.kilo, ready: false, reason: 'shutdown' as const },
        ]) {
          expect(client.sendEvent?.('sandbox.heartbeat', { ...heartbeat, kilo })).toBe(true);
          const frame = JSON.parse(fake.sent.at(-1) ?? '{}');
          expect(previousHeartbeatSchema.safeParse(frame.payload).success).toBe(true);
          expect(frame.payload.kilo).not.toHaveProperty('version');
          expect(frame.payload.kilo.ready).toBe(kilo.ready);
          expect(frame.payload.kilo.reason).toBe(kilo.reason);
        }
        expect(heartbeat).toEqual(before);
      } finally {
        client.close();
      }
    }
  );

  it.each([{}, { kiloVersionHeartbeat: false }])(
    'does not infer support from capabilities %j',
    async capabilities => {
      const fake = new FakeWebSocket();
      const { client } = createClientFixture({ openWebSocket: () => fake as unknown as WebSocket });
      try {
        const connecting = client.connect();
        await handshake(fake, { protocolVersion: 1, handshakeComplete: true, capabilities });
        await connecting;
        expect(client.sendEvent?.('sandbox.heartbeat', versionHeartbeat('7.4.20'))).toBe(true);
        const frame = JSON.parse(fake.sent.at(-1) ?? '{}');
        expect(previousHeartbeatSchema.safeParse(frame.payload).success).toBe(true);
        expect(frame.payload.kilo).not.toHaveProperty('version');
      } finally {
        client.close();
      }
    }
  );

  it('does not retain capability support from a failed connection attempt', async () => {
    const { client, sockets } = createClientFixture();
    try {
      const connecting = client.connect();
      await Promise.resolve();
      const first = sockets[0];
      if (!first) throw new Error('Missing first socket');
      first.open();
      const hello = JSON.parse(first.sent[0] ?? '{}');
      first.respond(
        JSON.stringify({
          type: 'response',
          requestId: hello.requestId,
          ok: true,
          result: helloResult({ connectionRecovery: true }),
        })
      );
      first.close();
      await waitForReconnect();
      const second = sockets[1];
      await handshake(second);
      await connecting;
      if (!second) throw new Error('Missing second socket');
      const nextHello = JSON.parse(second.sent[0] ?? '{}');
      second.respond(
        JSON.stringify({
          type: 'response',
          requestId: nextHello.requestId,
          ok: true,
          result: helloResult(),
        })
      );
      expect(client.sendEvent?.('sandbox.heartbeat', versionHeartbeat('7.4.20'))).toBe(true);
      const frame = JSON.parse(second.sent.at(-1) ?? '{}');
      expect(previousHeartbeatSchema.safeParse(frame.payload).success).toBe(true);
      expect(frame.payload.kilo).not.toHaveProperty('version');
    } finally {
      client.close();
    }
  });

  it('old wrappers accept new Worker hello acknowledgements and their old heartbeats remain valid', () => {
    expect(previousHelloResultSchema.parse(helloResult())).toEqual({
      protocolVersion: 1,
      handshakeComplete: true,
    });
    const heartbeat = previousHeartbeatSchema.parse({
      state: 'idle',
      kilo: { ready: true },
      sessions: [],
    });
    expect(sandboxHeartbeatPayloadSchema.parse(heartbeat)).toEqual(heartbeat);
  });

  it.each(['7.4.20', null])(
    'new wrapper retains negotiated version %j for a new Worker',
    async version => {
      const fake = new FakeWebSocket();
      const { client } = createClientFixture({ openWebSocket: () => fake as unknown as WebSocket });
      try {
        const connecting = client.connect();
        await handshake(fake, helloResult());
        await connecting;
        const heartbeat = versionHeartbeat(version);
        expect(client.sendEvent?.('sandbox.heartbeat', heartbeat)).toBe(true);
        const frame = JSON.parse(fake.sent.at(-1) ?? '{}');
        expect(sandboxHeartbeatPayloadSchema.parse(frame.payload)).toEqual(heartbeat);
        expect(frame.payload.kilo.version).toBe(version);
        const withoutVersion = { state: 'idle' as const, kilo: { ready: true }, sessions: [] };
        expect(client.sendEvent?.('sandbox.heartbeat', withoutVersion)).toBe(true);
        expect(
          sandboxHeartbeatPayloadSchema.parse(JSON.parse(fake.sent.at(-1) ?? '{}').payload)
        ).toEqual(withoutVersion);
      } finally {
        client.close();
      }
    }
  );
});

describe('createSandboxControlClient', () => {
  it('replays one native retirement receipt after a lost acknowledgement on reconnect', async () => {
    const { client, sockets } = createClientFixture();
    const payload = {
      retirementId: '11111111-1111-4111-8111-111111111111',
      directory: '/workspace/a',
      nativeRuntimeId: '22222222-2222-4222-8222-222222222222',
      reason: 'process_exited',
      cleanupDeadlineAt: Date.now() + 5_000,
    };
    try {
      const connecting = client.connect();
      await Promise.resolve();
      await handshake(sockets[0], helloResult({ connectionRecovery: true }));
      await connecting;
      const report = client.reportNativeRuntimeRetirement?.(payload);
      const first = sockets[0];
      if (!report || !first) throw new Error('Native retirement report did not start');
      await Promise.resolve();
      const initial = JSON.parse(first.sent.at(-1) ?? '{}');
      expect(initial).toMatchObject({ operation: 'session.runtime.retired', payload });
      first.close();

      await waitForReconnect();
      const replacement = sockets[1];
      await handshake(replacement);
      await new Promise(resolve => setTimeout(resolve, 300));
      const replay = JSON.parse(replacement?.sent.at(-1) ?? '{}');
      expect(replay).toMatchObject({ operation: 'session.runtime.retired', payload });
      replacement?.respond(
        JSON.stringify({
          type: 'response',
          requestId: replay.requestId,
          ok: true,
          result: { retired: true },
        })
      );
      expect(await report).toBe(true);
      const replayedReport = client.reportNativeRuntimeRetirement?.(payload);
      if (!replayedReport) throw new Error('Native retirement receipt was not retained');
      expect(await replayedReport).toBe(true);
      expect(
        replacement?.sent.filter(frame => frame.includes('session.runtime.retired'))
      ).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it('opens with an Authorization header and completes sandbox.hello plus status probe', async () => {
    const fake = new FakeWebSocket();
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      wrapperVersion: '2.4.0',
      providerInstanceId: 'inst_1',
      openWebSocket: (url, credential) => {
        expect(url).toBe('wss://example.test/sandbox-control/sbx_1');
        expect(credential).toBe('secret');
        return fake as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    fake.open();
    await Promise.resolve();
    expect(fake.sent).toHaveLength(1);
    const hello = JSON.parse(fake.sent[0] ?? '{}') as {
      requestId: string;
      operation: string;
      payload: {
        protocolVersion: number;
        wrapperVersion: string;
        providerInstanceId: string;
        capabilities?: {
          sessionOperationResults?: boolean;
          scopedStopAbort?: boolean;
          nativeRuntimeRetirement?: boolean;
          connectionRecovery?: boolean;
          eventReceipts?: boolean;
        };
      };
    };
    expect(hello.operation).toBe('sandbox.hello');
    expect(hello.payload).toEqual({
      protocolVersion: 1,
      wrapperVersion: '2.4.0',
      providerInstanceId: 'inst_1',
      capabilities: {
        sessionOperationResults: true,
        scopedStopAbort: true,
        nativeRuntimeRetirement: true,
        connectionRecovery: true,
        eventReceipts: true,
      },
    });
    fake.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: true,
        result: { protocolVersion: 1, handshakeComplete: true },
      })
    );
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'status-1',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await connecting;
    expect(fake.sent[1]).toBe(
      JSON.stringify({
        type: 'response',
        requestId: 'status-1',
        ok: true,
      })
    );
    client.close();
    expect(fake.readyState).toBe(3);
  });

  it('includes the wrapper process instance in sandbox.hello without exposing the credential', async () => {
    const fake = new FakeWebSocket();
    const wrapperInstanceId = crypto.randomUUID();
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'master-control-secret',
      providerInstanceId: 'inst_1',
      wrapperInstanceId,
      openWebSocket: () => fake as unknown as WebSocket,
    });

    const connecting = client.connect();
    await handshake(fake);
    await connecting;

    expect(JSON.parse(fake.sent[0] ?? '{}')).toMatchObject({
      operation: 'sandbox.hello',
      payload: { providerInstanceId: 'inst_1', wrapperInstanceId },
    });
    expect(fake.sent[0]).not.toContain('master-control-secret');
    client.close();
  });

  it('answers inbound sandbox.status after handshake when onRequest is provided', async () => {
    const fake = new FakeWebSocket();
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      openWebSocket: () => fake as unknown as WebSocket,
      onRequest: async operation => {
        expect(operation).toBe('sandbox.status');
        return {
          ok: true,
          result: { healthy: true, state: 'idle', version: '2.4.0', kiloReady: true },
        };
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    fake.open();
    await Promise.resolve();
    const hello = JSON.parse(fake.sent[0] ?? '{}') as { requestId: string };
    fake.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: true,
        result: { protocolVersion: 1, handshakeComplete: true },
      })
    );
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'status-1',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await connecting;

    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'status-2',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(fake.sent[2] ?? '{}')).toEqual({
      type: 'response',
      requestId: 'status-2',
      ok: true,
      result: { healthy: true, state: 'idle', version: '2.4.0', kiloReady: true },
    });
    client.close();
  });

  it('gates new session work until the exact recovery episode is marked ready', async () => {
    const fake = new FakeWebSocket();
    const onRequest = mock(async () => ({ ok: true as const, result: { accepted: true } }));
    const onReconcile = mock(async () => {});
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      openWebSocket: () => fake as unknown as WebSocket,
      onRequest,
      onReconcile,
    });
    const recovery = {
      episodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cause: 'control_disconnected' as const,
      startedAt: 1,
      deadlineAt: Date.now() + 10_000,
      attempt: 1,
    };

    const connecting = client.connect();
    await handshake(fake);
    await connecting;
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'drain',
        operation: 'sandbox.reconcile',
        payload: { recovery, phase: 'drain' },
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'blocked',
        operation: 'session.prompt',
        payload: {},
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(onReconcile).toHaveBeenCalledWith('drain', recovery.deadlineAt);
    expect(onRequest).not.toHaveBeenCalled();
    expect(JSON.parse(fake.sent.at(-1) ?? '{}')).toMatchObject({
      requestId: 'blocked',
      ok: false,
      error: { code: 'not_ready' },
    });

    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'ready',
        operation: 'sandbox.reconcile',
        payload: { recovery, phase: 'ready' },
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'commit',
        operation: 'sandbox.reconcile',
        payload: { recovery, phase: 'commit' },
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'commit-replay',
        operation: 'sandbox.reconcile',
        payload: { recovery, phase: 'commit' },
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(fake.sent.at(-1) ?? '{}')).toMatchObject({
      requestId: 'commit-replay',
      ok: true,
      result: { episodeId: recovery.episodeId, attempt: recovery.attempt, phase: 'commit' },
    });

    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'admitted',
        operation: 'session.prompt',
        payload: {},
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(onReconcile).toHaveBeenLastCalledWith('commit', recovery.deadlineAt);
    expect(onReconcile).toHaveBeenCalledTimes(3);
    expect(onRequest).toHaveBeenCalledTimes(1);
    client.close();
  });

  it.each([
    { ok: true, result: '漢'.repeat(MAX_SANDBOX_CONTROL_FRAME_BYTES / 2) },
    {
      ok: false,
      error: { code: 'failure', message: 'private-data'.repeat(100_000), retryable: false },
    },
  ])(
    'replaces oversized response envelopes with a small error and preserves the socket',
    async outcome => {
      const fake = new FakeWebSocket();
      const client = createSandboxControlClient({
        url: 'wss://example.test/sandbox-control/sbx_1',
        credential: 'secret',
        providerInstanceId: 'inst_1',
        openWebSocket: () => fake as unknown as WebSocket,
        onRequest: async operation =>
          operation === 'sandbox.status' ? { ok: true, result: { healthy: true } } : outcome,
      });
      const connecting = client.connect();
      await handshake(fake);
      await connecting;
      fake.respond(
        JSON.stringify({
          type: 'request',
          requestId: 'large',
          operation: 'session.git.summary',
          payload: { revision: 1 },
        })
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(JSON.parse(fake.sent[2] ?? '{}')).toEqual({
        type: 'response',
        requestId: 'large',
        ok: false,
        error: {
          code: 'payload_too_large',
          message: 'Response exceeds size limit',
          retryable: false,
        },
      });
      expect(Buffer.byteLength(fake.sent[2] ?? '')).toBeLessThan(1024);
      expect(fake.readyState).toBe(1);
      fake.respond(
        JSON.stringify({
          type: 'request',
          requestId: 'next',
          operation: 'sandbox.status',
          payload: {},
        })
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(JSON.parse(fake.sent[3] ?? '{}')).toEqual({
        type: 'response',
        requestId: 'next',
        ok: true,
        result: { healthy: true },
      });
      client.close();
    }
  );

  it.each([0, 1])(
    'keeps the full response strictly below the frame limit with %s bytes of headroom',
    async headroom => {
      const fake = new FakeWebSocket();
      const requestId = 'quote"漢';
      const envelopeBytes = Buffer.byteLength(
        JSON.stringify({ type: 'response', requestId, ok: true, result: '' })
      );
      const client = createSandboxControlClient({
        url: 'wss://example.test/sandbox-control/sbx_1',
        credential: 'secret',
        providerInstanceId: 'inst_1',
        openWebSocket: () => fake as unknown as WebSocket,
        onRequest: async () => ({
          ok: true,
          result: 'x'.repeat(MAX_SANDBOX_CONTROL_FRAME_BYTES - envelopeBytes - headroom),
        }),
      });
      const connecting = client.connect();
      await handshake(fake);
      await connecting;
      fake.respond(
        JSON.stringify({
          type: 'request',
          requestId,
          operation: 'session.git.summary',
          payload: { revision: 1 },
        })
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(JSON.parse(fake.sent[2] ?? '{}').ok).toBe(headroom === 1);
      expect(Buffer.byteLength(fake.sent[2] ?? '')).toBeLessThan(MAX_SANDBOX_CONTROL_FRAME_BYTES);
      client.close();
    }
  );

  it('safely handles unserializable results without closing the shared socket', async () => {
    const fake = new FakeWebSocket();
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      openWebSocket: () => fake as unknown as WebSocket,
      onRequest: async () => ({ ok: true, result: 1n }),
    });
    const connecting = client.connect();
    await handshake(fake);
    await connecting;
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'invalid-result',
        operation: 'session.git.summary',
        payload: { revision: 1 },
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(JSON.parse(fake.sent[2] ?? '{}')).toEqual({
      type: 'response',
      requestId: 'invalid-result',
      ok: false,
      error: { code: 'capture_failed', message: 'Response serialization failed', retryable: false },
    });
    expect(fake.readyState).toBe(1);
    client.close();
  });

  it('includes session on sendEvent when provided', async () => {
    const fake = new FakeWebSocket();
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      openWebSocket: () => fake as unknown as WebSocket,
    });

    const connecting = client.connect();
    await Promise.resolve();
    fake.open();
    await Promise.resolve();
    const hello = JSON.parse(fake.sent[0] ?? '{}') as { requestId: string };
    fake.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: true,
        result: { protocolVersion: 1, handshakeComplete: true },
      })
    );
    fake.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'status-1',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await connecting;

    client.sendEvent?.('session.event', { type: 'session.idle', properties: {} });
    client.sendEvent?.(
      'session.event',
      { type: 'session.status', properties: { sessionID: 'ses_1' } },
      {
        directory: '/workspace',
        kiloSessionId: 'ses_1',
        rootKiloSessionId: 'ses_1',
        nativeRuntimeId: crypto.randomUUID(),
      }
    );

    expect(JSON.parse(fake.sent[2] ?? '{}')).toEqual({
      type: 'event',
      event: 'session.event',
      payload: { type: 'session.idle', properties: {} },
    });
    expect(JSON.parse(fake.sent[3] ?? '{}')).toEqual({
      type: 'event',
      event: 'session.event',
      session: {
        directory: '/workspace',
        kiloSessionId: 'ses_1',
        rootKiloSessionId: 'ses_1',
      },
      payload: { type: 'session.status', properties: { sessionID: 'ses_1' } },
    });
    client.close();
  });

  it.each([
    'event-rejected',
    'retryable-rejection',
    'transport-error',
    'other-error',
    'false-ack',
    'wrong-receipt',
  ] as const)(
    'preserves N1 before N2 ordering through publication disposition: %s',
    async disposition => {
      const failure = mock(() => {});
      const logs: string[] = [];
      const { client, sockets, onDisconnected } = createClientFixture({
        onEventReceiptFailure: failure,
        log: message => logs.push(message),
      });
      const hello = {
        protocolVersion: 1,
        handshakeComplete: true,
        capabilities: { connectionRecovery: true, eventReceipts: true },
      };
      const nativeIds = [crypto.randomUUID(), crypto.randomUUID()];
      const published: SandboxEventPublicationPayload[] = [];
      const firstPublished = Promise.withResolvers<void>();
      const replacementPublished = Promise.withResolvers<void>();
      try {
        const connecting = client.connect();
        await Promise.resolve();
        await handshake(sockets[0], hello);
        await connecting;
        sockets[0]?.close();
        for (const nativeRuntimeId of nativeIds)
          expect(
            client.sendEvent?.(
              'session.event',
              { type: 'session.status', properties: { status: { type: 'idle' } } },
              {
                directory: '/workspace',
                kiloSessionId: 'ses_1',
                rootKiloSessionId: 'ses_1',
                nativeRuntimeId,
              }
            )
          ).toBe(true);
        await waitForReconnect();
        const socket = sockets[1];
        if (!socket) throw new Error('Missing replacement socket');
        socket.send = data => {
          socket.sent.push(data);
          const frame = JSON.parse(data) as {
            operation?: string;
            requestId: string;
            payload: unknown;
          };
          if (frame.operation !== 'sandbox.event.publish') return;
          const publication = sandboxEventPublicationPayloadSchema.parse(frame.payload);
          published.push(publication);
          firstPublished.resolve();
          if (publication.sequence === 2) replacementPublished.resolve();
          const acknowledgement = { receiptId: publication.receiptId, applied: true };
          const response =
            published.length > 1
              ? { ok: true, result: acknowledgement }
              : disposition === 'false-ack'
                ? { ok: true, result: { ...acknowledgement, applied: false } }
                : disposition === 'wrong-receipt'
                  ? { ok: true, result: { ...acknowledgement, receiptId: crypto.randomUUID() } }
                  : {
                      ok: false,
                      error: {
                        code:
                          disposition === 'transport-error'
                            ? 'not_ready'
                            : disposition === 'other-error'
                              ? 'unauthorized'
                              : 'event_rejected',
                        retryable:
                          disposition === 'retryable-rejection' ||
                          disposition === 'transport-error',
                        message: 'private rejected input',
                      },
                    };
          socket.respond(
            JSON.stringify({ type: 'response', requestId: frame.requestId, ...response })
          );
        };
        await handshake(socket, hello);
        await firstPublished.promise;
        await waitForReconnect();
        if (disposition === 'retryable-rejection' || disposition === 'transport-error') {
          expect(published.map(item => item.session.nativeRuntimeId)).toEqual(
            nativeIds.slice(0, 1)
          );
          await replacementPublished.promise;
          await waitForReconnect();
          expect(published.map(item => item.session.nativeRuntimeId)).toEqual([
            nativeIds[0],
            ...nativeIds,
          ]);
          expect(published.map(item => item.sequence)).toEqual([1, 1, 2]);
          expect(published[1]).toEqual(published[0]);
          expect(failure).not.toHaveBeenCalled();
          expect(logs).not.toContain('sandbox control event publication rejected');
        } else {
          expect(published.map(item => item.session.nativeRuntimeId)).toEqual(nativeIds);
          expect(published.map(item => item.sequence)).toEqual([1, 2]);
          expect(failure).toHaveBeenCalledTimes(1);
          expect(failure).toHaveBeenCalledWith({
            reason: 'rejected',
            publication: expect.objectContaining(published[0]),
          });
          expect(logs).toContain('sandbox control event publication rejected');
        }
        expect(socket.readyState).toBe(1);
        expect(sockets).toHaveLength(2);
        socket.close();
        await waitForReconnect();
        await handshake(sockets[2], hello);
        await waitForReconnect();
        expect(sockets[2]?.sent.some(data => data.includes('sandbox.event.publish'))).toBe(false);
        expect(onDisconnected).not.toHaveBeenCalled();
        expect(logs.join('\n')).not.toContain('private rejected input');
      } finally {
        client.close();
      }
    }
  );

  it('keeps reconnect readiness, attach, maintenance and sealed results independent of expiring N1 events', async () => {
    const startedAt = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(startedAt);
    const timers = spyOn(globalThis, 'setTimeout');
    const failure = mock();
    const retire = mock();
    let currentRuntime = { runtimeId: crypto.randomUUID() };
    const handleFailure = createControlEventFailureHandler({
      getRuntime: () => currentRuntime,
      onFailure: retire,
    });
    const connected = mock();
    const request = mock(async () => ({ ok: true, result: { attached: true } }));
    const logs: string[] = [];
    const { client, sockets, onDisconnected } = createClientFixture({
      onConnected: connected,
      onEventReceiptFailure: eventFailure => {
        failure(eventFailure);
        handleFailure(eventFailure);
      },
      onRequest: request,
      log: message => logs.push(message),
    });
    const hello = {
      protocolVersion: 1,
      handshakeComplete: true,
      capabilities: { connectionRecovery: true, eventReceipts: true },
    };
    const identity = {
      directory: '/workspace',
      kiloSessionId: 'kilo_1',
      rootKiloSessionId: 'kilo_1',
      nativeRuntimeId: currentRuntime.runtimeId,
    };
    const delivery: SessionOperationDelivery = {
      version: 2,
      authorization: operationAuthorization(),
      completedAt: startedAt,
      result: { ok: true, result: {} },
      outcome: { messageId: 'msg_1', status: 'completed' },
      events: [],
      preparing: [],
    };
    const acknowledgement = await acknowledgeOperation(delivery);
    try {
      const connecting = client.connect();
      await Promise.resolve();
      await handshake(sockets[0], hello);
      await connecting;
      sockets[0]?.close();
      expect(
        client.sendEvent?.('session.event', { type: 'session.idle', properties: {} }, identity)
      ).toBe(true);
      const result = client
        .sendOperationResult?.(
          delivery.authorization.session,
          delivery,
          new AbortController().signal,
          startedAt + 60_000
        )
        .catch((error: unknown) => error);
      const retirement = client.reportNativeRuntimeRetirement?.({
        retirementId: crypto.randomUUID(),
        directory: identity.directory,
        nativeRuntimeId: identity.nativeRuntimeId,
        reason: 'process_exited',
        cleanupDeadlineAt: startedAt + 60_000,
      });
      await waitForReconnect();
      clock.mockReturnValue(startedAt + 250);
      const socket = sockets[1];
      if (!socket) throw new Error('Missing replacement socket');
      const reconnectTimers = timers.mock.calls.length;
      await handshake(socket, hello);
      await waitForReconnect();
      const frames = socket.sent.map(data => JSON.parse(data));
      const eventFrame = frames.find(frame => frame.operation === 'sandbox.event.publish');
      const resultFrame = frames.find(frame => frame.operation === 'session.operation.result');
      const retirementFrame = frames.find(frame => frame.operation === 'session.runtime.retired');
      expect(connected).toHaveBeenCalledTimes(2);
      expect(eventFrame?.payload.session.nativeRuntimeId).toBe(identity.nativeRuntimeId);
      expect(resultFrame?.payload).toEqual(delivery);
      expect(retirementFrame).toBeDefined();
      socket.respond(
        JSON.stringify({
          type: 'request',
          requestId: 'attach-n2',
          operation: 'session.attach',
          session: delivery.authorization.session,
          payload: {},
        })
      );
      expect(client.sendEvent?.('sandbox.heartbeat', versionHeartbeat(null))).toBe(true);
      await waitForReconnect();
      expect(request).toHaveBeenCalledTimes(1);
      expect(socket.sent.map(data => JSON.parse(data))).toContainEqual({
        type: 'response',
        requestId: 'attach-n2',
        ok: true,
        result: { attached: true },
      });
      socket.respond(
        JSON.stringify({
          type: 'response',
          requestId: retirementFrame.requestId,
          ok: true,
          result: { retired: true },
        })
      );
      expect(await retirement).toBe(true);
      clock.mockReturnValue(startedAt + 29_000);
      const replacement = { ...identity, nativeRuntimeId: crypto.randomUUID() };
      currentRuntime = { runtimeId: replacement.nativeRuntimeId };
      expect(
        client.sendEvent?.('session.event', { type: 'session.idle', properties: {} }, replacement)
      ).toBe(true);
      clock.mockReturnValue(startedAt + 30_000);
      for (let index = reconnectTimers; index < timers.mock.calls.length; index += 1) {
        const [expire, ms] = timers.mock.calls[index] ?? [];
        if (ms !== 29_750 || typeof expire !== 'function') continue;
        clearTimeout(
          timers.mock.results[index]?.value as ReturnType<typeof setTimeout> | undefined
        );
        expire();
      }
      await waitForReconnect();
      expect(logs).toContain('sandbox control event publication expired');
      expect(failure).toHaveBeenCalledTimes(1);
      expect(failure).toHaveBeenCalledWith({
        reason: 'expired',
        publication: expect.objectContaining(eventFrame.payload),
      });
      expect(retire).not.toHaveBeenCalled();
      expect(onDisconnected).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(1);
      const replacementFrame = socket.sent
        .map(data => JSON.parse(data))
        .find(
          frame =>
            frame.operation === 'sandbox.event.publish' &&
            frame.payload.session.nativeRuntimeId === replacement.nativeRuntimeId
        );
      expect(replacementFrame).toBeDefined();
      socket.respond(
        JSON.stringify({
          type: 'response',
          requestId: resultFrame.requestId,
          ok: true,
          result: acknowledgement,
        })
      );
      expect(await result).toEqual(acknowledgement);
      socket.respond(
        JSON.stringify({
          type: 'response',
          requestId: replacementFrame.requestId,
          ok: true,
          result: { receiptId: replacementFrame.payload.receiptId, applied: true },
        })
      );
      await waitForReconnect();
      expect(failure).toHaveBeenCalledTimes(1);
      expect(retire).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(2);
    } finally {
      client.close();
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it('uses the legacy session.event frame when event receipts are not negotiated', async () => {
    const fake = new FakeWebSocket();
    const { client } = createClientFixture({ openWebSocket: () => fake as unknown as WebSocket });
    try {
      const connecting = client.connect();
      await handshake(fake);
      await connecting;
      if (!client.publishSessionEvent) throw new Error('Missing session event publisher');
      expect(
        await client.publishSessionEvent(
          {
            type: 'session.message.outcome',
            properties: { messageId: 'msg_1', status: 'completed' },
          },
          { directory: '/workspace', kiloSessionId: 'ses_1', rootKiloSessionId: 'ses_1' }
        )
      ).toBe(true);
      expect(JSON.parse(fake.sent.at(-1) ?? '{}')).toMatchObject({
        type: 'event',
        event: 'session.event',
      });
    } finally {
      client.close();
    }
  });

  it('bounds a producer-shaped 2 MiB PDF event and preserves the following owned outcome', async () => {
    const fake = new FakeWebSocket();
    let disconnected = false;
    const logs: string[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'fake-control-credential',
      providerInstanceId: 'inst_1',
      openWebSocket: () => fake as unknown as WebSocket,
      onDisconnected: () => {
        disconnected = true;
      },
      log: message => logs.push(message),
    });
    const connecting = client.connect();
    await handshake(fake);
    await connecting;
    const identity = {
      directory: '/workspace',
      kiloSessionId: 'ses_1',
      rootKiloSessionId: 'ses_1',
    };
    const inlinePdf = `data:application/pdf;base64,${Buffer.alloc(2 * 1024 * 1024, 65).toString('base64')}`;
    const producer = {
      directory: identity.directory,
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_pdf',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'file',
            mime: 'application/pdf',
            filename: 'attachment.pdf',
            url: inlinePdf,
            source: {
              type: 'file',
              path: '/tmp/attachments/attachment.pdf',
              text: { value: 'private-source-text', start: 0, end: 19 },
            },
          },
        },
      },
    };
    expect(Buffer.byteLength(JSON.stringify(producer))).toBeGreaterThan(
      MAX_SANDBOX_CONTROL_FRAME_BYTES
    );
    try {
      for await (const event of unfilteredKiloEvents([producer])) {
        expect(
          client.sendEvent?.(
            'session.event',
            { type: event.type, properties: event.properties },
            identity
          )
        ).toBe(true);
      }
      const outcome = {
        type: 'session.message.outcome',
        properties: { messageId: 'msg_1', status: 'completed' },
      };
      expect(client.sendEvent?.('session.event', outcome, identity)).toBe(true);
      const frames = fake.sent.slice(2);
      expect(frames).toHaveLength(2);
      expect(
        frames.every(frame => Buffer.byteLength(frame) <= MAX_SANDBOX_CONTROL_FRAME_BYTES)
      ).toBe(true);
      expect(JSON.parse(frames[0] ?? '{}')).toMatchObject({
        session: identity,
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_pdf',
              sessionID: 'ses_1',
              messageID: 'msg_1',
              mime: 'application/pdf',
              filename: 'attachment.pdf',
              url: '',
              source: { text: { value: '' } },
            },
          },
        },
      });
      expect(sessionEventPayloadSchema.parse(JSON.parse(frames[1] ?? '{}').payload)).toEqual(
        outcome
      );
      expect(disconnected).toBe(false);
      expect(fake.readyState).toBe(1);
      expect(logs.join('\n')).not.toContain('private-source-text');
      expect(logs.join('\n')).not.toContain(inlinePdf.slice(0, 100));
      expect(logs.join('\n')).not.toContain('fake-control-credential');
    } finally {
      client.close();
    }
  });

  it('includes the control envelope in its UTF-8 size budget', async () => {
    const fake = new FakeWebSocket();
    let disconnected = false;
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'fake-control-credential',
      providerInstanceId: 'inst_1',
      openWebSocket: () => fake as unknown as WebSocket,
      onDisconnected: () => {
        disconnected = true;
      },
    });
    const connecting = client.connect();
    await handshake(fake);
    await connecting;
    try {
      expect(
        client.sendEvent?.(
          'session.event',
          {
            type: 'diagnostic',
            properties: { text: 'x'.repeat(MAX_SANDBOX_CONTROL_FRAME_BYTES - 256) },
          },
          {
            directory: `/${'d'.repeat(1024)}`,
            kiloSessionId: 'ses_1',
            rootKiloSessionId: 'ses_1',
          }
        )
      ).toBe(true);
      expect(Buffer.byteLength(fake.sent[2] ?? '')).toBeLessThanOrEqual(
        MAX_SANDBOX_CONTROL_FRAME_BYTES
      );
      expect(JSON.parse(fake.sent[2] ?? '{}').payload).toMatchObject({
        type: 'wrapper_event_truncated',
        properties: { kiloEventName: 'diagnostic' },
      });
      expect(disconnected).toBe(false);
    } finally {
      client.close();
    }
  });

  it('reconnects the wrapper connection across an established gap', async () => {
    const sockets: FakeWebSocket[] = [];
    const wrapperInstanceId = crypto.randomUUID();
    let disconnects = 0;
    const options: SandboxControlClientOptions = {
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      wrapperInstanceId,
      reconnectDelayMs: () => 0,
      onDisconnected: () => {
        disconnects += 1;
      },
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    };
    const client = createSandboxControlClient(options);

    const connecting = client.connect();
    await Promise.resolve();
    await handshake(sockets[0], helloResult({ connectionRecovery: true }));
    await connecting;
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toMatchObject({
      payload: { wrapperInstanceId },
    });
    sockets[0]?.close();
    await waitForReconnect();
    expect(sockets).toHaveLength(2);
    expect(disconnects).toBe(0);
    await handshake(sockets[1], helloResult({ connectionRecovery: true }));
    await client.connect();
    expect(
      client.sendEvent?.('session.event', {
        type: 'session.message.outcome',
        properties: { messageId: 'msg_1', status: 'completed' },
      })
    ).toBe(true);
    client.close();
  });

  it('retries a failed sandbox.hello until handshake succeeds', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    const first = sockets[0];
    if (!first) throw new Error('missing first socket');
    first.open();
    await Promise.resolve();
    const hello = JSON.parse(first.sent[0] ?? '{}') as { requestId: string };
    first.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: false,
        error: { code: 'unavailable', message: 'sandbox.hello failed', retryable: true },
      })
    );
    await waitForReconnect();
    expect(sockets).toHaveLength(2);
    await handshake(first);
    expect(first.sent).toHaveLength(1);
    await handshake(sockets[1]);
    await connecting;
    client.close();
  });

  it('retries the initial open failure until handshake succeeds', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    expect(client.connect()).toBe(connecting);
    await Promise.resolve();
    sockets[0]?.close();
    expect(client.connect()).toBe(connecting);
    await waitForReconnect();
    expect(sockets).toHaveLength(2);
    expect(client.connect()).toBe(connecting);
    sockets[0]?.open();
    expect(sockets[0]?.sent).toEqual([]);
    await handshake(sockets[1]);
    await connecting;
    await client.connect();
    expect(sockets).toHaveLength(2);
    client.close();
  });

  it('notifies the runtime once when close and error both fire', async () => {
    const sockets: FakeWebSocket[] = [];
    let disconnects = 0;
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      onDisconnected: () => {
        disconnects += 1;
      },
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    await handshake(sockets[0], helloResult({ connectionRecovery: true }));
    await connecting;
    sockets[0]?.error();
    sockets[0]?.close();
    await waitForReconnect();
    expect(sockets).toHaveLength(2);
    expect(disconnects).toBe(0);
    client.close();
  });

  it('does not reconnect after explicit close', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    await handshake(sockets[0], helloResult({ connectionRecovery: true }));
    await connecting;
    client.close();
    await waitForReconnect();
    await waitForReconnect();
    expect(sockets).toHaveLength(1);
  });

  it('ignores inbound requests and refuses event delivery after the socket is retired', async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1',
      credential: 'secret',
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      onRequest: async () => ({ ok: true, result: { healthy: true } }),
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    await handshake(sockets[0], helloResult({ connectionRecovery: true }));
    await connecting;
    const first = sockets[0];
    if (!first) throw new Error('missing first socket');
    first.close();
    await waitForReconnect();
    expect(sockets).toHaveLength(2);

    first.readyState = 1;
    const sentBefore = first.sent.length;
    first.respond(
      JSON.stringify({
        type: 'request',
        requestId: 'stale-status',
        operation: 'sandbox.status',
        payload: {},
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(first.sent).toHaveLength(sentBefore);

    expect(client.sendEvent?.('sandbox.ready', { kiloReady: true })).toBe(false);
    expect(first.sent).toHaveLength(sentBefore);
    client.close();
  });

  it('retries synchronous socket factory failures through the shared startup promise', async () => {
    const { client, sockets, openWebSocket, onDisconnected } = createClientFixture();
    openWebSocket.mockImplementationOnce(() => {
      throw new Error('socket factory failed');
    });
    try {
      const connecting = client.connect();
      expect(client.connect()).toBe(connecting);
      await waitForReconnect();
      expect(openWebSocket).toHaveBeenCalledTimes(2);
      expect(client.connect()).toBe(connecting);
      await handshake(sockets[0]);
      await connecting;
      expect(onDisconnected).not.toHaveBeenCalled();
    } finally {
      client.close();
    }
  });

  it.each([
    ['scheduled', 'close'],
    ['opening', 'close'],
    ['hello', 'close'],
    ['backoff', 'close'],
    ['opening', 'deadline'],
    ['hello', 'deadline'],
    ['backoff', 'deadline'],
  ] as const)(
    'cancels startup during %s on %s without reporting a disconnect',
    async (phase, stop) => {
      const timers = spyOn(globalThis, 'setTimeout');
      const { client, sockets, openWebSocket, onDisconnected } = createClientFixture({
        reconnectDelayMs: () => SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
      });
      const connecting = client.connect();
      const failure = connecting.catch((error: unknown) => error);
      try {
        if (phase !== 'scheduled') await Promise.resolve();
        if (phase === 'hello') sockets[0]?.open();
        if (phase === 'backoff') {
          sockets[0]?.close();
          await waitForReconnect();
        }
        expect(client.connect()).toBe(connecting);
        if (stop === 'close') client.close();
        else {
          const deadline = timers.mock.calls[0]?.[0];
          if (typeof deadline !== 'function') throw new Error('missing startup deadline');
          deadline();
        }
        expect(await failure).toEqual(
          new Error(
            stop === 'close' ? 'sandbox control client closed' : 'sandbox control startup timeout'
          )
        );
        const sent = sockets[0]?.sent.length;
        sockets[0]?.open();
        sockets[0]?.error();
        await waitForReconnect();
        expect(sockets[0]?.sent.length).toBe(sent);
        expect(openWebSocket).toHaveBeenCalledTimes(phase === 'scheduled' ? 0 : 1);
        expect(onDisconnected).not.toHaveBeenCalled();
        expect(client.connect()).rejects.toThrow('sandbox control client closed');
      } finally {
        client.close();
        timers.mockRestore();
      }
    }
  );

  it('shares one absolute budget across retries and clips the final handshake phase', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(0);
    const timers = spyOn(globalThis, 'setTimeout');
    const { client, sockets, onDisconnected } = createClientFixture();
    const failure = client.connect().catch((error: unknown) => error);
    try {
      await Promise.resolve();
      clock.mockReturnValue(9_000);
      sockets[0]?.open();
      clock.mockReturnValue(19_000);
      sockets[0]?.error();
      await waitForReconnect();
      expect(sockets).toHaveLength(2);
      clock.mockReturnValue(25_000);
      sockets[1]?.open();
      expect(timers.mock.calls.at(-1)?.[1]).toBe(SANDBOX_CONTROL_REQUEST_TIMEOUT_MS - 25_000);
      expect(
        timers.mock.calls.filter(([, ms]) => ms === SANDBOX_CONTROL_REQUEST_TIMEOUT_MS)
      ).toHaveLength(1);
      clock.mockReturnValue(SANDBOX_CONTROL_REQUEST_TIMEOUT_MS);
      await handshake(sockets[1]);
      expect(await failure).toEqual(new Error('sandbox control startup timeout'));
      expect(sockets[1]?.sent).toHaveLength(1);
      expect(sockets[1]?.readyState).toBe(3);
      expect(onDisconnected).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(2);
    } finally {
      client.close();
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it.each(['request', 'close'] as const)(
    'handles an immediate handshake and following %s without a dispatch or loss-listener gap',
    async next => {
      const socket = new FakeWebSocket();
      socket.readyState = 1;
      const onRequest = mock(async () => ({ ok: true, result: { healthy: true } }));
      const { client, onDisconnected } = createClientFixture({
        openWebSocket: () => socket as unknown as WebSocket,
        onRequest,
      });
      socket.send = data => {
        socket.sent.push(data);
        const frame = JSON.parse(data) as { operation?: string; requestId: string };
        if (frame.operation !== 'sandbox.hello') return;
        const status = (requestId: string) =>
          JSON.stringify({
            type: 'request',
            requestId,
            operation: 'sandbox.status',
            payload: {},
          });
        socket.respond('not json');
        socket.respond(status('too-early'));
        socket.respond(
          JSON.stringify({
            type: 'response',
            requestId: 'wrong-hello',
            ok: true,
            result: { protocolVersion: 1, handshakeComplete: true },
          })
        );
        socket.respond(status('still-too-early'));
        socket.respond(
          JSON.stringify({
            type: 'response',
            requestId: frame.requestId,
            ok: true,
            result: { protocolVersion: 1, handshakeComplete: true },
          })
        );
        socket.respond(status('probe'));
        if (next === 'close') socket.close();
        else socket.respond(status('normal-status'));
      };
      try {
        await client.connect();
        await waitForReconnect();
        expect(JSON.parse(socket.sent[1] ?? '{}')).toEqual({
          type: 'response',
          requestId: 'probe',
          ok: true,
        });
        expect(onRequest).toHaveBeenCalledTimes(next === 'request' ? 1 : 0);
        expect(onDisconnected).toHaveBeenCalledTimes(next === 'close' ? 1 : 0);
        expect(socket.sent).toHaveLength(next === 'request' ? 3 : 2);
      } finally {
        client.close();
      }
    }
  );

  it.each([
    'event',
    'outcome-budget',
    'response',
    'oversized-response',
    'invalid-response',
    'ping',
    'closed-socket',
  ] as const)('retires once on established %s delivery failure', async failure => {
    const timers = spyOn(globalThis, 'setInterval');
    const { client, sockets, openWebSocket, onDisconnected } = createClientFixture({
      onRequest: async () => ({
        ok: true,
        result:
          failure === 'oversized-response'
            ? 'x'.repeat(MAX_SANDBOX_CONTROL_FRAME_BYTES)
            : failure === 'invalid-response'
              ? 1n
              : undefined,
      }),
    });
    try {
      const connecting = client.connect();
      await Promise.resolve();
      await handshake(sockets[0], helloResult({ connectionRecovery: true }));
      await connecting;
      const socket = sockets[0];
      if (!socket) throw new Error('missing socket');
      if (failure === 'closed-socket') socket.readyState = 3;
      else if (failure !== 'outcome-budget')
        socket.send = () => {
          throw new Error('send failed');
        };
      if (
        failure === 'response' ||
        failure === 'oversized-response' ||
        failure === 'invalid-response'
      ) {
        socket.respond(
          JSON.stringify({
            type: 'request',
            requestId: 'normal-status',
            operation: 'sandbox.status',
            payload: {},
          })
        );
      } else if (failure === 'ping') {
        const ping = timers.mock.calls[0]?.[0];
        if (typeof ping !== 'function') throw new Error('missing keepalive');
        ping();
        ping();
      } else {
        expect(
          client.sendEvent?.(
            'session.event',
            {
              type: 'session.message.outcome',
              properties: { messageId: 'msg_1', status: 'completed' },
            },
            {
              directory:
                failure === 'outcome-budget'
                  ? 'd'.repeat(MAX_SANDBOX_CONTROL_FRAME_BYTES)
                  : '/workspace',
            }
          )
        ).toBe(false);
      }
      await waitForReconnect();
      socket.error();
      socket.close();
      expect(onDisconnected).toHaveBeenCalledTimes(0);
      expect(openWebSocket).toHaveBeenCalledTimes(2);
      expect(client.sendEvent?.('sandbox.ready', { kiloReady: true })).toBe(false);
    } finally {
      client.close();
      timers.mockRestore();
    }
  });

  it('fences handler completion and further requests after retirement even if the socket appears open', async () => {
    const outcome = Promise.withResolvers<{ ok: boolean }>();
    const onRequest = mock(() => outcome.promise);
    const { client, sockets, onDisconnected } = createClientFixture({ onRequest });
    try {
      const connecting = client.connect();
      await Promise.resolve();
      await handshake(sockets[0], helloResult({ connectionRecovery: true }));
      await connecting;
      const socket = sockets[0];
      if (!socket) throw new Error('missing socket');
      const request = JSON.stringify({
        type: 'request',
        requestId: 'pending-status',
        operation: 'sandbox.status',
        payload: {},
      });
      socket.respond(request);
      socket.close();
      socket.readyState = 1;
      socket.respond(request);
      outcome.resolve({ ok: true });
      await waitForReconnect();
      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(socket.sent).toHaveLength(2);
      expect(onDisconnected).toHaveBeenCalledTimes(0);
    } finally {
      outcome.resolve({ ok: true });
      client.close();
    }
  });

  it('does not log credentials included in an untrusted handshake failure', async () => {
    const credential = 'super-secret-token';
    const logs: string[] = [];
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1?token=signed-url-secret',
      credential,
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      log: message => logs.push(message),
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    const first = sockets[0];
    if (!first) throw new Error('missing first socket');
    first.open();
    await Promise.resolve();
    const hello = JSON.parse(first.sent[0] ?? '{}') as { requestId: string };
    first.respond(
      JSON.stringify({
        type: 'response',
        requestId: hello.requestId,
        ok: false,
        error: {
          code: 'unauthorized',
          message: `rejected ${credential} signed-url-secret`,
          retryable: true,
        },
      })
    );
    await waitForReconnect();
    await handshake(sockets[1]);
    await connecting;

    expect(logs.join('\n')).not.toContain(credential);
    expect(logs.join('\n')).not.toContain('signed-url-secret');
    expect(logs).toContain('sandbox control connect failed');
    client.close();
  });

  it('does not log credentials or the signed url on retry', async () => {
    const credential = 'super-secret-token';
    const logs: string[] = [];
    const sockets: FakeWebSocket[] = [];
    const client = createSandboxControlClient({
      url: 'wss://example.test/sandbox-control/sbx_1?token=signed-url-secret',
      credential,
      providerInstanceId: 'inst_1',
      reconnectDelayMs: () => 0,
      log: message => logs.push(message),
      openWebSocket: () => {
        const next = new FakeWebSocket();
        sockets.push(next);
        return next as unknown as WebSocket;
      },
    });

    const connecting = client.connect();
    await Promise.resolve();
    sockets[0]?.close();
    await waitForReconnect();
    await handshake(sockets[1]);
    await connecting;
    const joined = logs.join('\n');
    expect(joined).not.toContain(credential);
    expect(joined).not.toContain('signed-url-secret');
    expect(joined).not.toContain('Authorization');
    expect(joined).toContain('sandbox control connect failed');
    client.close();
  });
});

async function handshake(
  fake: FakeWebSocket | undefined,
  result: unknown = { protocolVersion: 1, handshakeComplete: true }
): Promise<void> {
  if (!fake) throw new Error('missing socket');
  await Promise.resolve();
  fake.open();
  await Promise.resolve();
  const hello = JSON.parse(fake.sent[0] ?? '{}') as { requestId: string };
  fake.respond(
    JSON.stringify({
      type: 'response',
      requestId: hello.requestId,
      ok: true,
      result,
    })
  );
  fake.respond(
    JSON.stringify({
      type: 'request',
      requestId: 'status-1',
      operation: 'sandbox.status',
      payload: {},
    })
  );
  await Promise.resolve();
}

async function waitForReconnect(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}
