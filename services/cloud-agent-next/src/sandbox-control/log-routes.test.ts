import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';
import {
  CONTROL_LOG_ARCHIVE_NAME,
  CONTROL_LOG_MAX_ARCHIVE_BYTES,
  CONTROL_LOG_MAX_BATCH_BYTES,
  OWNED_PROCESS_CLEANUP_UNREAPED,
} from '../shared/control-diagnostics.js';
import { mintControlLogUploadGrant } from './log-upload-grant.js';
import { registerControlLogRoutes } from './log-routes.js';

const logging = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);
  return { logger };
});

vi.mock('../logger.js', () => ({ logger: logging.logger }));

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
  const objects = new Map<string, { body: string | Uint8Array; options?: R2PutOptions }>();
  const put = vi.fn(
    async (key: string, body: string | ArrayBuffer | Uint8Array, options?: R2PutOptions) => {
      const stored =
        typeof body === 'string' ? body : body instanceof Uint8Array ? body : new Uint8Array(body);
      const condition = options?.onlyIf;
      if (
        condition &&
        'etagDoesNotMatch' in condition &&
        condition.etagDoesNotMatch === '*' &&
        objects.has(key)
      ) {
        return null;
      }
      objects.set(key, { body: stored, options });
      return { key };
    }
  );
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
  const archivePath = `${identity.sandboxId}/${identity.allocationId}/${identity.wrapperInstanceId}/${CONTROL_LOG_ARCHIVE_NAME}`;
  const uploadArchive = (
    body: Uint8Array,
    path = archivePath,
    token = mintControlLogUploadGrant(identity, secret),
    contentType = 'application/gzip'
  ) =>
    request(`/sandbox-logs/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
      },
      body,
    });
  return { request, upload, uploadArchive, archivePath, objects, put };
}

describe('control log routes', () => {
  beforeEach(() => {
    logging.logger.error.mockClear();
    logging.logger.withFields.mockClear();
    logging.logger.withFields.mockReturnValue(logging.logger);
  });

  it('stores validated immutable batches without any provider or DO binding', async () => {
    const f = fixture();
    expect((await f.upload()).status).toBe(204);
    const key = `logs/control/${suffix}.json`;
    const stored = f.objects.get(key)!;
    expect(stored.options?.onlyIf).toEqual({ etagDoesNotMatch: '*' });
    expect(JSON.parse(stored.body as string)).toEqual(batch);
    expect((await f.upload({ ...batch, sequence: 42 })).status).toBe(204);
    expect(JSON.parse(f.objects.get(key)!.body as string).sequence).toBe(0);
    expect(logging.logger.error).not.toHaveBeenCalled();
  });

  it('logs unreaped owned-process cleanup once when a new batch is stored', async () => {
    const f = fixture();
    const unreaped = {
      ...batch,
      records: [
        {
          timestamp: 100,
          event: 'session.task',
          fields: {
            phase: 'failed',
            stage: 'process_cleanup',
            ok: false,
            sessionId: 'workspace_test',
            kiloSessionId: 'ses_test',
            messageId: 'msg_test',
            kind: 'execution',
            detail: 'owned_process_unreaped populated=1 /workspace/test',
          },
        },
      ],
    };
    expect((await f.upload(unreaped)).status).toBe(204);
    expect((await f.upload({ ...unreaped, sequence: 42 })).status).toBe(204);
    expect(logging.logger.withFields).toHaveBeenCalledWith({
      logTag: 'owned_process_unreaped',
      sessionId: 'workspace_test',
      sandboxId: identity.sandboxId,
    });
    expect(logging.logger.error).toHaveBeenCalledTimes(1);
    expect(logging.logger.error).toHaveBeenCalledWith(OWNED_PROCESS_CLEANUP_UNREAPED);
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

  it('stores one overwriteable gzip archive per wrapper incarnation', async () => {
    const f = fixture();
    const first = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
    const second = new Uint8Array([0x1f, 0x8b, 4, 5, 6]);
    expect((await f.uploadArchive(first)).status).toBe(204);
    expect((await f.uploadArchive(second)).status).toBe(204);
    const key = `logs/control/${f.archivePath}`;
    expect(f.objects.size).toBe(1);
    expect(f.put).toHaveBeenCalledTimes(2);
    expect(f.objects.get(key)?.options?.onlyIf).toBeUndefined();
    expect(f.objects.get(key)?.body).toEqual(second);
  });

  it('rejects json on the gzip archive route and gzip on the json route', async () => {
    const f = fixture();
    expect(
      (
        await f.uploadArchive(
          new Uint8Array([1, 2, 3]),
          f.archivePath,
          mintControlLogUploadGrant(identity, secret),
          'application/json'
        )
      ).status
    ).toBe(415);
    expect(
      (
        await f.request(`/sandbox-logs/${suffix}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${mintControlLogUploadGrant(identity, secret)}`,
            'Content-Type': 'application/gzip',
          },
          body: new Uint8Array([1, 2, 3]),
        })
      ).status
    ).toBe(415);
    expect(f.put).not.toHaveBeenCalled();
  });

  it('rejects an oversized gzip archive before writing it', async () => {
    const f = fixture();
    const response = await f.request(`/sandbox-logs/${f.archivePath}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${mintControlLogUploadGrant(identity, secret)}`,
        'Content-Type': 'application/gzip',
        'Content-Length': String(CONTROL_LOG_MAX_ARCHIVE_BYTES + 1),
      },
    });
    expect(response.status).toBe(413);
    expect(f.put).not.toHaveBeenCalled();
  });
});
