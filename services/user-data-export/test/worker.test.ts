import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { USER_DATA_EXPORT_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { signKiloToken } from '@kilocode/worker-utils/kilo-token';
import { gunzipSync } from 'node:zlib';
import { uploadGzipStream } from '../src/gzip';

describe('user-data-export worker', () => {
  const internalApiKey = String(env.INTERNAL_API_SECRET);
  const nextAuthSecret = String(env.NEXTAUTH_SECRET);

  async function userAssertion(options?: { audience?: string; expiresIn?: number }) {
    const result = await signKiloToken({
      userId: 'user-id',
      pepper: null,
      secret: nextAuthSecret,
      expiresInSeconds: options?.expiresIn ?? 300,
      audience: options?.audience ?? USER_DATA_EXPORT_AUDIENCE,
    });
    return result.token;
  }

  it('keeps health public and rejects missing or incorrect internal API keys', async () => {
    const health = await SELF.fetch('https://worker.local/health');
    expect(health.status).toBe(200);
    const denied = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      body: '{}',
    });
    expect(denied.status).toBe(401);
    const incorrectKey = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      headers: { 'x-internal-api-key': 'wrong-token' },
      body: '{}',
    });
    expect(incorrectKey.status).toBe(401);
  });

  it('requires both the internal API key and user assertion', async () => {
    const assertion = await userAssertion();
    const missingAssertion = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      headers: { 'x-internal-api-key': internalApiKey },
      body: '{}',
    });
    expect(missingAssertion.status).toBe(401);

    const missingInternalKey = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      headers: { authorization: `Bearer ${assertion}` },
      body: '{}',
    });
    expect(missingInternalKey.status).toBe(401);

    const response = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      headers: {
        authorization: `bearer ${assertion}`,
        'x-internal-api-key': internalApiKey,
      },
      body: '{}',
    });

    expect(response.status).toBe(400);
  });

  it('rejects assertions with the wrong audience, expiration, or lifetime', async () => {
    for (const assertion of [
      await userAssertion({ audience: 'other-service' }),
      await userAssertion({ expiresIn: -1 }),
      await userAssertion({ expiresIn: 301 }),
    ]) {
      const response = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${assertion}`,
          'x-internal-api-key': internalApiKey,
        },
        body: '{}',
      });
      expect(response.status).toBe(401);
    }
  });

  it('rejects a chunked internal request body over 16 KiB', async () => {
    const response = await SELF.fetch('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await userAssertion()}`,
        'x-internal-api-key': internalApiKey,
      },
      body: 'x'.repeat(16_385),
    });

    expect(response.status).toBe(400);
  });

  it('stores a compact gzip object in R2', async () => {
    const key = `test/${crypto.randomUUID()}.jsonl.gz`;
    const payload = `${'{"source":"test","value":null}\n'.repeat(10_000)}`;
    const compressor = new CompressionStream('gzip');
    const upload = await env.EXPORT_BUCKET.createMultipartUpload(key, {
      httpMetadata: {
        contentType: 'application/gzip',
        contentDisposition: 'attachment; filename="kilo-data-export.jsonl.gz"',
      },
    });
    const parts = uploadGzipStream({
      stream: compressor.readable,
      partBytes: 5 * 1024 * 1024,
      uploadPart: (partNumber, value) => upload.uploadPart(partNumber, value),
    });
    const writer = compressor.writable.getWriter();
    await writer.write(new TextEncoder().encode(payload));
    await writer.close();

    const uploaded = await parts;
    const stored = await upload.complete(
      uploaded.map(part => ({ partNumber: part.partNumber, etag: part.etag }))
    );
    const object = await env.EXPORT_BUCKET.get(key);
    if (!object) throw new Error('Test gzip object was not stored');

    expect(stored?.size).toBeLessThan(payload.length);
    expect(object?.httpMetadata).toMatchObject({
      contentType: 'application/gzip',
      contentDisposition: 'attachment; filename="kilo-data-export.jsonl.gz"',
    });
    expect(gunzipSync(await object.arrayBuffer()).toString()).toBe(payload);
    await env.EXPORT_BUCKET.delete(key);
  });
});
