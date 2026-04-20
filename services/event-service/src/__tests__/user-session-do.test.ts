import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Helper: connect a WebSocket to a DO stub for a given userId
async function connectWs(userId: string): Promise<{ ws: WebSocket; stub: ReturnType<typeof env.USER_SESSION_DO.get> }> {
  const id = env.USER_SESSION_DO.idFromName(userId);
  const stub = env.USER_SESSION_DO.get(id);
  const res = await stub.fetch('https://do/connect', {
    headers: { Upgrade: 'websocket' },
  });
  const ws = res.webSocket!;
  ws.accept();
  return { ws, stub };
}

// Helper: collect the next message from a WebSocket
function nextMessage(ws: WebSocket, timeoutMs = 500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.addEventListener('message', (evt: MessageEvent) => {
      clearTimeout(timer);
      resolve(JSON.parse(evt.data as string));
    });
  });
}

describe('UserSessionDO', () => {
  it('accepts WebSocket upgrades with status 101', async () => {
    const id = env.USER_SESSION_DO.idFromName('user-upgrade-test');
    const stub = env.USER_SESSION_DO.get(id);
    const res = await stub.fetch('https://do/connect', {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
    const ws = res.webSocket!;
    ws.accept();
    ws.close();
  });

  it('rejects non-WebSocket requests with status 426', async () => {
    const id = env.USER_SESSION_DO.idFromName('user-reject-test');
    const stub = env.USER_SESSION_DO.get(id);
    const res = await stub.fetch('https://do/connect');
    expect(res.status).toBe(426);
  });

  it('delivers events to connections with matching context', async () => {
    const userId = 'user-event-match';
    const { ws, stub } = await connectWs(userId);

    ws.send(
      JSON.stringify({ type: 'context.subscribe', contexts: ['project:abc'] })
    );

    await new Promise(r => setTimeout(r, 50));

    const msgPromise = nextMessage(ws);

    await stub.pushEvent('project:abc', 'task.created', { taskId: '1' });

    const msg = await msgPromise;
    expect(msg).toEqual({
      type: 'event',
      context: 'project:abc',
      event: 'task.created',
      payload: { taskId: '1' },
    });

    ws.close();
  });

  it('does NOT deliver events for non-matching contexts', async () => {
    const userId = 'user-event-no-match';
    const { ws, stub } = await connectWs(userId);

    ws.send(
      JSON.stringify({ type: 'context.subscribe', contexts: ['project:abc'] })
    );

    await new Promise(r => setTimeout(r, 50));

    let received = false;
    ws.addEventListener('message', () => {
      received = true;
    });

    await stub.pushEvent('project:xyz', 'task.created', { taskId: '2' });

    // Wait briefly to ensure no message arrives
    await new Promise(r => setTimeout(r, 100));
    expect(received).toBe(false);

    ws.close();
  });

  it('stops delivering after unsubscribe', async () => {
    const userId = 'user-event-unsub';
    const { ws, stub } = await connectWs(userId);

    ws.send(
      JSON.stringify({ type: 'context.subscribe', contexts: ['project:abc'] })
    );
    await new Promise(r => setTimeout(r, 50));

    ws.send(
      JSON.stringify({ type: 'context.unsubscribe', contexts: ['project:abc'] })
    );
    await new Promise(r => setTimeout(r, 50));

    let received = false;
    ws.addEventListener('message', () => {
      received = true;
    });

    await stub.pushEvent('project:abc', 'task.created', { taskId: '3' });

    await new Promise(r => setTimeout(r, 100));
    expect(received).toBe(false);

    ws.close();
  });

  it('forwards RPC calls to kilo-chat and returns echo response', async () => {
    const userId = 'user-rpc-test';
    const { ws } = await connectWs(userId);

    const msgPromise = nextMessage(ws);

    ws.send(
      JSON.stringify({
        id: 'req-1',
        type: 'rpc',
        service: 'kilo-chat',
        method: 'getMessages',
        payload: { channelId: 'ch-1' },
      })
    );

    const msg = await msgPromise;
    // The DO uses ctx.id.name ?? ctx.id.toString() for userId; in the test env
    // miniflare may return the hashed ID string rather than the name, so we
    // only assert the shape and method/payload echo, not the exact userId value.
    expect(msg).toMatchObject({
      id: 'req-1',
      type: 'rpc.response',
      payload: {
        echo: {
          userId: expect.any(String),
          method: 'getMessages',
          payload: { channelId: 'ch-1' },
        },
      },
    });

    ws.close();
  });

  it('returns rpc.error for unknown service', async () => {
    const userId = 'user-rpc-unknown';
    const { ws } = await connectWs(userId);

    const msgPromise = nextMessage(ws);

    ws.send(
      JSON.stringify({
        id: 'req-2',
        type: 'rpc',
        service: 'nonexistent-service',
        method: 'doSomething',
        payload: {},
      })
    );

    const msg = await msgPromise;
    expect(msg).toMatchObject({
      id: 'req-2',
      type: 'rpc.error',
      error: { code: 404 },
    });

    ws.close();
  });
});
