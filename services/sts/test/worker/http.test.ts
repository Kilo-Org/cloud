import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { currentPolicyHash } from '../../src/policy';
import { serveWorkerCall } from '../../src/broker';
import { getBundleStub } from '../../src/dos/stubs';
import { resetBundleObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  await resetBundleObject(getBundleStub(env, config, 'o11y'));
});

describe('manager OIDC discovery', () => {
  it('serves the discovery document Infisical reads for the OIDC identity', async () => {
    const response = await SELF.fetch(
      `${config.issuer}/manager-auth/.well-known/openid-configuration`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const document = await response.json<Record<string, unknown>>();
    expect(document.issuer).toBe(`${config.issuer}/manager-auth`);
    expect(document.jwks_uri).toBe(`${config.issuer}/manager-auth/.well-known/jwks.json`);
    expect(document.id_token_signing_alg_values_supported).toEqual(['EdDSA']);
  });

  it('serves the key set the discovery document names', async () => {
    const response = await SELF.fetch(`${config.issuer}/manager-auth/.well-known/jwks.json`);
    expect(response.status).toBe(200);
    const jwks = await response.json<{ keys: Array<Record<string, unknown>> }>();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
    expect(jwks.keys[0].d).toBeUndefined();
  });
});

describe('bundle HTTP route', () => {
  it('refuses a request without a bearer token', async () => {
    const response = await SELF.fetch(`${config.issuer}/v1/bundle`, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses a token whose issuer no policy names', async () => {
    const response = await SELF.fetch(`${config.issuer}/v1/bundle`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${unsignedToken({ iss: 'https://oidc.fly.io/acme', aud: config.issuer })}`,
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ status: 'denied', reason: 'unknown_workload' });
  });

  it('returns 404 outside the three routes', async () => {
    const response = await SELF.fetch(`${config.issuer}/not-a-route`);
    expect(response.status).toBe(404);
  });
});

describe('worker-binding entry', () => {
  it('serves the caller named in props after its policy check', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle({
      workload: 'o11y',
      secrets: { O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 7 } },
      missing: [],
      fetchedAt: new Date().toISOString(),
      policyHash: await currentPolicyHash(),
    });

    const result = await serveWorkerCall(env, config, 'o11y', {});
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.workload).toBe('o11y');
    expect(result.secrets.O11Y_CF_AE_API_TOKEN?.version).toBe(7);
  });

  it('denies a caller with no policy', async () => {
    expect(await serveWorkerCall(env, config, 'unknown-worker', {})).toEqual({
      status: 'denied',
      reason: 'unknown_workload',
    });
  });
});

function unsignedToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}
