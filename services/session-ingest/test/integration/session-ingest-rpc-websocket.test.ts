import { adminSecretsStore, env } from 'cloudflare:test';
import { expect, it } from 'vitest';

const INTERNAL_SECRET = 'workers-runtime-internal-secret';

function nextMessage(webSocket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    webSocket.addEventListener('message', resolve, { once: true });
    webSocket.addEventListener(
      'error',
      () => reject(new Error('WebSocket failed before receiving a message')),
      { once: true }
    );
  });
}

it('upgrades through the SessionIngestRPC binding and receives a committed session update', async () => {
  await adminSecretsStore(env.INTERNAL_API_SECRET_PROD).create(INTERNAL_SECRET);

  const kiloUserId = 'usr_workers_runtime_integration';
  const response = await env.SESSION_INGEST.fetch(
    new Request(
      'https://session-ingest.test/internal/user/events?connectionId=facade-integration',
      {
        headers: {
          Upgrade: 'websocket',
          'X-Internal-Secret': INTERNAL_SECRET,
          'X-Kilo-User-Id': kiloUserId,
        },
      }
    )
  );

  expect(response.status).toBe(101);
  const webSocket = response.webSocket;
  expect(webSocket).not.toBeNull();
  if (!webSocket) throw new Error('Expected SessionIngestRPC to return a WebSocket');
  webSocket.accept();

  const initialMessage = await nextMessage(webSocket);
  expect(JSON.parse(String(initialMessage.data))).toMatchObject({
    type: 'system',
    event: 'sessions.list',
  });

  const session = {
    source: 'v2' as const,
    sessionId: 'ses_12345678901234567890123456',
    createdAt: '2026-06-08T20:00:00.000Z',
    updatedAt: '2026-06-08T20:01:00.000Z',
    title: 'Committed Workers runtime title',
    createdOnPlatform: 'cloud-agent',
    organizationId: null,
    gitUrl: null,
    gitBranch: null,
    parentSessionId: null,
    status: 'idle' as const,
    statusUpdatedAt: null,
  };
  const semanticMessage = nextMessage(webSocket);
  const notification = await env.USER_CONNECTION_DO.getByName(kiloUserId).notifySessionEvent({
    type: 'session.updated',
    data: { source: 'v2', session, changedAt: session.updatedAt },
  });

  expect(notification).toEqual({ delivered: 1 });
  expect(JSON.parse(String((await semanticMessage).data))).toEqual({
    type: 'system',
    event: 'session.updated',
    data: { source: 'v2', session, changedAt: session.updatedAt },
  });

  webSocket.close(1000, 'test complete');
});
