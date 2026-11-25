import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBundleStub, getRefresherStub, getSignerStub } from '../../src/dos/stubs';
import { currentPolicyHash } from '../../src/policy';
import type { WorkloadBundle } from '../../src/types';
import { installManager } from './manager';
import { resetBundleObject, resetRefresherObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  await resetRefresherObject(getRefresherStub(env, config));
  for (const workload of ['o11y', 'audit-relay']) {
    await resetBundleObject(getBundleStub(env, config, workload));
  }
});

const MANAGER_SECRETS = {
  O11Y_CF_AE_API_TOKEN: 'ae-token',
  O11Y_KILO_GATEWAY_CLIENT_SECRET: 'gateway-secret',
  O11Y_CF_CONTAINERS_API_TOKEN: 'containers-token',
  O11Y_SLACK_WEBHOOK_PAGE: 'https://hooks.example/page',
  O11Y_SLACK_WEBHOOK_TICKET: 'https://hooks.example/ticket',
  AUDIT_RELAY_AXIOM_TOKEN: 'axiom-token',
  AUDIT_RELAY_SLACK_WEBHOOK_PAGE: 'https://hooks.example/audit',
  UNRELATED_SECRET: 'must-never-ship',
};

async function localBundle(): Promise<WorkloadBundle> {
  return {
    workload: 'o11y',
    secrets: { O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 1 } },
    missing: [],
    fetchedAt: new Date().toISOString(),
    policyHash: await currentPolicyHash(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('manager JWT', () => {
  it('signs a five-minute token with the separate manager key set', async () => {
    const signer = getSignerStub(env, config);
    const token = await signer.signManagerToken();
    const jwks = await signer.getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
    });

    const { payload, protectedHeader } = await jwtVerify(
      token,
      createLocalJWKSet({ keys: jwks.keys }),
      {
        issuer: `${config.issuer}/manager-auth`,
        audience: 'infisical',
        algorithms: ['EdDSA'],
      }
    );
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.sub).toBe('sts:development');
    if (payload.exp === undefined || payload.iat === undefined) {
      throw new Error('token has no issued-at or expiry');
    }
    expect(payload.exp - payload.iat).toBe(300);
  });
});

describe('refresher', () => {
  it('logs in with the signed JWT and pushes every policy workload from one bulk read', async () => {
    const manager = installManager({ secrets: MANAGER_SECRETS, etag: '"manager-1"' });
    const refresher = getRefresherStub(env, config);

    await refresher.refreshAll();

    expect(manager.loginBodies).toHaveLength(1);
    const login = manager.loginBodies[0];
    expect(login).toMatchObject({ identityId: 'test-identity-id' });
    if (typeof login !== 'object' || login === null || !('jwt' in login)) {
      throw new Error('login body did not carry a JWT');
    }
    const jwks = await getSignerStub(env, config).getJwks();
    await jwtVerify(String(login.jwt), createLocalJWKSet({ keys: jwks.keys }), {
      issuer: `${config.issuer}/manager-auth`,
      audience: 'infisical',
      algorithms: ['EdDSA'],
    });
    expect(manager.lastAuthorization()).toBe(['Bearer', 'manager-access-token'].join(' '));
    expect(manager.secretRequests).toHaveLength(1);

    const o11y = await getBundleStub(env, config, 'o11y').getBundle('o11y', 'development', {});
    if (o11y.status !== 'ok') throw new Error('expected ok');
    expect(Object.keys(o11y.secrets).sort()).toEqual(
      [
        'O11Y_CF_AE_API_TOKEN',
        'O11Y_CF_CONTAINERS_API_TOKEN',
        'O11Y_KILO_GATEWAY_CLIENT_SECRET',
        'O11Y_SLACK_WEBHOOK_PAGE',
        'O11Y_SLACK_WEBHOOK_TICKET',
      ].sort()
    );
    expect(o11y.secrets.O11Y_KILO_GATEWAY_CLIENT_SECRET?.value).toBe('gateway-secret');
    expect(o11y.secrets.UNRELATED_SECRET).toBeUndefined();

    const auditRelay = await getBundleStub(env, config, 'audit-relay').getBundle(
      'audit-relay',
      'development',
      {}
    );
    if (auditRelay.status !== 'ok') throw new Error('expected ok');
    expect(Object.keys(auditRelay.secrets).sort()).toEqual([
      'AUDIT_RELAY_AXIOM_TOKEN',
      'AUDIT_RELAY_SLACK_WEBHOOK_PAGE',
    ]);
  });

  it('revalidates with If-None-Match and still builds from the cached snapshot on 304', async () => {
    const manager = installManager({ secrets: MANAGER_SECRETS, etag: '"manager-etag"' });
    const refresher = getRefresherStub(env, config);
    await refresher.refreshAll();
    expect(manager.secretRequests[0].ifNoneMatch).toBeNull();

    manager.goNotModified();
    await refresher.refreshAll();
    expect(manager.secretRequests).toHaveLength(2);
    expect(manager.secretRequests[1].ifNoneMatch).toBe('"manager-etag"');

    const built = await refresher.buildBundle('o11y');
    if (built === null) throw new Error('expected a built bundle');
    expect(built.secrets.O11Y_CF_AE_API_TOKEN).toEqual({ value: 'ae-token', version: 1 });
  });

  it('marks every bundle stale when the manager read fails', async () => {
    installManager({ secrets: MANAGER_SECRETS, etag: '"manager-1"' });
    const refresher = getRefresherStub(env, config);
    await refresher.refreshAll();

    const stub = getBundleStub(env, config, 'o11y');
    const before = await stub.getBundle('o11y', 'development', {});
    if (before.status !== 'ok') throw new Error('expected ok');

    installManager({ secrets: {}, readStatus: 500 });
    await refresher.refreshAll();

    const after = await stub.getBundle('o11y', 'development', { ifNoneMatch: before.etag });
    if (after.status !== 'not_modified') throw new Error('expected not_modified');
    expect(after.stale).toBe(true);
  });

  it('writes one policy-change event naming the workloads, and none when nothing changed', async () => {
    const refresher = getRefresherStub(env, config);
    await refresher.ensureStarted();
    await refresher.ensureStarted();

    const rows = await runInDurableObject(refresher, (_instance, state) =>
      state.storage.sql
        .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
        .toArray()
    );
    expect(rows).toHaveLength(1);
    const event = JSON.parse(rows[0].event);
    expect(event.type).toBe('ai.kilo.sts.policy.changed');
    expect([...event.data.attributes.addedWorkloads].sort()).toEqual(['audit-relay', 'o11y']);
    expect(event.data.attributes.removedWorkloads).toEqual([]);
    expect(rows[0].event).not.toContain('gateway-secret');
  });

  it('relays the policy stream and advances its own watermark', async () => {
    installManager({ secrets: {}, loginStatus: 500, readStatus: 500 });
    const refresher = getRefresherStub(env, config);
    await refresher.ensureStarted();
    await runInDurableObject(refresher, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(refresher)).toBe(true);

    await runInDurableObject(refresher, (_instance, state) => {
      const watermark = state.storage.sql
        .exec<{ relayed_seq: number }>('SELECT relayed_seq FROM audit_watermark')
        .one().relayed_seq;
      expect(watermark).toBe(1);
    });
  });
});

describe('bundle object interface', () => {
  it('refuses a push addressed to another workload', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    const bundle = await localBundle();
    expect(await stub.putBundle({ ...bundle, workload: 'audit-relay' })).toMatchObject({
      status: 'mismatch',
    });
  });
});
