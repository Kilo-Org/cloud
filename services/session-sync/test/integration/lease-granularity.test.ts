import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { expect, it } from 'vitest';

import { session } from '../../src/db/sqlite-schema';
import { leases, usage } from '../../src/db/tenant-sqlite-schema';
import { getSessionSyncDOStub } from '../../src/dos/SessionSyncDO';
import { getTenantStub } from '../../src/dos/SessionSyncTenantDO';
import { leaseBytes } from '../../src/dos/session-sync/lease';
import { LIMITS } from '../../src/protocol';
import { batch, client, member, newSessionID, personal, testEnv } from '../helpers';

it('rounds initial leases geometrically with the established maximum quantum', () => {
  const MiB = 1024 * 1024;
  expect(
    [
      0,
      1,
      MiB,
      MiB + 1,
      2 * MiB + 1,
      4 * MiB + 1,
      8 * MiB + 1,
      16 * MiB + 1,
      32 * MiB + 1,
      64 * MiB + 1,
    ].map(leaseBytes)
  ).toEqual([0, 1, 1, 2, 4, 8, 16, 32, 64, 96].map(value => value * MiB));
  expect(leaseBytes(LIMITS.sessionBlobBytes + LIMITS.sessionInlineBytes)).toBe(320 * MiB);
});

it('grows, restarts and erases a small lease alongside a legacy reservation', async () => {
  const principal = personal(crypto.randomUUID());
  const api = client(principal);
  const legacyID = newSessionID();
  const legacySource = crypto.randomUUID();
  await (await api.register(legacyID, legacySource)).json();
  const tenant = getTenantStub(testEnv, principal.tenant);
  await tenant.reserve({
    tenant: principal.tenant,
    sessionID: legacyID,
    bytes: LIMITS.tenantLeaseBytes,
  });
  const legacy = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: legacyID });
  await runInDurableObject(legacy, (_instance, state) => {
    drizzle(state.storage).update(session).set({ tenant_lease: LIMITS.tenantLeaseBytes }).run();
  });
  await (await api.register(legacyID, legacySource)).json();
  const sessionID = newSessionID();
  const sourceID = crypto.randomUUID();
  await (await api.register(sessionID, sourceID)).json();
  await (
    await api.apply(
      sessionID,
      batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', value: 'x' }])
    )
  ).json();
  let stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  const MiB = 1024 * 1024;
  for (const [index, bytes] of [MiB, 2 * MiB, 4 * MiB, 8 * MiB, 8 * MiB].entries()) {
    const result = await stub.beginBlob({
      principal,
      sessionID,
      blob: { hash: String(index + 1).repeat(64), bytes },
    });
    expect(result.ok).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(session).get()?.tenant_lease).toBe(
        2 ** (index + 1) * MiB
      );
    });
  }
  await expect(
    runInDurableObject(stub, (_instance, state) => state.abort('Lease fixture restart'))
  ).rejects.toThrow();
  stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await runInDurableObject(stub, (_instance, state) => {
    expect(drizzle(state.storage).select().from(session).get()?.tenant_lease).toBe(32 * MiB);
  });
  await runInDurableObject(tenant, (_instance, state) => {
    const db = drizzle(state.storage);
    expect(db.select().from(usage).get()).toMatchObject({ sessions: 2, bytes: 64 * MiB });
    expect(db.select().from(leases).all()).toHaveLength(2);
  });
  await (await api.remove(sessionID)).json();
  // Pending physical uploads retain their fencing deadline until cleanup is safe.
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec('UPDATE blobs SET deadline = 0');
    return state.storage.setAlarm(Date.now() + 1);
  });
  await runDurableObjectAlarm(stub);
  await runInDurableObject(tenant, (_instance, state) => {
    expect(drizzle(state.storage).select().from(usage).get()).toMatchObject({
      sessions: 1,
      bytes: 32 * MiB,
    });
  });
  await (await api.remove(legacyID)).json();
  await runInDurableObject(tenant, (_instance, state) => {
    expect(drizzle(state.storage).select().from(usage).get()).toMatchObject({
      sessions: 0,
      bytes: 0,
    });
  });
});

it('reserves small checkpoints atomically in a concentrated organization', async () => {
  const principal = member(crypto.randomUUID(), crypto.randomUUID());
  const api = client(principal);
  const ids = [];
  for (let index = 0; index < 24; index++) {
    const sessionID = newSessionID();
    const sourceID = crypto.randomUUID();
    ids.push(sessionID);
    expect((await api.register(sessionID, sourceID)).status).toBe(201);
    expect(
      (
        await api.apply(
          sessionID,
          batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', value: 'x'.repeat(2048) }])
        )
      ).status
    ).toBe(200);
  }
  const tenant = getTenantStub(testEnv, principal.tenant);
  await runInDurableObject(tenant, (_instance, state) => {
    expect(drizzle(state.storage).select().from(usage).get()).toMatchObject({
      sessions: 24,
      bytes: 24 * LIMITS.tenantInitialLeaseBytes,
    });
  });
  for (const sessionID of ids) expect((await api.remove(sessionID)).status).toBe(200);
  await runInDurableObject(tenant, (_instance, state) => {
    expect(drizzle(state.storage).select().from(usage).get()).toMatchObject({
      sessions: 0,
      bytes: 0,
    });
  });
});
