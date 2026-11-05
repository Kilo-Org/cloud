import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { describe, expect, it } from 'vitest';

import migrations from '../../drizzle/migrations';
import { session, sessionRoles } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub, type SessionSyncDO } from '../../src/dos/SessionSyncDO';
import { errorBodySchema, sessionStateSchema, type Principal } from '../../src/protocol';
import { batch, client, member, newSessionID, personal, sha256, testEnv } from '../helpers';

async function setup() {
  const organizationID = crypto.randomUUID();
  const owner = member(`usr-owner-${crypto.randomUUID()}`, organizationID);
  const other = member(`usr-member-${crypto.randomUUID()}`, organizationID);
  const api = client(owner);
  const id = newSessionID();
  const sourceID = crypto.randomUUID();
  expect((await api.register(id, sourceID)).status).toBe(201);
  const bytes = new TextEncoder().encode('private session blob');
  const hash = await sha256(bytes);
  expect((await api.putBlob(id, hash, bytes)).status).toBe(201);
  expect(
    (
      await api.apply(
        id,
        batch(sourceID, 0, 1, [
          { op: 'put', kind: 'message', id: 'msg_private', value: { text: 'private session' } },
        ])
      )
    ).status
  ).toBe(200);
  const stub = getSessionSyncDOStub(testEnv, { tenant: owner.tenant, sessionID: id });
  return { owner, other, api, id, sourceID, bytes, hash, stub };
}

async function expectDenied(response: Response) {
  expect(response.status).toBe(403);
  expect(errorBodySchema.parse(await response.json()).error.code).toBe('creator_mismatch');
}

describe('session creator ACL', () => {
  it.each([
    'register',
    'state',
    'batch',
    'entities',
    'putBlob',
    'getBlob',
    'delete',
    'live-ticket',
    'commands',
    'command-status',
  ] as const)('rejects another member of the same organization on %s', async endpoint => {
    const { other, api, id, sourceID, bytes, hash } = await setup();
    const intruder = client(other);
    const calls = {
      register: () => intruder.register(id, sourceID),
      state: () => intruder.state(id),
      batch: () =>
        intruder.apply(
          id,
          batch(sourceID, 1, 2, [
            { op: 'put', kind: 'message', id: 'msg_other', value: { text: 'must not write' } },
          ])
        ),
      entities: () => intruder.entities(id),
      putBlob: () => intruder.putBlob(id, hash, bytes),
      getBlob: () => intruder.getBlob(id, hash),
      delete: () => intruder.remove(id),
      'live-ticket': () =>
        intruder.send('POST', `/v1/sessions/${id}/live-ticket`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'viewer' }),
        }),
      commands: () =>
        intruder.send('POST', `/v1/sessions/${id}/commands`, {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            channel: 'commands',
            type: 'opaque',
            commandID: 'private',
            body: null,
          }),
        }),
      'command-status': () => intruder.send('GET', `/v1/sessions/${id}/commands/private`),
    };
    await expectDenied(await calls[endpoint]());
    expect(sessionStateSchema.parse(await (await api.state(id)).json())).toMatchObject({
      deleted: false,
      position: 1,
    });
    expect((await api.getBlob(id, hash)).status).toBe(200);
  });

  it('keeps every existing endpoint accessible to the owner', async () => {
    const { owner, api, id, sourceID, bytes, hash, stub } = await setup();
    expect((await api.register(id, sourceID)).status).toBe(200);
    expect((await api.state(id)).status).toBe(200);
    expect((await api.entities(id)).status).toBe(200);
    expect((await api.putBlob(id, hash, bytes)).status).toBe(200);
    expect((await api.getBlob(id, hash)).status).toBe(200);
    expect(
      (
        await api.apply(
          id,
          batch(sourceID, 1, 2, [
            { op: 'put', kind: 'message', id: 'msg_owner', value: { text: 'owner update' } },
          ])
        )
      ).status
    ).toBe(200);
    expect(await stub.authorizeLive({ principal: owner, sessionID: id })).toEqual({
      ok: true,
      value: { role: 'owner' },
    });
    expect((await api.remove(id)).status).toBe(200);
    expect(sessionStateSchema.parse(await (await api.state(id)).json())).toMatchObject({
      deleted: true,
    });
  });

  it('records exactly the creator owner grant on registration', async () => {
    const { owner, stub } = await setup();
    await runInDurableObject(stub, (_instance: SessionSyncDO, ctx) => {
      const db = drizzle(ctx.storage);
      expect(db.select().from(sessionRoles).all()).toEqual([
        { principal_id: owner.userID, role: 'owner' },
      ]);
    });
  });

  it.each(['viewer', 'editor', 'future-role'])(
    'does not accidentally enable a persisted %s role',
    async role => {
      const { owner, api, id, stub } = await setup();
      await runInDurableObject(stub, (_instance: SessionSyncDO, ctx) => {
        drizzle(ctx.storage)
          .update(sessionRoles)
          .set({ role: role as 'viewer' })
          .where(eq(sessionRoles.principal_id, owner.userID))
          .run();
      });
      await expectDenied(await api.state(id));
      await expectDenied(await api.entities(id));
      expect(await stub.authorizeLive({ principal: owner, sessionID: id })).toMatchObject({
        ok: false,
        error: { code: 'creator_mismatch' },
      });
    }
  );

  it('fails closed for a missing owner grant and never recreates it on registration', async () => {
    const { owner, api, id, sourceID, stub } = await setup();
    await runInDurableObject(stub, (_instance: SessionSyncDO, ctx) => {
      drizzle(ctx.storage)
        .delete(sessionRoles)
        .where(eq(sessionRoles.principal_id, owner.userID))
        .run();
    });
    await expectDenied(await api.state(id));
    await expectDenied(await api.register(id, sourceID));
    expect(await stub.authorizeLive({ principal: owner, sessionID: id })).toMatchObject({
      ok: false,
      error: { code: 'creator_mismatch' },
    });
  });

  it('rejects an accidentally granted non-creator owner', async () => {
    const { other, id, stub } = await setup();
    await runInDurableObject(stub, (_instance: SessionSyncDO, ctx) => {
      drizzle(ctx.storage)
        .insert(sessionRoles)
        .values({ principal_id: other.userID, role: 'owner' })
        .run();
    });
    await expectDenied(await client(other).state(id));
    expect(await stub.authorizeLive({ principal: other, sessionID: id })).toMatchObject({
      ok: false,
      error: { code: 'creator_mismatch' },
    });
  });

  it('checks tenant and session binding before looking up a principal grant', async () => {
    const { owner, id, stub } = await setup();
    const principals: Principal[] = [
      personal(owner.userID),
      member(owner.userID, crypto.randomUUID()),
    ];
    for (const principal of principals) {
      expect(await stub.getState({ principal, sessionID: id })).toMatchObject({
        ok: false,
        error: { code: 'session_not_found' },
      });
      expect(await stub.authorizeLive({ principal, sessionID: id })).toMatchObject({
        ok: false,
        error: { code: 'session_not_found' },
      });
    }
    expect(await stub.authorizeLive({ principal: owner, sessionID: newSessionID() })).toMatchObject(
      { ok: false, error: { code: 'session_not_found' } }
    );
  });

  it('rejects malformed principals and scope escalation at the RPC boundary', async () => {
    const { owner, id, stub } = await setup();
    for (const principal of [
      { ...owner, role: 'owner' },
      { userID: owner.userID, tenant: { type: 'user', id: 'usr-other' } },
      { ...owner, tenant: { ...owner.tenant, role: 'owner' } },
    ]) {
      expect(await stub.authorizeLive({ principal, sessionID: id })).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }
    expect(
      await stub.authorizeLive({ principal: owner, sessionID: id, role: 'owner' })
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('does not mint live access to a deleted or unregistered session', async () => {
    const { owner, other, api, id, stub } = await setup();
    expect(await stub.authorizeLive({ principal: other, sessionID: id })).toMatchObject({
      ok: false,
      error: { code: 'creator_mismatch' },
    });
    expect((await api.remove(id)).status).toBe(200);
    expect(await stub.authorizeLive({ principal: owner, sessionID: id })).toMatchObject({
      ok: false,
      error: { code: 'session_deleted' },
    });
    await expectDenied(await client(other).state(id));
    const missingID = newSessionID();
    const missing = getSessionSyncDOStub(testEnv, { tenant: owner.tenant, sessionID: missingID });
    expect(await missing.authorizeLive({ principal: owner, sessionID: missingID })).toMatchObject({
      ok: false,
      error: { code: 'session_not_found' },
    });
  });

  it.each([null, 1000])(
    'backfills the creator grant for a pre-ACL session with deleted_at=%s',
    async deletedAt => {
      const owner = member(`usr-migration-${crypto.randomUUID()}`, crypto.randomUUID());
      const id = newSessionID();
      const stub = getSessionSyncDOStub(testEnv, { tenant: owner.tenant, sessionID: id });
      await runInDurableObject(stub, async (_instance: SessionSyncDO, ctx) => {
        // This fresh, unused object is reconstructed at the previous migration boundary.
        await ctx.storage.deleteAll();
        const db = drizzle(ctx.storage);
        await migrate(db, {
          ...migrations,
          journal: { entries: migrations.journal.entries.filter(entry => entry.idx < 4) },
        });
        db.insert(session)
          .values({
            key: 1,
            session_id: id,
            tenant_type: owner.tenant.type,
            tenant_id: owner.tenant.id,
            creator_id: owner.userID,
            source_id: crypto.randomUUID(),
            position: 0,
            revision: 0,
            batches: 0,
            entity_count: 0,
            inline_bytes: 0,
            blob_bytes: 0,
            tenant_lease: 0,
            created_at: 1000,
            updated_at: 1000,
            last_write_at: 1000,
            deleted_at: deletedAt,
          })
          .run();
        await migrate(db, migrations);
        expect(db.select().from(sessionRoles).all()).toEqual([
          { principal_id: owner.userID, role: 'owner' },
        ]);
        await migrate(db, migrations);
        expect(db.select().from(sessionRoles).all()).toHaveLength(1);
      });
      expect(await stub.getState({ principal: owner, sessionID: id })).toMatchObject({
        ok: true,
        value: { deleted: deletedAt !== null },
      });
    }
  );
});
