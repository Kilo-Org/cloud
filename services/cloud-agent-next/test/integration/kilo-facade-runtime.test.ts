import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { registerReadySession } from '../helpers/session-setup.js';

const userId = 'user_facade_runtime';
const cloudAgentSessionId = 'agent_facade_runtime';
const kiloSessionId = 'ses_12345678901234567890123456';
const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;

type WrapperIdentity = {
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
};

type SseDataReader = {
  next(): Promise<unknown>;
  cancel(): Promise<void>;
};

function createSseDataReader(response: Response): SseDataReader {
  if (!response.body) {
    throw new Error('Expected an SSE response body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async next(): Promise<unknown> {
      for (;;) {
        const delimiter = buffer.indexOf('\n\n');
        if (delimiter >= 0) {
          const frame = buffer.slice(0, delimiter);
          buffer = buffer.slice(delimiter + 2);
          const data = frame
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice('data:'.length).trimStart())
            .join('\n');
          if (data) return JSON.parse(data) as unknown;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Expected another SSE data frame');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async cancel(): Promise<void> {
      await reader.cancel();
    },
  };
}

async function configureCurrentProducer(identity: WrapperIdentity): Promise<void> {
  const session = env.CLOUD_AGENT_SESSION.get(
    env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${cloudAgentSessionId}`)
  );
  await runInDurableObject(session, async instance => {
    const metadata = await instance.getMetadata();
    if (!metadata) {
      await registerReadySession(instance, {
        sessionId: cloudAgentSessionId,
        userId,
        kiloSessionId,
        prompt: 'runtime facade fixture',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'test-token',
      });
    }
    await instance.ctx.storage.put('wrapper_runtime_state', identity);
  });
}

async function connectProducer(identity: WrapperIdentity): Promise<WebSocket> {
  const query = new URLSearchParams({
    userId,
    cloudAgentSessionId,
    kiloSessionId,
    wrapperRunId: identity.wrapperRunId,
    wrapperGeneration: String(identity.wrapperGeneration),
    wrapperConnectionId: identity.wrapperConnectionId,
  });
  const response = await SELF.fetch(`http://worker.test/kilo-global-feed-test?${query}`, {
    headers: { Upgrade: 'websocket' },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Unexpected producer upgrade response: ${response.status}`);
  }
  response.webSocket.accept();
  return response.webSocket;
}

function closeEvent(ws: WebSocket): Promise<CloseEvent> {
  return new Promise(resolve => {
    ws.addEventListener('close', event => resolve(event), { once: true });
  });
}

async function readProducerMarker(): Promise<unknown> {
  const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
  return runInDurableObject(facade, async (_instance, state) =>
    state.storage.get(`producer:${cloudAgentSessionId}`)
  );
}

describe('UserKiloFacade in the Workers runtime', () => {
  it('routes a public facade request to the user Durable Object', async () => {
    const response = await SELF.fetch(
      `http://worker.test/kilo-test/kilo/global/event?userId=${userId}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const stream = createSseDataReader(response);
    try {
      await expect(stream.next()).resolves.toMatchObject({
        directory: '/cloud-agent',
        payload: { type: 'server.connected', properties: {} },
      });
    } finally {
      await stream.cancel();
    }
  });

  it('fans redacted Cloud Agent lifecycle extensions out before any wrapper producer is live', async () => {
    const extensionUserId = 'user_facade_extension';
    const extensionCloudAgentSessionId = 'agent_facade_extension';
    const extensionKiloSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
    const session = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${extensionUserId}:${extensionCloudAgentSessionId}`)
    );
    await runInDurableObject(session, async instance => {
      await registerReadySession(instance, {
        sessionId: extensionCloudAgentSessionId,
        userId: extensionUserId,
        kiloSessionId: extensionKiloSessionId,
        prompt: 'extension fixture',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'test-token',
      });
    });
    const scopedResponse = await SELF.fetch(
      `http://worker.test/kilo-scoped-event-test?userId=${extensionUserId}&kiloSessionId=${extensionKiloSessionId}`
    );
    const scopedStream = createSseDataReader(scopedResponse);
    const messageId = 'msg_018f1e2d3c4bFacadeQueueABC';

    try {
      await expect(scopedStream.next()).resolves.toMatchObject({ type: 'server.connected' });
      await runInDurableObject(session, async instance => {
        const emit = (streamEventType: string, payload: unknown) => {
          instance.broadcastEvent({
            id: 0 as never,
            execution_id: messageId,
            session_id: extensionCloudAgentSessionId,
            stream_event_type: streamEventType,
            payload: JSON.stringify(payload),
            timestamp: Date.now(),
          });
        };
        emit('cloud.message.queued', {
          messageId,
          content: 'wake from cold facade',
          delivery: 'queued',
        });
        emit('cloud.status', {
          cloudStatus: {
            type: 'preparing',
            step: 'kilo_session',
            message: 'Restoring /workspace/private/session',
          },
        });
        emit('cloud.message.sent', { messageId, delivery: 'sent' });
        emit('cloud.message.completed', {
          messageId,
          status: 'completed',
          delivery: 'sent',
          accepted: true,
          assistantMessageId: 'msg_private_assistant',
        });
      });
      await expect(scopedStream.next()).resolves.toEqual({
        type: 'cloud.message.queued',
        properties: {
          sessionID: extensionKiloSessionId,
          messageId,
          delivery: 'queued',
        },
      });
      await expect(scopedStream.next()).resolves.toEqual({
        type: 'cloud.status',
        properties: {
          sessionID: extensionKiloSessionId,
          cloudStatus: { type: 'preparing', step: 'kilo_session' },
        },
      });
      await expect(scopedStream.next()).resolves.toEqual({
        type: 'cloud.message.sent',
        properties: { sessionID: extensionKiloSessionId, messageId, delivery: 'sent' },
      });
      await expect(scopedStream.next()).resolves.toEqual({
        type: 'cloud.message.completed',
        properties: {
          sessionID: extensionKiloSessionId,
          messageId,
          status: 'completed',
          delivery: 'sent',
          accepted: true,
        },
      });
    } finally {
      await scopedStream.cancel();
    }
  });

  it('fans a producer event through to global and session-scoped public SSE', async () => {
    const identity = {
      wrapperRunId: 'wr_facade_runtime_1',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_facade_runtime_1',
    } satisfies WrapperIdentity;
    await configureCurrentProducer(identity);

    const globalResponse = await SELF.fetch(
      `http://worker.test/kilo-test/kilo/global/event?userId=${userId}`
    );
    const scopedResponse = await SELF.fetch(
      `http://worker.test/kilo-scoped-event-test?userId=${userId}&kiloSessionId=${kiloSessionId}`
    );
    const globalStream = createSseDataReader(globalResponse);
    const scopedStream = createSseDataReader(scopedResponse);
    const producer = await connectProducer(identity);

    try {
      await expect(globalStream.next()).resolves.toMatchObject({
        payload: { type: 'server.connected' },
      });
      await expect(scopedStream.next()).resolves.toMatchObject({ type: 'server.connected' });

      producer.send(
        JSON.stringify({
          directory: '/workspace/private/session',
          payload: { type: 'file.edited', properties: {} },
        })
      );
      producer.send(
        JSON.stringify({
          directory: '/workspace/private/session',
          payload: {
            type: 'session.idle',
            properties: { sessionID: 'ses_22222222222222222222222222' },
          },
        })
      );
      producer.send(
        JSON.stringify({
          directory: '/workspace/private/session',
          payload: {
            id: 'evt_runtime_message',
            type: 'message.updated',
            properties: {
              sessionID: kiloSessionId,
              info: {
                id: 'msg_runtime_assistant',
                sessionID: kiloSessionId,
                role: 'assistant',
                path: { cwd: '/workspace/private/session', root: '/workspace/private' },
              },
            },
          },
        })
      );

      const globalEvent = await globalStream.next();
      const scopedEvent = await scopedStream.next();
      expect(globalEvent).toEqual({
        directory: publicDirectory,
        payload: {
          id: 'evt_runtime_message',
          type: 'message.updated',
          properties: {
            sessionID: kiloSessionId,
            info: {
              id: 'msg_runtime_assistant',
              sessionID: kiloSessionId,
              role: 'assistant',
              path: { cwd: '/workspace/private/session', root: '/workspace/private' },
            },
          },
        },
      });
      expect(scopedEvent).toEqual({
        id: 'evt_runtime_message',
        type: 'message.updated',
        properties: {
          sessionID: kiloSessionId,
          info: {
            id: 'msg_runtime_assistant',
            sessionID: kiloSessionId,
            role: 'assistant',
            path: { cwd: '/workspace/private/session', root: '/workspace/private' },
          },
        },
      });
      // Periodic liveness uses a 10 second comment cadence; the timed comment assertion remains in
      // focused facade tests, while runtime data delivery must never introduce a heartbeat variant.
      expect(JSON.stringify([globalEvent, scopedEvent])).not.toContain('server.heartbeat');
    } finally {
      producer.close(1000, 'test complete');
      await globalStream.cancel();
      await scopedStream.cancel();
    }
  });

  it('replaces an older producer and rejects its stale reconnect', async () => {
    const firstIdentity = {
      wrapperRunId: 'wr_facade_replaced_1',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_facade_replaced_1',
    } satisfies WrapperIdentity;
    const nextIdentity = {
      wrapperRunId: 'wr_facade_replaced_2',
      wrapperGeneration: 2,
      wrapperConnectionId: 'conn_facade_replaced_2',
    } satisfies WrapperIdentity;
    await configureCurrentProducer(firstIdentity);
    const first = await connectProducer(firstIdentity);
    await expect(readProducerMarker()).resolves.toBeUndefined();
    const replaced = closeEvent(first);

    await configureCurrentProducer(nextIdentity);
    const next = await connectProducer(nextIdentity);
    const replacementClose = await replaced;
    expect(replacementClose.code).toBe(1000);
    expect(replacementClose.reason).toBe('Replaced by newer global feed');

    const staleQuery = new URLSearchParams({
      userId,
      cloudAgentSessionId,
      kiloSessionId,
      wrapperRunId: firstIdentity.wrapperRunId,
      wrapperGeneration: String(firstIdentity.wrapperGeneration),
      wrapperConnectionId: firstIdentity.wrapperConnectionId,
    });
    const staleResponse = await SELF.fetch(
      `http://worker.test/kilo-global-feed-test?${staleQuery}`,
      { headers: { Upgrade: 'websocket' } }
    );
    expect(staleResponse.status).toBe(409);
    await expect(readProducerMarker()).resolves.toBeUndefined();

    next.close(1000, 'test complete');
    await expect(readProducerMarker()).resolves.toBeUndefined();
  });
});
