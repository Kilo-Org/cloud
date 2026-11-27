import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBundleStub, getRefresherStub, getSignerStub } from '../../src/dos/stubs';
import { workloadPolicyHash } from '../../src/policy';
import type { WorkloadBundle } from '../../src/types';
import { installManager, secret, stubOfflineNetwork } from './manager';
import { resetBundleObject, resetRefresherObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  stubOfflineNetwork();
  await resetRefresherObject(getRefresherStub(env, config));
  await resetBundleObject(getBundleStub(env, config, 'o11y'));
});

afterEach(() => {
  stubOfflineNetwork();
  vi.restoreAllMocks();
});

/** Restarts an object: the next call runs its constructor again over the same storage. */
async function restart(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => state.abort('test restart')).catch(
    () => undefined
  );
}

async function bundle(): Promise<WorkloadBundle> {
  return {
    workload: 'o11y',
    secrets: { O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 1, id: 'id-ae' } },
    missing: [],
    fetchedAt: new Date().toISOString(),
    policyHash: await workloadPolicyHash('development', 'o11y'),
    stale: false,
  };
}

/** Names of the SQL tables an object has. */
function tables(stub: DurableObjectStub): Promise<string[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .toArray()
      .map(row => row.name)
  );
}

/** Every value bound to a SQL statement while `run` executes inside the object. */
function boundValues(state: DurableObjectState): { values: unknown[]; stop: () => void } {
  const values: unknown[] = [];
  const sql = state.storage.sql;
  const original = sql.exec.bind(sql);
  const spy = vi.spyOn(sql, 'exec').mockImplementation((query, ...bindings) => {
    values.push(...bindings);
    return original(query, ...bindings);
  });
  return { values, stop: () => spy.mockRestore() };
}

const refresher = () => getRefresherStub(env, config);

describe('generated keys live in KV storage', () => {
  it('has no SQL table that held key material', async () => {
    await getSignerStub(env, config).getJwks();
    expect(await tables(getSignerStub(env, config))).not.toContain('signing_key');
    await getBundleStub(env, config, 'o11y').putBundle(await bundle());
    expect(await tables(getBundleStub(env, config, 'o11y'))).not.toContain('bundle_key');
    await getRefresherStub(env, config).webhookSecret();
    const refresherTables = await tables(getRefresherStub(env, config));
    expect(refresherTables).not.toContain('refresher_key');
    expect(refresherTables).toContain('webhook_key');
  });

  it('keeps the manager signing key across a restart', async () => {
    const signer = () => getSignerStub(env, config);
    const before = await signer().getJwks();
    await restart(signer());
    const after = await getSignerStub(env, config).getJwks();
    expect(after.keys[0].kid).toBe(before.keys[0].kid);
    const stored = await runInDurableObject(signer(), (_instance, state) =>
      state.storage.get<{ kid: string }>('manager-signing-key')
    );
    expect(stored?.kid).toBe(before.keys[0].kid);
  });

  it('keeps the bundle seal and ETag keys across a restart, bound to no SQL statement', async () => {
    const stub = () => getBundleStub(env, config, 'o11y');
    const bound = await runInDurableObject(stub(), async (instance, state) => {
      const spy = boundValues(state);
      await instance.putBundle(await bundle());
      spy.stop();
      return spy.values;
    });
    const keys = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ sealKey: string; etagKey: string }>('bundle-keys')
    );
    if (keys === undefined) throw new Error('expected stored bundle keys');
    // The spy saw the statements that stored the bundle, so it would have seen a bound key.
    expect(bound).toContain('o11y');
    expect(bound).not.toContain(keys.sealKey);
    expect(bound).not.toContain(keys.etagKey);

    const first = await stub().getBundle('o11y', 'development', {});
    if (first.status !== 'ok') throw new Error(`expected ok, got ${first.status}`);
    await restart(stub());
    const again = await getBundleStub(env, config, 'o11y').getBundle('o11y', 'development', {});
    if (again.status !== 'ok') throw new Error(`expected ok, got ${again.status}`);
    expect(again.etag).toBe(first.etag);
    expect(again.secrets.O11Y_CF_AE_API_TOKEN?.value).toBe('ae-token');
  });

  it('keeps the refresher seal key out of SQL bindings and across restarts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installManager({ secrets: [secret('/workloads/o11y', 'O11Y_CF_AE_API_TOKEN', 'ae-token')] });
    const bound = await runInDurableObject(refresher(), async (instance, state) => {
      const spy = boundValues(state);
      await instance.refreshAll();
      spy.stop();
      return spy.values;
    });
    const seal = await runInDurableObject(refresher(), (_instance, state) =>
      state.storage.get<string>('refresher-seal-key')
    );
    if (seal === undefined) throw new Error('expected a stored seal key');
    expect(bound).toContain('/workloads');
    expect(bound).not.toContain(seal);

    const before = await refresher().webhookSecret();
    await restart(refresher());
    expect(await refresher().webhookSecret()).toBe(before);
    installManager({ secrets: [secret('/workloads/o11y', 'O11Y_CF_AE_API_TOKEN', 'ae-token')] });
    await refresher().refreshAll();
    const o11y = await getBundleStub(env, config, 'o11y').getBundle('o11y', 'development', {});
    expect(o11y.status).toBe('ok');
  });
});
