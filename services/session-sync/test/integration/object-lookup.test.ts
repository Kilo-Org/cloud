import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { session } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub } from '../../src/dos/SessionSyncDO';
import { errorBodySchema, sessionStateSchema } from '../../src/protocol';
import { batch, client, newSessionID, personal, testEnv, type Client } from '../helpers';

async function expectNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(errorBodySchema.parse(await response.json()).error.code).toBe('session_not_found');
}

function liveTicket(api: Client, sessionID: string): Promise<Response> {
  return api.send('POST', `/v1/sessions/${sessionID}/live-ticket`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'viewer' }),
  });
}

describe('session object lifecycle', () => {
  it('answers a request for a session this object does not hold', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const api = client(principal);
    const sessionID = newSessionID();
    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });

    await expectNotFound(await api.state(sessionID));
    await expectNotFound(await liveTicket(api, sessionID));
    await expectNotFound(await api.entities(sessionID));
    await expectNotFound(await api.remove(sessionID));
    expect(await stub.authorizeLive({ principal, sessionID })).toMatchObject({
      ok: false,
      error: { code: 'session_not_found' },
    });
    expect(await stub.eraseForUser({ principal, sessionID })).toEqual({ ok: true, value: null });

    await runInDurableObject(stub, async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
      expect(
        state.storage.sql.exec<{ name: string }>('SELECT name FROM sqlite_master').toArray()
      ).toEqual([]);
    });
  });

  it('registers, authorizes live, and erases a registered session', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const api = client(principal);
    const sessionID = newSessionID();
    const sourceID = crypto.randomUUID();
    expect((await api.register(sessionID, sourceID)).status).toBe(201);
    expect((await api.register(sessionID, sourceID)).status).toBe(200);
    expect(
      (
        await api.apply(
          sessionID,
          batch(sourceID, 0, 1, [
            { op: 'put', kind: 'message', id: 'msg_1', value: { text: 'kept' } },
          ])
        )
      ).status
    ).toBe(200);
    const minted = await liveTicket(api, sessionID);
    expect(minted.status).toBe(200);
    expect(await minted.json()).toMatchObject({ ticket: expect.any(String) });
    expect(sessionStateSchema.parse(await (await api.state(sessionID)).json())).toMatchObject({
      deleted: false,
      position: 1,
    });

    expect((await api.remove(sessionID)).status).toBe(200);
    expect((await api.remove(sessionID)).status).toBe(200);
    expect((await api.state(sessionID)).status).toBe(200);

    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    expect(await stub.authorizeLive({ principal, sessionID })).toMatchObject({
      ok: false,
      error: { code: 'session_deleted' },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(session).get()).toMatchObject({
        session_id: sessionID,
        deleted_at: expect.any(Number),
      });
    });
  });

  it('erases a registered session for its account', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const api = client(principal);
    const sessionID = newSessionID();
    expect((await api.register(sessionID, crypto.randomUUID())).status).toBe(201);
    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    expect(await stub.eraseForUser({ principal, sessionID })).toEqual({ ok: true, value: null });
    expect(await stub.authorizeLive({ principal, sessionID })).toMatchObject({
      ok: false,
      error: { code: 'session_deleted' },
    });
  });
});
