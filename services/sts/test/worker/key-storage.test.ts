import { runInDurableObject } from 'cloudflare:test';
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEncryptionKey } from '../../src/crypto/aes';
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
    policyHash: await workloadPolicyHash('o11y'),
    stale: false,
  };
}

function rowCount(stub: DurableObjectStub, table: string): Promise<number> {
  return runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(`SELECT count(*) AS count FROM ${table}`).one()
        .count
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
  it('keeps the manager signing key across a restart and writes no SQL row for it', async () => {
    const signer = () => getSignerStub(env, config);
    const before = await signer().getJwks();
    await restart(signer());
    const after = await getSignerStub(env, config).getJwks();
    expect(after.keys[0].kid).toBe(before.keys[0].kid);
    expect(await rowCount(signer(), 'signing_key')).toBe(0);
    const stored = await runInDurableObject(signer(), (_instance, state) =>
      state.storage.get<{ kid: string }>('manager-signing-key')
    );
    expect(stored?.kid).toBe(before.keys[0].kid);
  });

  it('moves a legacy signing key row to KV storage once and deletes the row', async () => {
    const signer = () => getSignerStub(env, config);
    const pair = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    await runInDurableObject(signer(), async (_instance, state) => {
      await state.storage.delete('manager-signing-key');
      state.storage.sql.exec(
        'INSERT INTO signing_key (id, kid, private_jwk, public_jwk, created_at) VALUES (1, ?, ?, ?, ?)',
        kid,
        JSON.stringify(await exportJWK(pair.privateKey)),
        JSON.stringify(publicJwk),
        Date.now()
      );
    });
    await restart(signer());
    expect((await getSignerStub(env, config).getJwks()).keys[0].kid).toBe(kid);
    expect(await rowCount(signer(), 'signing_key')).toBe(0);
    await restart(signer());
    expect((await getSignerStub(env, config).getJwks()).keys[0].kid).toBe(kid);
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
    expect(await rowCount(stub(), 'bundle_key')).toBe(0);

    const first = await stub().getBundle('o11y', 'development', {});
    if (first.status !== 'ok') throw new Error(`expected ok, got ${first.status}`);
    await restart(stub());
    const again = await getBundleStub(env, config, 'o11y').getBundle('o11y', 'development', {});
    if (again.status !== 'ok') throw new Error(`expected ok, got ${again.status}`);
    expect(again.etag).toBe(first.etag);
    expect(again.secrets.O11Y_CF_AE_API_TOKEN?.value).toBe('ae-token');
  });

  it('moves legacy bundle keys to KV storage and still opens the bundle they sealed', async () => {
    const stub = () => getBundleStub(env, config, 'o11y');
    const legacy = { sealKey: createEncryptionKey(), etagKey: createEncryptionKey() };
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO bundle_key (id, seal_key, etag_key, created_at) VALUES (1, ?, ?, ?)',
        legacy.sealKey,
        legacy.etagKey,
        Date.now()
      );
    });
    await restart(stub());
    await getBundleStub(env, config, 'o11y').putBundle(await bundle());
    const keys = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<{ sealKey: string; etagKey: string }>('bundle-keys')
    );
    expect(keys).toEqual(legacy);
    expect(await rowCount(stub(), 'bundle_key')).toBe(0);
    const result = await getBundleStub(env, config, 'o11y').getBundle('o11y', 'development', {});
    expect(result.status).toBe('ok');
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
    expect(await rowCount(refresher(), 'refresher_key')).toBe(0);

    const before = await refresher().webhookSecret();
    await restart(refresher());
    expect(await refresher().webhookSecret()).toBe(before);
    installManager({ secrets: [secret('/workloads/o11y', 'O11Y_CF_AE_API_TOKEN', 'ae-token')] });
    await refresher().refreshAll();
    const o11y = await getBundleStub(env, config, 'o11y').getBundle('o11y', 'development', {});
    expect(o11y.status).toBe('ok');
  });

  it('moves a legacy refresher seal key row to KV storage and still opens its folder copies', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installManager({ secrets: [secret('/workloads/o11y', 'O11Y_CF_AE_API_TOKEN', 'ae-token')] });
    const legacy = createEncryptionKey();
    await runInDurableObject(refresher(), (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO refresher_key (id, key, created_at) VALUES (1, ?, ?)',
        legacy,
        Date.now()
      );
    });
    await restart(refresher());
    await refresher().refreshAll();
    expect(
      await runInDurableObject(refresher(), (_instance, state) =>
        state.storage.get<string>('refresher-seal-key')
      )
    ).toBe(legacy);
    expect(await rowCount(refresher(), 'refresher_key')).toBe(0);
  });
});
