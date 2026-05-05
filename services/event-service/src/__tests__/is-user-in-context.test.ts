import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// EVENT_SERVICE_SELF is configured in vitest.config.mts via miniflare's
// kCurrentWorker symbol — it's a service binding pointed at this same worker
// so tests can invoke RPC methods on the WorkerEntrypoint directly.
function getSelf() {
  return (env as unknown as Record<string, unknown>).EVENT_SERVICE_SELF as {
    isUserInContext(userId: string, context: string): Promise<boolean>;
  };
}

async function subscribe(userId: string, contexts: string[]): Promise<WebSocket> {
  const id = env.USER_SESSION_DO.idFromName(userId);
  const stub = env.USER_SESSION_DO.get(id);
  const res = await stub.fetch('https://do/connect', {
    headers: { Upgrade: 'websocket' },
  });
  const ws = res.webSocket!;
  ws.accept();
  ws.send(JSON.stringify({ type: 'context.subscribe', contexts }));
  await new Promise(r => setTimeout(r, 50));
  return ws;
}

describe('event-service isUserInContext', () => {
  it('returns false when the user has no live sockets', async () => {
    const self = getSelf();
    const result = await self.isUserInContext('user-no-sockets', '/presence/web');
    expect(result).toBe(false);
  });

  it('returns true when the user has a socket subscribed to the context', async () => {
    await subscribe('user-with-sub', ['/presence/app']);
    const self = getSelf();
    const result = await self.isUserInContext('user-with-sub', '/presence/app');
    expect(result).toBe(true);
  });

  it('returns false when the user is subscribed to a different context', async () => {
    await subscribe('user-other-sub', ['/presence/app']);
    const self = getSelf();
    const result = await self.isUserInContext('user-other-sub', '/presence/web');
    expect(result).toBe(false);
  });
});
