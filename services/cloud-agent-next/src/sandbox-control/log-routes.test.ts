import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';
import { CONTROL_LOG_MAX_BATCH_BYTES } from '../shared/control-diagnostics.js';
import { mintControlLogUploadGrant } from './log-upload-grant.js';
import { registerControlLogRoutes } from './log-routes.js';

const secret = 'test-log-signing-secret';
const identity = {
  sandboxId: 'sandbox_test',
  allocationId: 'allocation_test',
  wrapperInstanceId: '0fce125c-54a3-4143-b503-b7775c4d2135',
};
const batchId = '5886f962-cc33-43f7-bd94-a31c0ed6c13b';
const suffix = `${identity.sandboxId}/${identity.allocationId}/${identity.wrapperInstanceId}/${batchId}`;
const batch = {
  version: 1,
  sequence: 0,
  droppedRecords: 0,
  records: [{ timestamp: 100, event: 'wrapper.lifecycle', fields: { phase: 'starting' } }],
};

function fixture() {
  const objects = new Map<string, { body: string }>();
  const put = vi.fn(async (key: string, body: string, options: R2PutOptions) => {
    expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
    if (objects.has(key)) return null;
    objects.set(key, { body });
    return { key };
  });
  const env = { NEXTAUTH_SECRET: secret, R2_BUCKET: { put } } as unknown as Env;
  const app = new Hono<HonoContext>();
  registerControlLogRoutes(app);
  const request = (path: string, init?: RequestInit) =>
    app.request(`http://worker.test${path}`, init, env);
  const upload = (
    body: unknown = batch,
    path = suffix,
    token = mintControlLogUploadGrant(identity, secret)
  ) =>
    request(`/sandbox-logs/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { request, upload, objects, put };
}

describe('control log routes', () => {
  it('stores validated immutable batches without any provider or DO binding', async () => {
    const f = fixture();
    expect((await f.upload()).status).toBe(204);
    const key = `logs/control/${suffix}.json`;
    expect(JSON.parse(f.objects.get(key)!.body)).toEqual(batch);
    expect((await f.upload({ ...batch, sequence: 42 })).status).toBe(204);
    expect(JSON.parse(f.objects.get(key)!.body).sequence).toBe(0);
  });

  it('rejects cross-allocation, cross-wrapper and cross-sandbox writes', async () => {
    const f = fixture();
    for (const path of [
      suffix.replace('sandbox_test', 'sandbox_other'),
      suffix.replace('allocation_test', 'allocation_other'),
      suffix.replace(identity.wrapperInstanceId, '2b6e33c0-20f8-4676-ad18-eedc478b161d'),
    ])
      expect((await f.upload(batch, path)).status).toBe(403);
    expect(f.put).not.toHaveBeenCalled();
  });

  it('rejects raw control credentials', async () => {
    const f = fixture();
    expect((await f.upload(batch, suffix, 'raw-control-credential')).status).toBe(401);
    expect(f.put).not.toHaveBeenCalled();
  });

  it.each([
    { ...batch, secret: 'private' },
    { ...batch, records: [{ timestamp: 100, event: 'raw.error', fields: { phase: 'failed' } }] },
    {
      ...batch,
      records: [
        {
          timestamp: 100,
          event: 'wrapper.lifecycle',
          fields: { phase: 'failed', message: 'secret' },
        },
      ],
    },
    {
      ...batch,
      records: [
        {
          timestamp: 100,
          event: 'session.task',
          fields: { phase: 'started', sessionId: '/private/path' },
        },
      ],
    },
    { ...batch, records: [] },
  ])('rejects non-allowlisted bodies before R2: %j', async body => {
    const f = fixture();
    expect((await f.upload(body)).status).toBe(400);
    expect(f.put).not.toHaveBeenCalled();
  });

  it('enforces actual streamed bytes with missing or misleading Content-Length', async () => {
    const f = fixture();
    for (const length of [undefined, '1']) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      const headers = new Headers({
        Authorization: `Bearer ${mintControlLogUploadGrant(identity, secret)}`,
        'Content-Type': 'application/json',
      });
      if (length) headers.set('Content-Length', length);
      const init: RequestInit & { duplex: string } = {
        method: 'PUT',
        headers,
        body,
        duplex: 'half',
      };
      expect((await f.request(`/sandbox-logs/${suffix}`, init)).status).toBe(413);
      expect(cancelled).toBe(true);
    }
    expect(f.put).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body before reading or writing it', async () => {
    const f = fixture();
    const response = await f.request(`/sandbox-logs/${suffix}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${mintControlLogUploadGrant(identity, secret)}`,
        'Content-Type': 'application/json',
        'Content-Length': String(CONTROL_LOG_MAX_BATCH_BYTES + 1),
      },
    });
    expect(response.status).toBe(413);
    expect(f.put).not.toHaveBeenCalled();
  });

  it('preserves earlier wrapper archives', async () => {
    const f = fixture();
    await f.upload();
    const nextIdentity = { ...identity, wrapperInstanceId: '2b6e33c0-20f8-4676-ad18-eedc478b161d' };
    const nextPath = suffix.replace(identity.wrapperInstanceId, nextIdentity.wrapperInstanceId);
    expect(
      (await f.upload(batch, nextPath, mintControlLogUploadGrant(nextIdentity, secret))).status
    ).toBe(204);
    expect(f.objects.size).toBe(2);
  });

  it('rejects archives, malformed JSON and path injection', async () => {
    const f = fixture();
    const headers = {
      Authorization: `Bearer ${mintControlLogUploadGrant(identity, secret)}`,
      'Content-Type': 'application/gzip',
    };
    expect(
      (await f.request(`/sandbox-logs/${suffix}`, { method: 'PUT', headers, body: 'raw archive' }))
        .status
    ).toBe(415);
    headers['Content-Type'] = 'application/json';
    expect(
      (await f.request(`/sandbox-logs/${suffix}`, { method: 'PUT', headers, body: '{' })).status
    ).toBe(400);
    expect(
      (await f.upload(batch, suffix.replace('allocation_test', 'allocation%2Fother'))).status
    ).toBe(400);
    expect(f.put).not.toHaveBeenCalled();
  });

  it('returns safe storage failures without including exception details', async () => {
    const f = fixture();
    f.put.mockRejectedValueOnce(new Error('Authorization: private-secret'));
    const response = await f.upload();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-secret');
  });
});
