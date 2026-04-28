import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { UserSessionDO } from '../do/user-session-do';

function getStub(userId: string) {
  const id = env.USER_SESSION_DO.idFromName(userId);
  return env.USER_SESSION_DO.get(id) as DurableObjectStub<UserSessionDO>;
}

describe('UserSessionDO.hasContext', () => {
  it('returns false when no sockets are connected', async () => {
    const stub = getStub('user-1');
    expect(await stub.hasContext('/a/b')).toBe(false);
  });

  it('returns true when a socket is subscribed to that context', async () => {
    const stub = getStub('user-2');
    await runInDurableObject(stub, async (_instance, ctx) => {
      const pair = new WebSocketPair();
      ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ contexts: ['/a/b'] });
    });
    expect(await stub.hasContext('/a/b')).toBe(true);
    expect(await stub.hasContext('/a/c')).toBe(false);
  });

  it("returns true if any of the user's sockets has the context", async () => {
    const stub = getStub('user-3');
    await runInDurableObject(stub, async (_instance, ctx) => {
      const pair1 = new WebSocketPair();
      ctx.acceptWebSocket(pair1[1]);
      pair1[1].serializeAttachment({ contexts: ['/x'] });
      const pair2 = new WebSocketPair();
      ctx.acceptWebSocket(pair2[1]);
      pair2[1].serializeAttachment({ contexts: ['/y'] });
    });
    expect(await stub.hasContext('/x')).toBe(true);
    expect(await stub.hasContext('/y')).toBe(true);
    expect(await stub.hasContext('/z')).toBe(false);
  });
});
