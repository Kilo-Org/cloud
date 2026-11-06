import { SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { expect, it, vi } from 'vitest';

import { session } from '../../src/db/sqlite-schema';
import { createdSessions, usage } from '../../src/db/tenant-sqlite-schema';
import { getSessionSyncDOStub, RETENTION_MS } from '../../src/dos/SessionSyncDO';
import { getTenantStub } from '../../src/dos/SessionSyncTenantDO';
import { ERASURE_PAGE_ITEMS } from '../../src/dos/session-sync/user-erasure';
import { batch, client, member, newSessionID, personal, sha256, testEnv } from '../helpers';
import type { Principal } from '../../src/protocol';
import type { Env } from '../../src/env';

const DAY = 24 * 60 * 60 * 1000;

async function erase(userID: string, secret = 'internal-test-secret-0123456789abcdef') {
  return SELF.fetch(
    `https://session-sync.test/internal/users/${encodeURIComponent(userID)}/erase`,
    {
      method: 'POST',
      headers: { 'X-Internal-Secret': secret },
    }
  );
}

async function drain(userID: string) {
  const stub = getTenantStub(testEnv, personal(userID).tenant);
  for (let page = 0; page < 32; page++) {
    if (!(await runDurableObjectAlarm(stub))) return page;
  }
  throw new Error('Account erasure exceeded the fixture alarm bound');
}

async function register(principal: Principal, sourceID = crypto.randomUUID()) {
  const sessionID = newSessionID();
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  expect(
    (await stub.register({ principal, sessionID, request: { version: 1, sourceID } })).ok
  ).toBe(true);
  return { sessionID, sourceID, stub };
}

it('authenticates internal erasure independently of sync grants and accepts encoded user IDs', async () => {
  const user = personal(`oauth/internal-${crypto.randomUUID()}`);
  expect((await erase(user.userID, '')).status).toBe(401);
  expect((await erase(user.userID, 'wrong')).status).toBe(401);
  const api = client(user);
  expect(
    (await api.send('POST', `/internal/users/${encodeURIComponent(user.userID)}/erase`)).status
  ).toBe(401);
  expect((await erase(user.userID)).status).toBe(202);
  const attemptedID = newSessionID();
  expect(
    await getSessionSyncDOStub(testEnv, { tenant: user.tenant, sessionID: attemptedID }).register({
      principal: user,
      sessionID: attemptedID,
      request: { version: 1, sourceID: crypto.randomUUID() },
    })
  ).toMatchObject({ ok: false, error: { code: 'session_deleted' } });
});

it('erases personal and organization content and quotas without deleting another creator', async () => {
  const userID = `erased-${crypto.randomUUID()}`;
  const organizationID = crypto.randomUUID();
  const own = personal(userID);
  const shared = member(userID, organizationID);
  const other = member(`other-${crypto.randomUUID()}`, organizationID);
  const local = await register(own);
  const organization = await register(shared);
  const preserved = await register(other);
  const api = client(shared);
  const bytes = new TextEncoder().encode('private synthetic content');
  const hash = await sha256(bytes);
  expect((await api.putBlob(organization.sessionID, hash, bytes)).status).toBe(201);
  expect((await erase(userID)).status).toBe(202);
  await drain(userID);
  expect(await local.stub.getState({ principal: own, sessionID: local.sessionID })).toMatchObject({
    ok: true,
    value: { deleted: true },
  });
  expect(
    await organization.stub.getState({ principal: shared, sessionID: organization.sessionID })
  ).toMatchObject({ ok: true, value: { deleted: true } });
  expect(
    await preserved.stub.getState({ principal: other, sessionID: preserved.sessionID })
  ).toMatchObject({ ok: true, value: { deleted: false } });
  expect((await api.getBlob(organization.sessionID, hash)).status).toBe(410);
  expect((await testEnv.SESSION_SYNC_R2.list()).objects).toHaveLength(0);
  for (const [tenant, expected] of [
    [own.tenant, 0],
    [shared.tenant, 1],
  ] as const) {
    await runInDurableObject(getTenantStub(testEnv, tenant), (_instance, state) => {
      expect(drizzle(state.storage).select().from(usage).get()?.sessions).toBe(expected);
    });
  }
  expect((await erase(userID)).status).toBe(202);
  expect(await drain(userID)).toBe(0);
  const attemptedID = newSessionID();
  expect(
    await getSessionSyncDOStub(testEnv, { tenant: own.tenant, sessionID: attemptedID }).register({
      principal: own,
      sessionID: attemptedID,
      request: { version: 1, sourceID: crypto.randomUUID() },
    })
  ).toMatchObject({ ok: false, error: { code: 'session_deleted' } });
});

it('resumes a large creator index across bounded alarm pages', async () => {
  const principal = personal(`pages-${crypto.randomUUID()}`);
  const fixtures = [];
  for (let index = 0; index < ERASURE_PAGE_ITEMS * 2 + 3; index++)
    fixtures.push(await register(principal));
  const owner = getTenantStub(testEnv, principal.tenant);
  expect((await erase(principal.userID)).status).toBe(202);
  expect(await runDurableObjectAlarm(owner)).toBe(true);
  await runInDurableObject(owner, (_instance, state) => {
    expect(drizzle(state.storage).select().from(createdSessions).all()).toHaveLength(
      fixtures.length - ERASURE_PAGE_ITEMS
    );
  });
  await expect(
    runInDurableObject(owner, (_instance, state) => state.abort('Synthetic erasure restart'))
  ).rejects.toThrow();
  expect(await drain(principal.userID)).toBeGreaterThan(1);
  for (const fixture of fixtures)
    expect(await fixture.stub.getState({ principal, sessionID: fixture.sessionID })).toMatchObject({
      ok: true,
      value: { deleted: true },
    });
}, 15_000);

it('expires an idle session at the retention deadline and releases tenant admission', async () => {
  const principal = personal(`retention-${crypto.randomUUID()}`);
  const fixture = await register(principal);
  await runInDurableObject(fixture.stub, async (instance, state) => {
    const db = drizzle(state.storage);
    const meta = db.select().from(session).get();
    if (!meta) throw new Error('Missing session');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(meta.last_write_at + RETENTION_MS);
    try {
      await instance.alarm();
    } finally {
      clock.mockRestore();
    }
    expect(db.select().from(session).get()?.deleted_at).not.toBeNull();
  });
  await runInDurableObject(getTenantStub(testEnv, principal.tenant), (_instance, state) => {
    expect(drizzle(state.storage).select().from(usage).get()).toMatchObject({
      sessions: 0,
      bytes: 0,
    });
  });
});

it('extends retention with a day-before-expiry batch but not a read or upload reservation', async () => {
  const principal = personal(`extended-${crypto.randomUUID()}`);
  const fixture = await register(principal);
  await runInDurableObject(fixture.stub, async (instance, state) => {
    const db = drizzle(state.storage);
    const meta = db.select().from(session).get();
    if (!meta) throw new Error('Missing session');
    const wroteAt = meta.last_write_at + 89 * DAY;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(wroteAt);
    try {
      expect(
        (
          await instance.applyBatch({
            principal,
            sessionID: fixture.sessionID,
            body: JSON.stringify(
              batch(fixture.sourceID, 0, 1, [
                { op: 'put', kind: 'message', id: 'm', value: 'updated' },
              ])
            ),
          })
        ).ok
      ).toBe(true);
      expect(db.select().from(session).get()?.last_write_at).toBe(wroteAt);
      clock.mockReturnValue(meta.last_write_at + RETENTION_MS);
      await instance.alarm();
      expect(db.select().from(session).get()?.deleted_at).toBeNull();
      expect((await instance.getState({ principal, sessionID: fixture.sessionID })).ok).toBe(true);
      expect(
        (
          await instance.beginBlob({
            principal,
            sessionID: fixture.sessionID,
            blob: { hash: 'a'.repeat(64), bytes: 1 },
          })
        ).ok
      ).toBe(true);
      expect(db.select().from(session).get()?.last_write_at).toBe(wroteAt);
      clock.mockReturnValue(wroteAt + RETENTION_MS);
      await instance.alarm();
      expect(db.select().from(session).where(eq(session.key, 1)).get()?.deleted_at).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

it('extends retention on blob commit, but not on a failed batch', async () => {
  const principal = personal(`blob-retention-${crypto.randomUUID()}`);
  const fixture = await register(principal);
  const bytes = new TextEncoder().encode('synthetic blob');
  const ref = { hash: await sha256(bytes), bytes: bytes.byteLength };
  await runInDurableObject(fixture.stub, async (instance, state) => {
    const db = drizzle(state.storage);
    const meta = db.select().from(session).get();
    if (!meta) throw new Error('Missing session');
    const wroteAt = meta.last_write_at + 89 * DAY;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(wroteAt);
    try {
      const begun = await instance.beginBlob({
        principal,
        sessionID: fixture.sessionID,
        blob: ref,
      });
      if (!begun.ok || begun.value.status !== 'upload') throw new Error('Expected an upload');
      await testEnv.SESSION_SYNC_R2.put(begun.value.key, bytes);
      expect(
        (
          await instance.commitBlob({
            principal,
            sessionID: fixture.sessionID,
            blob: ref,
            attempt: begun.value.attempt,
          })
        ).ok
      ).toBe(true);
      expect(db.select().from(session).get()?.last_write_at).toBe(wroteAt);
      clock.mockReturnValue(wroteAt + DAY);
      expect(
        await instance.commitBlob({
          principal,
          sessionID: fixture.sessionID,
          blob: ref,
          attempt: begun.value.attempt,
        })
      ).toMatchObject({ ok: true, value: { created: false } });
      expect(db.select().from(session).get()?.last_write_at).toBe(wroteAt);
      expect(
        (await instance.applyBatch({ principal, sessionID: fixture.sessionID, body: 'invalid' })).ok
      ).toBe(false);
      expect(db.select().from(session).get()?.last_write_at).toBe(wroteAt);
      await instance.alarm();
      expect(db.select().from(session).get()?.deleted_at).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

it('does not extend retention when an acknowledged batch is replayed', async () => {
  const principal = personal(`replayed-${crypto.randomUUID()}`);
  const fixture = await register(principal);
  const body = JSON.stringify(
    batch(fixture.sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', value: 'original' }])
  );
  await runInDurableObject(fixture.stub, async (instance, state) => {
    const db = drizzle(state.storage);
    const meta = db.select().from(session).get();
    if (!meta) throw new Error('Missing session');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(meta.last_write_at);
    try {
      const original = await instance.applyBatch({ principal, sessionID: fixture.sessionID, body });
      expect(original.ok).toBe(true);
      clock.mockReturnValue(meta.last_write_at + 89 * DAY);
      expect(await instance.applyBatch({ principal, sessionID: fixture.sessionID, body })).toEqual(
        original
      );
      expect(db.select().from(session).get()?.last_write_at).toBe(meta.last_write_at);
      clock.mockReturnValue(meta.last_write_at + RETENTION_MS);
      await instance.alarm();
      expect(db.select().from(session).get()?.deleted_at).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

it('retries account erasure after a committed session deletion loses its response', async () => {
  const principal = personal(`lost-erasure-${crypto.randomUUID()}`);
  const fixtures = [await register(principal), await register(principal)];
  const owner = getTenantStub(testEnv, principal.tenant);
  await runInDurableObject(owner, instance => {
    const exposed = instance as unknown as { env: Env };
    const namespace = exposed.env.SESSION_SYNC_DO;
    let lost = false;
    exposed.env = {
      ...exposed.env,
      SESSION_SYNC_DO: {
        idFromName: namespace.idFromName.bind(namespace),
        get: (id: DurableObjectId) => ({
          eraseForUser: async (input: unknown) => {
            const result = await namespace.get(id).eraseForUser(input);
            if (!lost) {
              lost = true;
              throw new Error('Synthetic lost erasure response');
            }
            return result;
          },
        }),
      } as unknown as Env['SESSION_SYNC_DO'],
    };
  });
  expect((await erase(principal.userID)).status).toBe(202);
  await expect(runDurableObjectAlarm(owner)).rejects.toThrow('Synthetic lost erasure response');
  await runInDurableObject(owner, async (_instance, state) => {
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
  await drain(principal.userID);
  for (const fixture of fixtures) {
    expect(await fixture.stub.getState({ principal, sessionID: fixture.sessionID })).toMatchObject({
      ok: true,
      value: { deleted: true },
    });
  }
});
