import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { expect, it } from 'vitest';

import { session } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub } from '../../src/dos/SessionSyncDO';
import { getTenantStub } from '../../src/dos/SessionSyncTenantDO';
import type { Env } from '../../src/env';
import { LIMITS } from '../../src/protocol';
import { batch, client, newSessionID, personal, testEnv } from '../helpers';

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
        get: () => ({ reserve: unavailable, release: unavailable }),
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
