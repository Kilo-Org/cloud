import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { expect, it } from 'vitest';

import tenantMigrations from '../../drizzle-tenant/migrations';
import { session } from '../../src/db/sqlite-schema';
import { createdSessions } from '../../src/db/tenant-sqlite-schema';
import { getSessionSyncDOStub, type SessionSyncDO } from '../../src/dos/SessionSyncDO';
import { getTenantStub } from '../../src/dos/SessionSyncTenantDO';
import type { Env } from '../../src/env';
import { LIMITS, type Tenant } from '../../src/protocol';
import { batch, client, newSessionID, personal, testEnv } from '../helpers';

async function loseTenantResponse(
  stub: DurableObjectStub<SessionSyncDO>,
  tenant: Tenant,
  operation: 'reserve' | 'release' | 'trackCreatedSession' = 'reserve'
) {
  await runInDurableObject(stub, instance => {
    const exposed = instance as unknown as { env: Env; reservationFaultInjected: boolean };
    const namespace = exposed.env.SESSION_SYNC_TENANT_DO;
    const realTenant = getTenantStub(testEnv, tenant);
    let lost = false;
    const invoke = async (
      method: 'reserve' | 'release' | 'trackCreatedSession',
      input: unknown
    ) => {
      const result = await realTenant[method](input);
      if (method === operation && !lost) {
        lost = true;
        throw new Error('Synthetic lost tenant response after commit');
      }
      return result;
    };
    exposed.reservationFaultInjected = true;
    exposed.env = {
      ...exposed.env,
      SESSION_SYNC_TENANT_DO: {
        idFromName: namespace.idFromName.bind(namespace),
        get: () => ({
          reserve: (input: unknown) => invoke('reserve', input),
          release: (input: unknown) => invoke('release', input),
          trackCreatedSession: (input: unknown) => invoke('trackCreatedSession', input),
          forgetCreatedSession: (input: unknown) => realTenant.forgetCreatedSession(input),
        }),
      } as unknown as Env['SESSION_SYNC_TENANT_DO'],
    };
  });
}

it('admits a session idempotently and rejects a new session at the tenant limit', async () => {
  const tenant = personal(`quota-${crypto.randomUUID()}`).tenant;
  const stub = getTenantStub(testEnv, tenant);
  const input = { tenant, sessionID: newSessionID(), bytes: 0 };
  expect((await stub.reserve(input)).ok).toBe(true);
  expect((await stub.reserve(input)).ok).toBe(true);
  await runInDurableObject(stub, (_instance, state) => {
    expect(
      state.storage.sql.exec<{ sessions: number }>('SELECT sessions FROM usage').one().sessions
    ).toBe(1);
    state.storage.sql.exec('UPDATE usage SET sessions = ?', LIMITS.userTenantSessions);
  });
  expect(await stub.reserve({ ...input, sessionID: newSessionID() })).toMatchObject({
    ok: false,
    error: { code: 'tenant_budget_exceeded', details: { sessions: LIMITS.userTenantSessions } },
  });
  expect((await stub.reserve(input)).ok).toBe(true);
});

it('rejects lease growth without applying the session mutation', async () => {
  const principal = personal(`bytes-${crypto.randomUUID()}`);
  const api = client(principal);
  const sessionID = newSessionID();
  const sourceID = crypto.randomUUID();
  expect((await api.register(sessionID, sourceID)).status).toBe(201);
  const tenantStub = getTenantStub(testEnv, principal.tenant);
  await runInDurableObject(tenantStub, (_instance, state) => {
    state.storage.sql.exec('UPDATE usage SET bytes = ?', LIMITS.userTenantBytes);
  });
  const response = await api.apply(
    sessionID,
    batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', value: 'x' }])
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({
    error: { code: 'tenant_budget_exceeded', details: { bytes: LIMITS.userTenantBytes } },
  });
  expect(await (await api.state(sessionID)).json()).toMatchObject({
    position: 0,
    usage: { inlineBytes: 0 },
  });
});

it('shrinks excess leases on alarm and releases admission on deletion', async () => {
  const principal = personal(`shrink-${crypto.randomUUID()}`);
  const api = client(principal);
  const sessionID = newSessionID();
  expect((await api.register(sessionID, crypto.randomUUID())).status).toBe(201);
  const tenantStub = getTenantStub(testEnv, principal.tenant);
  expect(
    (
      await tenantStub.reserve({
        tenant: principal.tenant,
        sessionID,
        bytes: 3 * LIMITS.tenantLeaseBytes,
      })
    ).ok
  ).toBe(true);
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await runInDurableObject(stub, (_instance, state) => {
    drizzle(state.storage)
      .update(session)
      .set({ tenant_lease: 3 * LIMITS.tenantLeaseBytes })
      .run();
    return state.storage.setAlarm(Date.now() + 60_000);
  });
  await runDurableObjectAlarm(stub);
  await runInDurableObject(tenantStub, (_instance, state) => {
    expect(
      state.storage.sql
        .exec<{ sessions: number; bytes: number }>('SELECT sessions, bytes FROM usage')
        .one()
    ).toMatchObject({ sessions: 1, bytes: 0 });
  });
  expect((await api.remove(sessionID)).status).toBe(200);
  await runInDurableObject(tenantStub, (_instance, state) => {
    expect(
      state.storage.sql
        .exec<{ sessions: number; bytes: number }>('SELECT sessions, bytes FROM usage')
        .one()
    ).toMatchObject({ sessions: 0, bytes: 0 });
  });
});

it('allows existing admission and lease shrink after limits are lowered', async () => {
  const principal = personal(`lowered-${crypto.randomUUID()}`);
  const api = client(principal);
  const sessionID = newSessionID();
  const sourceID = crypto.randomUUID();
  expect((await api.register(sessionID, sourceID)).status).toBe(201);
  const tenantStub = getTenantStub(testEnv, principal.tenant);
  const input = { tenant: principal.tenant, sessionID, bytes: 2 * LIMITS.tenantLeaseBytes };
  expect((await tenantStub.reserve(input)).ok).toBe(true);
  const sessionStub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await runInDurableObject(sessionStub, (_instance, state) => {
    drizzle(state.storage).update(session).set({ tenant_lease: input.bytes }).run();
  });
  await runInDurableObject(tenantStub, instance => {
    const exposed = instance as unknown as { env: Env };
    exposed.env = { ...exposed.env, USER_TENANT_SESSIONS: '0', USER_TENANT_BYTES: '0' };
  });
  expect((await api.register(sessionID, sourceID)).status).toBe(200);
  expect((await tenantStub.reserve({ ...input, bytes: LIMITS.tenantLeaseBytes })).ok).toBe(true);
  expect(await tenantStub.reserve(input)).toMatchObject({
    ok: false,
    error: { code: 'tenant_budget_exceeded' },
  });
  expect(await tenantStub.reserve({ ...input, sessionID: newSessionID(), bytes: 0 })).toMatchObject(
    {
      ok: false,
      error: { code: 'tenant_budget_exceeded' },
    }
  );
});

it('returns retryable tenant failures without resetting the session or losing read access', async () => {
  const principal = personal(`unavailable-${crypto.randomUUID()}`);
  const api = client(principal);
  const sessionID = newSessionID();
  const sourceID = crypto.randomUUID();
  expect((await api.register(sessionID, sourceID)).status).toBe(201);
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await runInDurableObject(stub, instance => {
    const exposed = instance as unknown as { env: Env; failureMarker: string };
    const namespace = exposed.env.SESSION_SYNC_TENANT_DO;
    exposed.failureMarker = 'same-instance';
    const unavailable = async () => {
      throw new Error('Synthetic tenant outage');
    };
    exposed.env = {
      ...exposed.env,
      SESSION_SYNC_TENANT_DO: {
        idFromName: namespace.idFromName.bind(namespace),
        get: () => ({
          reserve: unavailable,
          release: unavailable,
          trackCreatedSession: unavailable,
          forgetCreatedSession: unavailable,
        }),
      } as unknown as Env['SESSION_SYNC_TENANT_DO'],
    };
  });
  const responses = [
    await api.register(sessionID, sourceID),
    await api.apply(
      sessionID,
      batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', value: 'x' }])
    ),
  ];
  for (const response of responses) {
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toMatchObject({
      error: { code: 'tenant_unavailable', retryAt: expect.any(Number) },
    });
  }
  expect((await api.state(sessionID)).status).toBe(200);
  await runInDurableObject(stub, instance => {
    expect('failureMarker' in instance && instance.failureMarker).toBe('same-instance');
  });
  const deleted = await api.remove(sessionID);
  expect(deleted.status).toBe(503);
  expect(deleted.headers.get('Retry-After')).toBe('60');
  expect(await (await api.state(sessionID)).json()).toMatchObject({ deleted: true });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect((await api.state(sessionID)).status).toBe(200);
});

it.each([false, true])(
  'fences a committed shrink with a lost response (restart: %s)',
  async restart => {
    const principal = personal(`lost-shrink-${crypto.randomUUID()}`);
    const api = client(principal);
    const sessionID = newSessionID();
    const sourceID = crypto.randomUUID();
    const registered = await api.register(sessionID, sourceID);
    expect(registered.status).toBe(201);
    await registered.json();
    const tenantStub = getTenantStub(testEnv, principal.tenant);
    expect(
      (
        await tenantStub.reserve({
          tenant: principal.tenant,
          sessionID,
          bytes: 3 * LIMITS.tenantLeaseBytes,
        })
      ).ok
    ).toBe(true);
    let stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    await runInDurableObject(stub, (instance, state) => {
      drizzle(state.storage)
        .update(session)
        .set({ tenant_lease: 3 * LIMITS.tenantLeaseBytes })
        .run();
      return state.storage.setAlarm(Date.now() + 60_000);
    });
    await loseTenantResponse(stub, principal.tenant);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(drizzle(state.storage).select().from(session).get()!.tenant_lease).toBe(0);
      expect(await state.storage.get('leaseReconcilePending')).toBe(true);
    });
    await runInDurableObject(tenantStub, (instance, state) => {
      expect(state.storage.sql.exec<{ bytes: number }>('SELECT bytes FROM usage').one().bytes).toBe(
        0
      );
      const exposed = instance as unknown as { env: Env };
      exposed.env = { ...exposed.env, USER_TENANT_BYTES: '0' };
    });
    if (restart) {
      await expect(
        runInDurableObject(stub, (_instance, state) => state.abort('Synthetic session restart'))
      ).rejects.toThrow();
      stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
      await runInDurableObject(stub, async (instance, state) => {
        expect('reservationFaultInjected' in instance).toBe(false);
        expect(await state.storage.get('leaseReconcilePending')).toBe(true);
        expect(await state.storage.getAlarm()).not.toBeNull();
      });
    }
    const packet = batch(sourceID, 0, 1, [
      { op: 'put', kind: 'message', id: 'm', value: 'must reserve again' },
    ]);
    const denied = await api.apply(sessionID, packet);
    expect(denied.status).toBe(413);
    expect(await denied.json()).toMatchObject({ error: { code: 'tenant_budget_exceeded' } });
    expect(await (await api.state(sessionID)).json()).toMatchObject({
      position: 0,
      usage: { entities: 0, inlineBytes: 0 },
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('leaseReconcilePending')).toBeUndefined();
    });
    await runInDurableObject(tenantStub, instance => {
      const exposed = instance as unknown as { env: Env };
      exposed.env = { ...exposed.env, USER_TENANT_BYTES: String(LIMITS.userTenantBytes) };
    });
    const accepted = await api.apply(sessionID, packet);
    expect(accepted.status).toBe(200);
    await accepted.json();
    await runInDurableObject(tenantStub, (_instance, state) => {
      expect(state.storage.sql.exec<{ bytes: number }>('SELECT bytes FROM usage').one().bytes).toBe(
        LIMITS.tenantInitialLeaseBytes
      );
    });
  }
);

it.each([false, true])(
  'reconciles a committed growth with a lost response without more client writes (restart: %s)',
  async restart => {
    const principal = personal(`lost-growth-${crypto.randomUUID()}`);
    const api = client(principal);
    const sessionID = newSessionID();
    const sourceID = crypto.randomUUID();
    await (await api.register(sessionID, sourceID)).json();
    let stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    await loseTenantResponse(stub, principal.tenant);
    const response = await api.apply(
      sessionID,
      batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', value: 'uncommitted' }])
    );
    expect(response.status).toBe(503);
    await response.json();
    const tenantStub = getTenantStub(testEnv, principal.tenant);
    await runInDurableObject(tenantStub, (_instance, state) => {
      expect(state.storage.sql.exec<{ bytes: number }>('SELECT bytes FROM usage').one().bytes).toBe(
        LIMITS.tenantInitialLeaseBytes
      );
    });
    if (restart) {
      await expect(
        runInDurableObject(stub, (_instance, state) => state.abort('Synthetic growth restart'))
      ).rejects.toThrow();
      stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    }
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('leaseReconcilePending')).toBe(true);
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(drizzle(state.storage).select().from(session).get()).toMatchObject({
        tenant_lease: 0,
        position: 0,
        inline_bytes: 0,
      });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(tenantStub, (_instance, state) => {
      expect(state.storage.sql.exec<{ bytes: number }>('SELECT bytes FROM usage').one().bytes).toBe(
        0
      );
    });
    expect(await (await api.state(sessionID)).json()).toMatchObject({
      position: 0,
      usage: { entities: 0, inlineBytes: 0 },
    });
  }
);

it.each([false, true])(
  'releases abandoned registrations without releasing a retry that won the gate (restart: %s)',
  async restart => {
    for (const retryFirst of [false, true]) {
      const principal = personal(`lost-register-${crypto.randomUUID()}`);
      const api = client(principal);
      const sessionID = newSessionID();
      const sourceID = crypto.randomUUID();
      let stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
      await loseTenantResponse(stub, principal.tenant);
      const failed = await api.register(sessionID, sourceID);
      expect(failed.status).toBe(503);
      await failed.json();
      const tenantStub = getTenantStub(testEnv, principal.tenant);
      if (restart) {
        await expect(
          runInDurableObject(stub, (_instance, state) => state.abort('Synthetic admission restart'))
        ).rejects.toThrow();
        stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
      }
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.get('pendingRegistration')).toEqual({
          tenant: principal.tenant,
          sessionID,
          creatorID: principal.userID,
        });
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(drizzle(state.storage).select().from(session).get()).toBeUndefined();
      });
      if (retryFirst) {
        const accepted = await api.register(sessionID, sourceID);
        expect(accepted.status).toBe(201);
        await accepted.json();
      }
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await runInDurableObject(tenantStub, (_instance, state) => {
        expect(
          state.storage.sql.exec<{ sessions: number }>('SELECT sessions FROM usage').one().sessions
        ).toBe(retryFirst ? 1 : 0);
      });
      if (!retryFirst) {
        const accepted = await api.register(sessionID, sourceID);
        expect(accepted.status).toBe(201);
        await accepted.json();
      }
      expect(await (await api.state(sessionID)).json()).toMatchObject({
        deleted: false,
        sourceID,
        position: 0,
      });
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.get('pendingRegistration')).toBeUndefined();
      });
    }
  }
);

it('adopts a registration after orphan release commits but loses its response', async () => {
  const principal = personal(`lost-release-${crypto.randomUUID()}`);
  const api = client(principal);
  const sessionID = newSessionID();
  const sourceID = crypto.randomUUID();
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await loseTenantResponse(stub, principal.tenant);
  const failed = await api.register(sessionID, sourceID);
  expect(failed.status).toBe(503);
  await failed.json();
  await loseTenantResponse(stub, principal.tenant, 'release');
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const accepted = await api.register(sessionID, sourceID);
  expect(accepted.status).toBe(201);
  await accepted.json();
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const tenantStub = getTenantStub(testEnv, principal.tenant);
  await runInDurableObject(tenantStub, (_instance, state) => {
    expect(
      state.storage.sql.exec<{ sessions: number }>('SELECT sessions FROM usage').one().sessions
    ).toBe(1);
  });
});

it('does not release a session adopted before an orphan intent was cleared', async () => {
  const principal = personal(`adopted-orphan-${crypto.randomUUID()}`);
  const api = client(principal);
  const sessionID = newSessionID();
  await (await api.register(sessionID, crypto.randomUUID())).json();
  let stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('pendingRegistration', { tenant: principal.tenant, sessionID });
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  await expect(
    runInDurableObject(stub, (_instance, state) => state.abort('Synthetic adoption restart'))
  ).rejects.toThrow();
  stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const tenantStub = getTenantStub(testEnv, principal.tenant);
  await runInDurableObject(tenantStub, (_instance, state) => {
    expect(
      state.storage.sql.exec<{ sessions: number }>('SELECT sessions FROM usage').one().sessions
    ).toBe(1);
  });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.get('pendingRegistration')).toBeUndefined();
  });
});

it('adopts the old local tenant tables without rewriting leases or usage', async () => {
  const tenant = personal(`tenant-migration-${crypto.randomUUID()}`).tenant;
  const stub = getTenantStub(testEnv, tenant);
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    expect(
      sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM __drizzle_migrations').one().count
    ).toBe(tenantMigrations.journal.entries.length);
    // Recreate the raw-table layout used by earlier, never-deployed local fixtures.
    sql.exec('DROP TABLE leases');
    sql.exec('DROP TABLE usage');
    sql.exec('DROP TABLE created_sessions');
    sql.exec('DROP TABLE user_erasure');
    sql.exec('DROP TABLE __drizzle_migrations');
    sql.exec('CREATE TABLE leases (session_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL)');
    sql.exec(
      'CREATE TABLE usage (id INTEGER PRIMARY KEY, sessions INTEGER NOT NULL, bytes INTEGER NOT NULL)'
    );
    sql.exec('INSERT INTO leases VALUES (?, ?)', 'ses_existing_local', 128);
    sql.exec('INSERT INTO usage VALUES (1, 1, 128)');
    const db = drizzle(state.storage, { logger: false });
    await migrate(db, tenantMigrations);
    await migrate(db, tenantMigrations);
    expect(sql.exec('SELECT session_id, bytes FROM leases').one()).toEqual({
      session_id: 'ses_existing_local',
      bytes: 128,
    });
    expect(sql.exec('SELECT id, sessions, bytes FROM usage').one()).toEqual({
      id: 1,
      sessions: 1,
      bytes: 128,
    });
    expect(
      sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM __drizzle_migrations').one().count
    ).toBe(tenantMigrations.journal.entries.length);
  });
  expect(await stub.reserve({ tenant, sessionID: newSessionID(), bytes: 256 })).toEqual({
    ok: true,
    value: { bytes: 256 },
  });
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec('SELECT sessions, bytes FROM usage').one()).toEqual({
      sessions: 2,
      bytes: 384,
    });
  });
});

it.each([false, true])(
  'cleans a creator index whose registration response was lost (restart: %s)',
  async restart => {
    const principal = personal(`lost-index-${crypto.randomUUID()}`);
    const sessionID = newSessionID();
    let stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    const tenant = getTenantStub(testEnv, principal.tenant);
    await loseTenantResponse(stub, principal.tenant, 'trackCreatedSession');
    expect((await client(principal).register(sessionID, crypto.randomUUID())).status).toBe(503);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('pendingRegistration')).toMatchObject({
        sessionID,
        creatorID: principal.userID,
      });
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(drizzle(state.storage).select().from(session).get()).toBeUndefined();
    });
    await runInDurableObject(tenant, (_instance, state) => {
      expect(drizzle(state.storage).select().from(createdSessions).all()).toHaveLength(1);
    });
    if (restart) {
      await expect(
        runInDurableObject(stub, (_instance, state) =>
          state.abort('Synthetic creator-index restart')
        )
      ).rejects.toThrow();
      stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    }
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(tenant, (_instance, state) => {
      expect(drizzle(state.storage).select().from(createdSessions).all()).toHaveLength(0);
      expect(state.storage.sql.exec('SELECT sessions, bytes FROM usage').one()).toEqual({
        sessions: 0,
        bytes: 0,
      });
    });
  }
);
