import { SELF, runInDurableObject } from 'cloudflare:test';
import { STS_FETCHED_AT_HEADER, STS_STALE_HEADER } from '@kilocode/sts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDenialBuffers } from '../../src/audit/denials';
import { serveBundle, serveWorkerCall } from '../../src/broker';
import { getBundleStub, getDenialStub, getRefresherStub } from '../../src/dos/stubs';
import { bundleResponse, readCappedText } from '../../src/http';
import { workloadPolicyHash } from '../../src/policy';
import { installManager, stubOfflineNetwork } from './manager';
import { resetBundleObject, resetDenialObject } from './reset';
import { config, env } from './test-env';
import { signWebhook, webhookBody } from './webhook';

beforeEach(async () => {
  clearDenialBuffers();
  stubOfflineNetwork();
  await resetBundleObject(getBundleStub(env, config, 'o11y'));
  await resetDenialObject(getDenialStub(env, config));
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

  it('recognizes a Vercel team slug issuer that no policy names and refuses the team id form', async () => {
    for (const [team, status, reason] of [
      ['kilocode', 403, 'unknown_workload'],
      ['team_ItxRShuUkJaEd9GmXMEEgunb', 401, 'identity_rejected'],
    ] as const) {
      const response = await SELF.fetch(`${config.issuer}/v1/bundle`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${unsignedToken({ iss: `https://oidc.vercel.com/${team}`, aud: config.issuer })}`,
        },
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ status: 'denied', reason });
    }
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

function chunkedBody(chunks: number, chunkBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
  });
}

describe('request body limits', () => {
  it('stops reading a chunked body past the limit', async () => {
    const request = new Request('https://sts.test/manager-webhook', {
      method: 'POST',
      body: chunkedBody(1_000, 16 * 1024),
    });
    expect(request.headers.get('content-length')).toBeNull();
    expect(await readCappedText(request, 64 * 1024)).toBeNull();

    const small = new Request('https://sts.test/manager-webhook', {
      method: 'POST',
      body: chunkedBody(2, 1024),
    });
    expect(await readCappedText(small, 64 * 1024)).toBe('a'.repeat(2048));
  });

  it('answers 413 to an oversized chunked webhook without a Content-Length', async () => {
    const signature = `t=${Date.now()};${'0'.repeat(64)}`;
    const response = await SELF.fetch(`${config.issuer}/manager-webhook`, {
      method: 'POST',
      headers: { 'x-infisical-signature': signature },
      body: chunkedBody(64, 16 * 1024),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'too_large' });
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

    const pending: Promise<unknown>[] = [];
    const result = await serveWorkerCall(env, config, 'o11y', {}, promise => pending.push(promise));
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.workload).toBe('o11y');
    expect(result.secrets.O11Y_CF_AE_API_TOKEN).toEqual({ value: 'ae-token', version: 7 });
    expect(pending).toHaveLength(0);
  });

  it('denies a caller with no policy and records the denial for the audit stream', async () => {
    const pending: Promise<unknown>[] = [];
    expect(
      await serveWorkerCall(env, config, 'unknown-worker', {}, promise => pending.push(promise))
    ).toEqual({ status: 'denied', reason: 'unknown_workload' });
    await Promise.all(pending);
    expect(await pendingDenials()).toEqual([
      { key: expect.stringContaining('unknown-worker'), count: 1 },
    ]);

    // Repeats in the same minute are counted in the isolate and cost no denial-object hop.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await serveWorkerCall(env, config, 'unknown-worker', {}, promise => pending.push(promise));
    }
    expect(pending).toHaveLength(1);
  });

  it('answers unavailable with a retry when the bundle object call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // An invalid workload name makes the bundle object's own input check throw.
    expect(await serveBundle(env, config, 'Not A Workload', {})).toEqual({
      status: 'unavailable',
      reason: 'internal',
      retryAfterSeconds: 30,
    });
  });
});

describe('HTTP denials', () => {
  it('logs an unverified token and records no denial', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = unsignedToken({ iss: 'https://issuer.example', aud: config.issuer });
    const response = await SELF.fetch(`${config.issuer}/v1/bundle`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    expect(await pendingDenials()).toEqual([]);
    const logged = JSON.stringify(warnings.mock.calls);
    expect(logged).toContain('token not verified');
    expect(logged).not.toContain(token);
  });
});

function pendingDenials(): Promise<Array<{ key: string; count: number }>> {
  return runInDurableObject(getDenialStub(env, config), (_instance, state) =>
    state.storage.sql
      .exec<{ key: string; count: number }>('SELECT key, count FROM denial_window ORDER BY key')
      .toArray()
      .map(row => ({ key: row.key, count: row.count }))
  );
}

function unsignedToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}
