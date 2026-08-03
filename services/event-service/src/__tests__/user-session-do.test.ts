import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Helper: connect a WebSocket to a DO stub for a given userId
async function connectWs(
  userId: string
): Promise<{ ws: WebSocket; stub: ReturnType<typeof env.USER_SESSION_DO.get> }> {
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

    ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['project:abc'] }));

    await new Promise(r => setTimeout(r, 50));

    const msgPromise = nextMessage(ws);

    await stub.pushEvent('project:abc', 'task.created', { taskId: '1' });

    const msg = await msgPromise;
    expect(msg).toEqual({
      type: 'event',
      context: 'project:abc',
      event: 'task.created',
      payload: { taskId: '1' },
      seq: 1,
    });

    ws.close();
  });

  it('does NOT deliver events for non-matching contexts', async () => {
    const userId = 'user-event-no-match';
    const { ws, stub } = await connectWs(userId);

    ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['project:abc'] }));

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

  it('pushEvent returns true when connection has matching context', async () => {
    const userId = 'user-present-match';
    const { ws, stub } = await connectWs(userId);

    ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['project:present'] }));
    await new Promise(r => setTimeout(r, 50));

    const result = await stub.pushEvent('project:present', 'test', {});
    expect(result).toBe(true);

    ws.close();
  });

  it('pushEvent returns false when no matching context', async () => {
    const userId = 'user-present-no-match';
    const { ws, stub } = await connectWs(userId);

    ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['project:a'] }));
    await new Promise(r => setTimeout(r, 50));

    const result = await stub.pushEvent('project:b', 'test', {});
    expect(result).toBe(false);

    ws.close();
  });

  it('pushEvent returns false when no connections', async () => {
    const id = env.USER_SESSION_DO.idFromName('user-present-no-connections');
    const stub = env.USER_SESSION_DO.get(id);

    const result = await stub.pushEvent('project:any', 'test', {});
    expect(result).toBe(false);
  });

  it('stops delivering after unsubscribe', async () => {
    const userId = 'user-event-unsub';
    const { ws, stub } = await connectWs(userId);

    ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['project:abc'] }));
    await new Promise(r => setTimeout(r, 50));

    ws.send(JSON.stringify({ type: 'context.unsubscribe', contexts: ['project:abc'] }));
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

  it('includes an incrementing seq in each event', async () => {
    const userId = 'user-seq-increment';
    const { ws, stub } = await connectWs(userId);

    ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['project:seq'] }));
    await new Promise(r => setTimeout(r, 50));

    const msg1Promise = nextMessage(ws);
    await stub.pushEvent('project:seq', 'task.created', { taskId: '1' });
    const msg1 = await msg1Promise;
    expect(msg1).toMatchObject({ type: 'event', seq: 1 });

    const msg2Promise = nextMessage(ws);
    await stub.pushEvent('project:seq', 'task.updated', { taskId: '2' });
    const msg2 = await msg2Promise;
    expect(msg2).toMatchObject({ type: 'event', seq: 2 });

    const msg3Promise = nextMessage(ws);
    await stub.pushEvent('project:seq', 'task.deleted', { taskId: '3' });
    const msg3 = await msg3Promise;
    expect(msg3).toMatchObject({ type: 'event', seq: 3 });

    ws.close();
  });

  it('updates acked on receipt of an ack message', async () => {
    const userId = 'user-ack-update';
    const { ws, stub } = await connectWs(userId);

    ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['project:ack'] }));
    await new Promise(r => setTimeout(r, 100));

    // Push two events and drain messages to ensure seq is built
    const msg1Promise = nextMessage(ws, 2000);
    await stub.pushEvent('project:ack', 'e1', {});
    await msg1Promise;

    const msg2Promise = nextMessage(ws, 2000);
    await stub.pushEvent('project:ack', 'e2', {});
    await msg2Promise;

    // Send ack for seq 2
    ws.send(JSON.stringify({ type: 'ack', seq: 2 }));
    await new Promise(r => setTimeout(r, 100));

    // Push one more event — socket should still be open (gap is 1)
    const msg3Promise = nextMessage(ws, 2000);
    await stub.pushEvent('project:ack', 'e3', {});
    const msg3 = await msg3Promise;
    expect(msg3).toMatchObject({ type: 'event', seq: 3 });

    ws.close();
  });

  it(
    'closes socket with code 4002 when unacked gap exceeds threshold',
    { timeout: 15000 },
    async () => {
      const userId = 'user-zombie-close';
      const { ws, stub } = await connectWs(userId);

      ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['project:z'] }));
      await new Promise(r => setTimeout(r, 100));

      // Ack seq 0 — the socket is now eligible for zombie close
      ws.send(JSON.stringify({ type: 'ack', seq: 0 }));
      await new Promise(r => setTimeout(r, 100));

      const closePromise = new Promise<CloseEvent>(resolve => {
        ws.addEventListener('close', resolve);
      });

      // Push enough events to exceed UNACKED_THRESHOLD (50).
      // seq starts at 0, increments each push. After N pushes seq = N.
      // Gap = seq - acked = N - 0. Need N > 50.
      // Push 55 events for margin.
      for (let i = 0; i < 55; i++) {
        await stub.pushEvent('project:z', 'fill', {});
        // Brief pause to let the DO process the message and potential close
        await new Promise(r => setTimeout(r, 20));
        // Check if we already closed
        if (ws.readyState === 3 /* CLOSED */) break;
      }

      const closeEvent = await closePromise;
      expect(closeEvent.code).toBe(4002);
    }
  );

  it(
    'never closes a socket that has not acknowledged (old client compat)',
    { timeout: 15000 },
    async () => {
      const userId = 'user-no-ack-no-close';
      const { ws, stub } = await connectWs(userId);

      ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['project:noack'] }));
      await new Promise(r => setTimeout(r, 100));

      let closed = false;
      ws.addEventListener('close', () => {
        closed = true;
      });

      // Push many events without any ack — should never trigger zombie close
      for (let i = 0; i < 60; i++) {
        await stub.pushEvent('project:noack', 'fill', {});
        await new Promise(r => setTimeout(r, 10));
        if (closed) break;
      }

      expect(closed).toBe(false);
      ws.close();
    }
  );

  it('closes sockets that exceed the per-socket context limit', async () => {
    const userId = 'user-too-many-contexts';
    const { ws, stub } = await connectWs(userId);
    const contexts = Array.from({ length: 201 }, (_, idx) => `project:${idx}`);

    ws.send(JSON.stringify({ type: 'context.subscribe', contexts }));
    await new Promise(r => setTimeout(r, 50));

    expect(await stub.pushEvent('project:200', 'test', {})).toBe(false);
    ws.close();
  });

  it(
    'defaults counters to zero and emits sequence one with old attachment',
    { timeout: 15000 },
    async () => {
      // Load a WebSocket whose server-side attachment has only the old
      // shape: `{ contexts: ['project:old'] }`.  The DO fetches a new
      // attachment; we overwrite it with the old shape inside the DO.
      const userId = 'user-old-attachment';
      const id = env.USER_SESSION_DO.idFromName(userId);
      const stub = env.USER_SESSION_DO.get(id);

      const res = await stub.fetch('https://do/connect', {
        headers: { Upgrade: 'websocket' },
      });
      const ws = res.webSocket!;
      ws.accept();

      const rawState = await runInDurableObject(stub, async (_instance, state) => {
        const sockets = state.getWebSockets();
        const serverSocket = sockets[0]!;
        serverSocket.serializeAttachment({ contexts: ['project:old'] });
        return serverSocket.deserializeAttachment();
      });

      // The old attachment lacks seq, acked, and ackReceived.
      // getState defaults them to 0, 0, false.
      expect(rawState).toEqual({ contexts: ['project:old'] });

      // First event: the missing seq defaults to 0 → pushEvent emits seq=1.
      const msg1Promise = nextMessage(ws, 2000);
      await stub.pushEvent('project:old', 'test', {});
      const msg1 = await msg1Promise;
      expect(msg1).toMatchObject({ type: 'event', seq: 1 });

      // Second event: increments to seq=2.
      const msg2Promise = nextMessage(ws, 2000);
      await stub.pushEvent('project:old', 'test', {});
      const msg2 = await msg2Promise;
      expect(msg2).toMatchObject({ type: 'event', seq: 2 });

      // Without an ack the socket is never zombie-closed.
      let closed = false;
      ws.addEventListener('close', () => {
        closed = true;
      });

      for (let i = 0; i < 60; i++) {
        await stub.pushEvent('project:old', 'fill', {});
        await new Promise(r => setTimeout(r, 10));
        if (closed) break;
      }

      expect(closed).toBe(false);
      ws.close();
    }
  );
});
