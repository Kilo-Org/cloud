import { SELF, runInDurableObject } from 'cloudflare:test';
import { STS_FETCHED_AT_HEADER, STS_STALE_HEADER } from '@kilocode/sts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveWorkerCall } from '../../src/broker';
import { getBundleStub, getRefresherStub } from '../../src/dos/stubs';
import { bundleResponse } from '../../src/http';
import { workloadPolicyHash } from '../../src/policy';
import { installManager, stubOfflineNetwork } from './manager';
import { resetBundleObject } from './reset';
import { config, env } from './test-env';
import { signWebhook, webhookBody } from './webhook';

beforeEach(async () => {
  stubOfflineNetwork();
  await resetBundleObject(getBundleStub(env, config, 'o11y'));
});

afterEach(() => {
  stubOfflineNetwork();
  vi.restoreAllMocks();
});

const ETAG = `"${'e'.repeat(43)}"`;

describe('manager login key set', () => {
  it('serves one public ES256 key and no private material', async () => {
    const response = await SELF.fetch(`${config.issuer}/manager-auth/.well-known/jwks.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const jwks = await response.json<{ keys: Array<Record<string, unknown>> }>();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0].d).toBeUndefined();
  });

  it('no longer serves an OIDC discovery document', async () => {
    const response = await SELF.fetch(
      `${config.issuer}/manager-auth/.well-known/openid-configuration`
    );
    expect(response.status).toBe(404);
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

  it('sends the stale flag and fetchedAt as headers on a 304', async () => {
    const fetchedAt = new Date().toISOString();
    const response = bundleResponse({ status: 'not_modified', etag: ETAG, stale: true, fetchedAt });
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(ETAG);
    expect(response.headers.get(STS_STALE_HEADER)).toBe('true');
    expect(response.headers.get(STS_FETCHED_AT_HEADER)).toBe(fetchedAt);
    expect(await response.text()).toBe('');

    const fresh = bundleResponse({ status: 'not_modified', etag: ETAG, stale: false, fetchedAt });
    expect(fresh.headers.get(STS_STALE_HEADER)).toBe('false');
  });

  it('maps a verifier outage to 503 with Retry-After', async () => {
    const response = bundleResponse({
      status: 'unavailable',
      reason: 'internal',
      retryAfterSeconds: 30,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('returns 404 outside the routes', async () => {
    const response = await SELF.fetch(`${config.issuer}/not-a-route`);
    expect(response.status).toBe(404);
  });
});

describe('manager webhook route', () => {
  it('passes a signed webhook to the refresher and refuses an unsigned one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installManager({ secrets: [] });
    const refresher = getRefresherStub(env, config);
    const key = await refresher.webhookSecret();

    const body = webhookBody({ timestamp: Date.now() });
    const signed = await SELF.fetch(`${config.issuer}/manager-webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-infisical-signature': await signWebhook(key, body),
      },
      body,
    });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ status: 'refresh' });

    const unsigned = await SELF.fetch(`${config.issuer}/manager-webhook`, {
      method: 'POST',
      body,
    });
    expect(unsigned.status).toBe(401);

    const forged = await SELF.fetch(`${config.issuer}/manager-webhook`, {
      method: 'POST',
      headers: { 'x-infisical-signature': await signWebhook('guessed', body) },
      body,
    });
    expect(forged.status).toBe(401);
  });
});

describe('worker-binding entry', () => {
  it('serves the caller named in props after its policy check', async () => {
    const stub = getBundleStub(env, config, 'o11y');
    await stub.putBundle({
      workload: 'o11y',
      secrets: { O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 7, id: 'id-ae' } },
      missing: [],
      fetchedAt: new Date().toISOString(),
      policyHash: await workloadPolicyHash('o11y'),
      stale: false,
    });

    const result = await serveWorkerCall(env, config, 'o11y', {});
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.workload).toBe('o11y');
    expect(result.secrets.O11Y_CF_AE_API_TOKEN).toEqual({ value: 'ae-token', version: 7 });
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
