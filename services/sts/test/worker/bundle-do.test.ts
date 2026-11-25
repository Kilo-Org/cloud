import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentPolicyHash } from '../../src/policy';
import type { BundleDO } from '../../src/dos/BundleDO';
import { getBundleStub, getRefresherStub } from '../../src/dos/stubs';
import type { WorkloadBundle } from '../../src/types';
import { installManager } from './manager';
import { resetBundleObject, resetRefresherObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  for (const workload of ['o11y', 'audit-relay']) {
    await resetBundleObject(getBundleStub(env, config, workload));
  }
  await resetRefresherObject(getRefresherStub(env, config));
});

function auditRows(
  stub: DurableObjectStub<BundleDO>
): Promise<{ count: number; latest: string | null }> {
  return runInDurableObject(stub, (_instance, state) => {
    const count = state.storage.sql
      .exec<{ count: number }>('SELECT count(*) AS count FROM audit_event')
      .one().count;
    const latest = state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq DESC LIMIT 1')
      .toArray()[0];
    return { count, latest: latest?.event ?? null };
  });
}

async function workloadBundle(versions: Record<string, number>): Promise<WorkloadBundle> {
  const secrets: Record<string, { value: string; version: number }> = {};
  for (const [name, version] of Object.entries(versions)) {
    secrets[name] = { value: `value-for-${name}`, version };
  }
  return {
    workload: 'o11y',
    secrets,
    missing: [],
    fetchedAt: new Date().toISOString(),
    policyHash: await currentPolicyHash(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bundle delivery', () => {
  it('serves the sealed bundle and appends one delivery row in the same call', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(
      await workloadBundle({ O11Y_CF_AE_API_TOKEN: 3, O11Y_SLACK_WEBHOOK_PAGE: 5 })
    );

    const result = await stub.getBundle('o11y', 'development', {});
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.stale).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.secrets.O11Y_CF_AE_API_TOKEN).toEqual({
      value: 'value-for-O11Y_CF_AE_API_TOKEN',
      version: 3,
    });
    expect(result.etag).toMatch(/^"[A-Za-z0-9_-]{16,96}"$/);

    const rows = await auditRows(stub);
    expect(rows.count).toBe(1);
    expect(rows.latest).toContain('ai.kilo.sts.bundle.delivered');
    expect(rows.latest).not.toContain('value-for-');

    const stored = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ ciphertext: string; etag: string }>('SELECT ciphertext, etag FROM bundle')
        .one();
      return row;
    });
    expect(stored.ciphertext).not.toContain('value-for-');
    expect(stored.etag).toBe(result.etag);
  });

  it('returns 304 for a matching ETag, writes no audit row, and counts the revalidation', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: 1 }));
    const first = await stub.getBundle('o11y', 'development', {});
    if (first.status !== 'ok') throw new Error('expected ok');

    const second = await stub.getBundle('o11y', 'development', { ifNoneMatch: first.etag });
    expect(second).toEqual({
      status: 'not_modified',
      etag: first.etag,
      stale: false,
      fetchedAt: first.fetchedAt,
    });
    await stub.getBundle('o11y', 'development', { ifNoneMatch: first.etag });

    expect((await auditRows(stub)).count).toBe(1);
    const counters = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>('SELECT sum(count) AS count FROM delivery_counter')
          .one().count
    );
    expect(counters).toBe(2);
  });

  it('serves a stale copy with stale:true and clears the flag on the next push', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: 1 }));
    await stub.markStale();

    const stale = await stub.getBundle('o11y', 'development', {});
    if (stale.status !== 'ok') throw new Error('expected ok');
    expect(stale.stale).toBe(true);

    const push = await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: 1 }));
    expect(push).toMatchObject({ status: 'stored', changed: false });
    const fresh = await stub.getBundle('o11y', 'development', {});
    if (fresh.status !== 'ok') throw new Error('expected ok');
    expect(fresh.stale).toBe(false);
  });

  it('reports an unchanged push without rewriting the bundle', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    const bundle = await workloadBundle({ O11Y_CF_AE_API_TOKEN: 2 });
    expect(await stub.putBundle(bundle)).toMatchObject({ status: 'stored', changed: true });
    expect(await stub.putBundle(bundle)).toMatchObject({ status: 'stored', changed: false });
  });

  it('asks the refresher for an empty bundle and serves what it returns', async () => {
    const manager = installManager({
      secrets: {
        O11Y_CF_AE_API_TOKEN: 'ae-token',
        O11Y_KILO_GATEWAY_CLIENT_SECRET: 'gateway-secret',
      },
      etag: '"manager-1"',
    });
    const stub = getBundleStub(env, config, 'o11y');

    const result = await stub.getBundle('o11y', 'development', {});
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.secrets.O11Y_CF_AE_API_TOKEN?.value).toBe('ae-token');
    expect(result.secrets.O11Y_CF_AE_API_TOKEN?.version).toBe(1);
    expect(result.missing).toEqual([
      'O11Y_SLACK_WEBHOOK_PAGE',
      'O11Y_SLACK_WEBHOOK_TICKET',
      'O11Y_CF_CONTAINERS_API_TOKEN',
    ]);

    expect(manager.loginBodies).toHaveLength(1);
    expect(manager.secretRequests).toHaveLength(1);
    const request = new URL(manager.secretRequests[0].url);
    expect(request.searchParams.get('projectId')).toBe('test-project-id');
    expect(request.searchParams.get('environment')).toBe('dev');
    expect(request.searchParams.get('secretPath')).toBe('/runtime');
    expect(request.searchParams.get('recursive')).toBe('false');
    expect(manager.secretRequests[0].ifNoneMatch).toBeNull();
  });

  it('refuses a read with no copy when the manager is unreachable', async () => {
    installManager({ secrets: {}, loginStatus: 500, readStatus: 500 });
    const stub = getBundleStub(env, config, 'o11y');
    expect(await stub.getBundle('o11y', 'development', {})).toEqual({
      status: 'unavailable',
      reason: 'manager_unreachable_no_copy',
      retryAfterSeconds: 60,
    });
  });

  it('keeps serving the last copy when a refresh fails', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: 4 }));

    installManager({ secrets: {}, loginStatus: 503, readStatus: 503 });
    await getRefresherStub(env, config).refreshAll();

    const result = await stub.getBundle('o11y', 'development', {});
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.stale).toBe(true);
    expect(result.secrets.O11Y_CF_AE_API_TOKEN?.version).toBe(4);
  });

  it('refuses the read when the audit append fails', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: 1 }));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER audit_append_fails BEFORE INSERT ON audit_event BEGIN SELECT RAISE(ABORT, 'audit store unavailable'); END`
      );
    });

    const result = await stub.getBundle('o11y', 'development', {});
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DROP TRIGGER audit_append_fails');
    });

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'audit_write_failed',
      retryAfterSeconds: 30,
    });
  });

  it('denies a workload without a policy and an environment another object serves', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    const unknown = getBundleStub(env, config, 'not-a-workload');
    expect(await unknown.getBundle('not-a-workload', 'development', {})).toEqual({
      status: 'denied',
      reason: 'unknown_workload',
    });
    expect(await stub.getBundle('o11y', 'production', {})).toEqual({
      status: 'denied',
      reason: 'environment_mismatch',
    });
  });
});

describe('bundle audit relay', () => {
  it('relays committed rows, advances the watermark, and keeps them for retention', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: 1 }));
    await stub.getBundle('o11y', 'development', {});
    await stub.getBundle('o11y', 'development', {});

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      const watermark = state.storage.sql
        .exec<{ relayed_seq: number }>('SELECT relayed_seq FROM audit_watermark')
        .one().relayed_seq;
      const rows = state.storage.sql
        .exec<{ count: number }>('SELECT count(*) AS count FROM audit_event')
        .one().count;
      expect(watermark).toBe(2);
      expect(rows).toBe(2);
    });
  });

  it('deletes only relayed rows older than seven days', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: 1 }));
    await stub.getBundle('o11y', 'development', {});

    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO audit_event (event, created_at) VALUES (?, ?)`,
        JSON.stringify({
          specversion: '1.0',
          id: crypto.randomUUID(),
          source: 'kilo:sts:development',
          type: 'ai.kilo.sts.bundle.delivered',
          time: new Date().toISOString(),
          datacontenttype: 'application/json',
          data: {
            classUid: 6003,
            activityId: 2,
            outcome: 'success',
            actor: { kind: 'workload', id: 'o11y' },
            attributes: {},
          },
        }),
        eightDaysAgo
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ seq: number; created_at: number }>(
          'SELECT seq, created_at FROM audit_event ORDER BY seq'
        )
        .toArray();
      expect(rows).toHaveLength(2);
    });

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ count: number }>('SELECT count(*) AS count FROM audit_event')
        .one().count;
      expect(rows).toBe(1);
    });
  });
});
