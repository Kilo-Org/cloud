import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('WorkerEntrypoint.isUserInContext', () => {
  it('delegates to UserSessionDO.hasContext', async () => {
    // Verify the entrypoint method exists and forwards to the DO.
    // With no sockets open for this user, hasContext must return false.
    const result = await (SELF as any).isUserInContext('u', '/nope');
    expect(result).toBe(false);
  });

  it('returns true when the user has an active socket subscribed to that context', async () => {
    const userId = 'in-context-user';
    const stub = env.USER_SESSION_DO.get(env.USER_SESSION_DO.idFromName(userId));
    const res = await stub.fetch('https://do/connect', {
      headers: { Upgrade: 'websocket' },
    });
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: 'context.subscribe', contexts: ['/chat/123'] }));
    await new Promise(r => setTimeout(r, 50));

    const result = await (SELF as any).isUserInContext(userId, '/chat/123');
    expect(result).toBe(true);

    ws.close();
  });
});
