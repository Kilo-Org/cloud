import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundleDO } from '../../src/dos/BundleDO';
import { getBundleStub, getRefresherStub } from '../../src/dos/stubs';
import { workloadPolicyHash } from '../../src/policy';
import type { WorkloadBundle } from '../../src/types';
import { installManager, secret, stubOfflineNetwork } from './manager';
import { resetBundleObject, resetRefresherObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  stubOfflineNetwork();
  for (const workload of ['o11y', 'audit-relay']) {
    await resetBundleObject(getBundleStub(env, config, workload));
  }
  await resetRefresherObject(getRefresherStub(env, config));
});

afterEach(() => {
  stubOfflineNetwork();
  vi.restoreAllMocks();
});

const O11Y_GRANTS = [
  'O11Y_KILO_GATEWAY_CLIENT_SECRET',
  'O11Y_CF_AE_API_TOKEN',
  'O11Y_SLACK_WEBHOOK_PAGE',
  'O11Y_SLACK_WEBHOOK_TICKET',
  'O11Y_CF_CONTAINERS_API_TOKEN',
];

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

async function workloadBundle(
  secrets: Record<string, { value?: string; version: number; id?: string }>,
  options?: { stale?: boolean; policyHash?: string; missing?: string[] }
): Promise<WorkloadBundle> {
  const sealed: WorkloadBundle['secrets'] = {};
  for (const [name, entry] of Object.entries(secrets)) {
    sealed[name] = {
      value: entry.value ?? `value-for-${name}`,
      version: entry.version,
      id: entry.id ?? `id-${name}`,
    };
  }
  return {
    workload: 'o11y',
    secrets: sealed,
    missing: options?.missing ?? [],
    fetchedAt: new Date().toISOString(),
    policyHash: options?.policyHash ?? (await workloadPolicyHash('o11y')),
    stale: options?.stale ?? false,
  };
}

async function read(stub: DurableObjectStub<BundleDO>, ifNoneMatch?: string) {
  return await stub.getBundle('o11y', 'development', ifNoneMatch ? { ifNoneMatch } : {});
}

describe('bundle delivery', () => {
  it('serves the sealed bundle and appends one delivery row in the same call', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(
      await workloadBundle({
        O11Y_CF_AE_API_TOKEN: { version: 3 },
        O11Y_SLACK_WEBHOOK_PAGE: { version: 5 },
      })
    );

    const result = await read(stub);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.stale).toBe(false);
    expect(result.secrets).toEqual({
      O11Y_CF_AE_API_TOKEN: { value: 'value-for-O11Y_CF_AE_API_TOKEN', version: 3 },
      O11Y_SLACK_WEBHOOK_PAGE: { value: 'value-for-O11Y_SLACK_WEBHOOK_PAGE', version: 5 },
    });
    expect(result.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);

    const rows = await auditRows(stub);
    expect(rows.count).toBe(1);
    expect(rows.latest).toContain('ai.kilo.sts.bundle.delivered');
    expect(rows.latest).not.toContain('value-for-');

    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ ciphertext: string; etag: string }>('SELECT ciphertext, etag FROM bundle')
        .one()
    );
    expect(stored.ciphertext).not.toContain('value-for-');
    expect(stored.etag).toBe(result.etag);
  });

  it('returns 304 for a matching ETag, writes no audit row, and counts the revalidation', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: { version: 1 } }));
    const first = await read(stub);
    if (first.status !== 'ok') throw new Error('expected ok');

    expect(await read(stub, first.etag)).toEqual({
      status: 'not_modified',
      etag: first.etag,
      stale: false,
      fetchedAt: first.fetchedAt,
    });
    await read(stub, first.etag);

    expect((await auditRows(stub)).count).toBe(1);
    const counted = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>('SELECT sum(count) AS count FROM delivery_counter')
          .one().count
    );
    expect(counted).toBe(2);
  });

  it('serves a stale copy with stale:true and clears the flag on the next fresh push', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(
      await workloadBundle({ O11Y_CF_AE_API_TOKEN: { version: 1 } }, { stale: true })
    );
    const stale = await read(stub);
    if (stale.status !== 'ok') throw new Error('expected ok');
    expect(stale.stale).toBe(true);

    const push = await stub.putBundle(
      await workloadBundle({ O11Y_CF_AE_API_TOKEN: { version: 1 } })
    );
    expect(push).toMatchObject({ status: 'stored', changed: false });
    const notModified = await read(stub, stale.etag);
    expect(notModified).toMatchObject({ status: 'not_modified', stale: false });
  });

  it('serves a copy older than two refresh intervals as stale, even when no read failed', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    const bundle = await workloadBundle({ O11Y_CF_AE_API_TOKEN: { version: 1 } });
    await stub.putBundle({
      ...bundle,
      fetchedAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
    });
    const old = await read(stub);
    if (old.status !== 'ok') throw new Error('expected ok');
    expect(old.stale).toBe(true);
    expect(await read(stub, old.etag)).toMatchObject({ status: 'not_modified', stale: true });

    await stub.putBundle({
      ...bundle,
      fetchedAt: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
    });
    expect(await read(stub, old.etag)).toMatchObject({ status: 'not_modified', stale: false });
  });

  it('delivers a value replaced under the same version with a new ETag', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(
      await workloadBundle({ O11Y_CF_AE_API_TOKEN: { value: 'first', version: 3, id: 'id-1' } })
    );
    const before = await read(stub);
    if (before.status !== 'ok') throw new Error('expected ok');

    // Deleted and recreated in the manager: a new id and value, the version starts over.
    const recreated = await stub.putBundle(
      await workloadBundle({ O11Y_CF_AE_API_TOKEN: { value: 'second', version: 3, id: 'id-2' } })
    );
    expect(recreated).toMatchObject({ status: 'stored', changed: true });
    const after = await read(stub, before.etag);
    if (after.status !== 'ok') throw new Error(`expected ok, got ${after.status}`);
    expect(after.secrets.O11Y_CF_AE_API_TOKEN).toEqual({ value: 'second', version: 3 });
    expect(after.etag).not.toBe(before.etag);

    // Same id and version, new value: still a change.
    await stub.putBundle(
      await workloadBundle({ O11Y_CF_AE_API_TOKEN: { value: 'third', version: 3, id: 'id-2' } })
    );
    const third = await read(stub, after.etag);
    if (third.status !== 'ok') throw new Error(`expected ok, got ${third.status}`);
    expect(third.secrets.O11Y_CF_AE_API_TOKEN?.value).toBe('third');
  });

  it('cuts a copy built under another policy down to the current grants', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    const stored = await stub.putBundle(
      await workloadBundle(
        { O11Y_CF_AE_API_TOKEN: { version: 1 }, REMOVED_GRANT_SECRET: { version: 1 } },
        { policyHash: 'policy-before-the-deploy' }
      )
    );
    if (stored.status !== 'stored') throw new Error('expected stored');

    const result = await read(stub, stored.etag);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(Object.keys(result.secrets)).toEqual(['O11Y_CF_AE_API_TOKEN']);
    expect(result.missing).toEqual(O11Y_GRANTS.filter(name => name !== 'O11Y_CF_AE_API_TOKEN'));
    expect(result.etag).not.toBe(stored.etag);
    expect((await auditRows(stub)).latest).not.toContain('REMOVED_GRANT_SECRET');

    expect(await read(stub, result.etag)).toMatchObject({
      status: 'not_modified',
      etag: result.etag,
    });
  });

  it('refuses the read when the audit append fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: { version: 1 } }));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER audit_append_fails BEFORE INSERT ON audit_event BEGIN SELECT RAISE(ABORT, 'audit store unavailable'); END`
      );
    });

    const result = await read(stub);
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
    const unknown = getBundleStub(env, config, 'not-a-workload');
    expect(await unknown.getBundle('not-a-workload', 'development', {})).toEqual({
      status: 'denied',
      reason: 'unknown_workload',
    });
    expect(await getBundleStub(env, config, 'o11y').getBundle('o11y', 'production', {})).toEqual({
      status: 'denied',
      reason: 'environment_mismatch',
    });
  });

  it('asks the refresher to confirm its alarm without the read waiting on it', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: { version: 1 } }));
    const refresher = getRefresherStub(env, config);
    expect(
      await runInDurableObject(refresher, (_instance, state) => state.storage.getAlarm())
    ).toBeNull();

    expect((await read(stub)).status).toBe('ok');
    // The check runs in the bundle object's background after the read returned; nothing
    // signals its end, so this polls the refresher's alarm for up to a second.
    let alarm: number | null = null;
    for (let attempt = 0; attempt < 40 && alarm === null; attempt += 1) {
      await scheduler.wait(25);
      alarm = await runInDurableObject(getRefresherStub(env, config), (_instance, state) =>
        state.storage.getAlarm()
      );
    }
    expect(alarm).not.toBeNull();
  });
});

describe('empty bundle objects', () => {
  it('asks the refresher for an empty bundle and serves what it returns', async () => {
    installManager({
      secrets: [
        secret('/workloads/o11y', 'O11Y_CF_AE_API_TOKEN', 'ae-token'),
        secret('/shared', 'O11Y_KILO_GATEWAY_CLIENT_SECRET', 'gateway-secret'),
      ],
    });
    const result = await read(getBundleStub(env, config, 'o11y'));
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.secrets).toEqual({
      O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 1 },
      O11Y_KILO_GATEWAY_CLIENT_SECRET: { value: 'gateway-secret', version: 1 },
    });
    expect(result.missing).toEqual([
      'O11Y_SLACK_WEBHOOK_PAGE',
      'O11Y_SLACK_WEBHOOK_TICKET',
      'O11Y_CF_CONTAINERS_API_TOKEN',
    ]);
  });

  it('merges concurrent fills into one login and one read pair', async () => {
    const manager = installManager({
      secrets: [
        secret('/workloads/o11y', 'O11Y_CF_AE_API_TOKEN', 'ae-token'),
        secret('/workloads/audit-relay', 'AUDIT_RELAY_AXIOM_TOKEN', 'axiom-token'),
      ],
      latencyMs: 50,
    });
    const o11y = getBundleStub(env, config, 'o11y');
    const auditRelay = getBundleStub(env, config, 'audit-relay');
    const reads = [
      ...Array.from({ length: 4 }, () => read(o11y)),
      ...Array.from({ length: 2 }, () => auditRelay.getBundle('audit-relay', 'development', {})),
    ];
    const results = await Promise.all(reads);

    expect(results.map(result => result.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(manager.loginBodies).toHaveLength(1);
    expect(manager.reads.map(entry => entry.folder).sort()).toEqual(['/shared', '/workloads']);
  });

  it('refuses a read with no copy when the manager is unreachable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installManager({ secrets: [], loginStatus: 500 });
    expect(await read(getBundleStub(env, config, 'o11y'))).toEqual({
      status: 'unavailable',
      reason: 'manager_unreachable_no_copy',
      retryAfterSeconds: 60,
    });
  });
});

describe('bundle audit relay', () => {
  it('relays committed rows, advances the watermark, and keeps them for retention', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: { version: 1 } }));
    await read(stub);
    await read(stub);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ relayed_seq: number }>('SELECT relayed_seq FROM audit_watermark')
          .one().relayed_seq
      ).toBe(2);
      expect(
        state.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM audit_event').one()
          .count
      ).toBe(2);
    });
  });

  it('deletes relayed rows past seven days and old 304 counters, at most once per interval', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const oldEvent = JSON.stringify({
      specversion: '1.0',
      id: crypto.randomUUID(),
      source: 'kilo:sts:development',
      type: 'ai.kilo.sts.bundle.delivered',
      time: new Date(eightDaysAgo).toISOString(),
      datacontenttype: 'application/json',
      data: {
        classUid: 6003,
        activityId: 2,
        outcome: 'success',
        actor: { kind: 'workload', id: 'o11y' },
        attributes: {},
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO audit_event (event, created_at) VALUES (?, ?)',
        oldEvent,
        eightDaysAgo
      );
      state.storage.sql.exec(
        `INSERT INTO delivery_counter (minute, count) VALUES ('2020-01-01T00:00', 5)`
      );
    });
    await stub.putBundle(await workloadBundle({ O11Y_CF_AE_API_TOKEN: { version: 1 } }));
    const first = await read(stub);
    if (first.status !== 'ok') throw new Error('expected ok');
    await read(stub, first.etag);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterFirst = await runInDurableObject(stub, (_instance, state) => ({
      seqs: state.storage.sql
        .exec<{ seq: number }>('SELECT seq FROM audit_event ORDER BY seq')
        .toArray()
        .map(row => row.seq),
      minutes: state.storage.sql
        .exec<{ minute: string }>('SELECT minute FROM delivery_counter')
        .toArray()
        .map(row => row.minute),
    }));
    expect(afterFirst.seqs).toEqual([2]);
    expect(afterFirst.minutes).toHaveLength(1);
    expect(afterFirst.minutes[0]).not.toBe('2020-01-01T00:00');

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('UPDATE audit_event SET created_at = ?', eightDaysAgo);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterSecond = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM audit_event').one()
          .count
    );
    expect(afterSecond).toBe(1);
  });
});
