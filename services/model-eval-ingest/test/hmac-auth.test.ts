import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { hmacAuthMiddleware, hexToBytes, computeSignature } from '../src/middleware/hmac-auth';
import type { Env } from '../src/env';

const SECRET = 'test-secret-value';

type TestVars = {
  rawBody: string;
};

function buildApp(secret: string | null = SECRET) {
  const stubEnv: Env = {
    HYPERDRIVE: { connectionString: '' },
    MODEL_EVAL_INGEST_SECRET: { get: async () => secret },
    ENVIRONMENT: 'development',
  };

  const app = new Hono<{ Bindings: Env; Variables: TestVars }>();
  // Hono's `app.request` doesn't set c.env from constructor bindings, so
  // we install it in a pre-middleware. Replacing the whole env object
  // rather than mutating (Object.assign) is needed because Hono starts
  // with c.env undefined outside of a real Workers context.
  app.use(async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = stubEnv;
    return next();
  });
  app.use('/protected', hmacAuthMiddleware);
  app.post('/protected', c => c.json({ ok: true, body: c.var.rawBody }));
  return app;
}

/** Shape returned by handlers in this test — narrows `.json()`. */
type JsonResponse = { ok?: boolean; body?: string; success?: boolean; error?: string };

async function signedHeaders(
  body: string,
  secret = SECRET,
  timestamp = Math.floor(Date.now() / 1000)
): Promise<Record<string, string>> {
  const sigBytes = await computeSignature(secret, body);
  const sigHex = Array.from(sigBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return {
    'X-Ingest-Signature': sigHex,
    'X-Ingest-Timestamp': timestamp.toString(),
    'Content-Type': 'application/json',
  };
}

describe('hexToBytes', () => {
  it('parses even-length hex', () => {
    expect(hexToBytes('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('rejects odd-length hex', () => {
    expect(hexToBytes('abc')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(hexToBytes('')).toBeNull();
  });

  it('rejects non-hex characters', () => {
    expect(hexToBytes('zzyyaa')).toBeNull();
  });
});

describe('computeSignature', () => {
  it('is deterministic for the same secret + body', async () => {
    const a = await computeSignature('k', 'hello');
    const b = await computeSignature('k', 'hello');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('changes when the secret differs', async () => {
    const a = await computeSignature('k1', 'hello');
    const b = await computeSignature('k2', 'hello');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('changes when the body differs', async () => {
    const a = await computeSignature('k', 'hello');
    const b = await computeSignature('k', 'hello!');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('produces 32-byte output (SHA-256)', async () => {
    const sig = await computeSignature('k', 'x');
    expect(sig.byteLength).toBe(32);
  });
});

describe('hmacAuthMiddleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with 401 when signature is missing', async () => {
    const app = buildApp();
    const res = await app.request('/protected', {
      method: 'POST',
      body: '{}',
      headers: { 'X-Ingest-Timestamp': '1000' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Missing signature or timestamp',
    });
  });

  it('rejects with 401 when timestamp is missing', async () => {
    const app = buildApp();
    const res = await app.request('/protected', {
      method: 'POST',
      body: '{}',
      headers: { 'X-Ingest-Signature': 'deadbeef' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects non-numeric timestamp', async () => {
    const app = buildApp();
    const res = await app.request('/protected', {
      method: 'POST',
      body: '{}',
      headers: { 'X-Ingest-Signature': 'deadbeef', 'X-Ingest-Timestamp': 'abc' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as JsonResponse).error).toBe('Invalid timestamp');
  });

  it('rejects timestamps further than 5 minutes in the past', async () => {
    const app = buildApp();
    const body = '{"ok":true}';
    const oldTs = Math.floor(Date.now() / 1000) - 6 * 60;
    const headers = await signedHeaders(body, SECRET, oldTs);
    const res = await app.request('/protected', { method: 'POST', body, headers });
    expect(res.status).toBe(401);
    expect(((await res.json()) as JsonResponse).error).toContain('skew');
  });

  it('rejects timestamps further than 5 minutes in the future', async () => {
    const app = buildApp();
    const body = '{"ok":true}';
    const futureTs = Math.floor(Date.now() / 1000) + 6 * 60;
    const headers = await signedHeaders(body, SECRET, futureTs);
    const res = await app.request('/protected', { method: 'POST', body, headers });
    expect(res.status).toBe(401);
  });

  it('accepts timestamps within the skew window', async () => {
    const app = buildApp();
    const body = '{"ok":true}';
    const okTs = Math.floor(Date.now() / 1000) - 4 * 60;
    const headers = await signedHeaders(body, SECRET, okTs);
    const res = await app.request('/protected', { method: 'POST', body, headers });
    expect(res.status).toBe(200);
  });

  it('rejects invalid hex in signature', async () => {
    const app = buildApp();
    const body = '{"ok":true}';
    const res = await app.request('/protected', {
      method: 'POST',
      body,
      headers: {
        'X-Ingest-Signature': 'not-hex-at-all!!',
        'X-Ingest-Timestamp': Math.floor(Date.now() / 1000).toString(),
      },
    });
    expect(res.status).toBe(401);
  });

  it('rejects mismatched signature', async () => {
    const app = buildApp();
    const body = '{"ok":true}';
    const headers = await signedHeaders('different body', SECRET);
    const res = await app.request('/protected', { method: 'POST', body, headers });
    expect(res.status).toBe(401);
    expect(((await res.json()) as JsonResponse).error).toBe('Invalid signature');
  });

  it('rejects signature computed with wrong secret', async () => {
    const app = buildApp();
    const body = '{"ok":true}';
    const headers = await signedHeaders(body, 'wrong-secret');
    const res = await app.request('/protected', { method: 'POST', body, headers });
    expect(res.status).toBe(401);
  });

  it('returns 401 when cloud has no secret configured', async () => {
    const app = buildApp(null);
    const body = '{"ok":true}';
    const headers = await signedHeaders(body, SECRET);
    const res = await app.request('/protected', { method: 'POST', body, headers });
    expect(res.status).toBe(401);
  });

  it('passes through valid signatures and exposes rawBody to handler', async () => {
    const app = buildApp();
    const body = '{"hello":"world"}';
    const headers = await signedHeaders(body, SECRET);
    const res = await app.request('/protected', { method: 'POST', body, headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, body });
  });
});
