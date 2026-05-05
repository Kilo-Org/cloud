import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { UserSessionDO } from '../do/user-session-do';

function getStub(userId: string) {
  const id = env.USER_SESSION_DO.idFromName(userId);
  return env.USER_SESSION_DO.get(id);
}

async function attachContexts(
  stub: ReturnType<typeof getStub>,
  contexts: string[]
): Promise<WebSocket> {
  const res = await stub.fetch('https://do/connect', {
    headers: { Upgrade: 'websocket' },
  });
  const ws = res.webSocket!;
  ws.accept();
  ws.send(JSON.stringify({ type: 'context.subscribe', contexts }));
  await new Promise(r => setTimeout(r, 50));
  return ws;
}

describe('UserSessionDO.hasContext', () => {
  it('returns false when no sockets are open', async () => {
    const stub = getStub('user-no-sockets');
    await runInDurableObject(stub, async (instance: UserSessionDO) => {
      expect(await instance.hasContext('/presence/web')).toBe(false);
    });
  });

  it('returns true when at least one socket has subscribed to the context', async () => {
    const stub = getStub('user-one-sub');
    await attachContexts(stub, ['/presence/web']);
    await runInDurableObject(stub, async (instance: UserSessionDO) => {
      expect(await instance.hasContext('/presence/web')).toBe(true);
    });
  });

  it('returns false for contexts no socket has subscribed to', async () => {
    const stub = getStub('user-other-sub');
    await attachContexts(stub, ['/presence/web']);
    await runInDurableObject(stub, async (instance: UserSessionDO) => {
      expect(await instance.hasContext('/presence/app')).toBe(false);
    });
  });

  it('returns true if any socket among many has the context', async () => {
    const stub = getStub('user-many-subs');
    await attachContexts(stub, ['/presence/web']);
    await attachContexts(stub, ['/presence/app']);
    await runInDurableObject(stub, async (instance: UserSessionDO) => {
      expect(await instance.hasContext('/presence/app')).toBe(true);
    });
  });
});
