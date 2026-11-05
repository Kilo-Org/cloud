import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { HonoContext } from '../hono-context.js';
import {
  WORKTREE_SNAPSHOT_AUDIENCE,
  validateWorktreeSnapshotGrant,
  worktreeSnapshotObjectKey,
} from './worktree-snapshot-grant.js';
import {
  registerWorktreeSnapshotRoutes,
  WORKTREE_SNAPSHOT_ROUTE_PREFIX,
} from './worktree-snapshot-routes.js';

const secret = 'worktree-snapshot-route-test-secret';
const identity = {
  sandboxId: 'sandbox_test',
  allocationId: 'allocation_test',
  wrapperInstanceId: '0fce125c-54a3-4143-b503-b7775c4d2135',
};
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function token(): string {
  return jwt.sign({ type: 'worktree_snapshot', identity }, secret, {
    algorithm: 'HS256',
    audience: WORKTREE_SNAPSHOT_AUDIENCE,
    expiresIn: 60,
  });
}

function path(suffix = ''): string {
  return `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${identity.sandboxId}/${identity.allocationId}/${identity.wrapperInstanceId}/${worktreeId}${suffix}`;
}

function createBucket() {
  return {
    put: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
    get: vi.fn().mockResolvedValue(null),
    head: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createEnv(overrides: Record<string, unknown> = {}) {
  const authorizeWorktreeSnapshot = vi.fn().mockResolvedValue(true);
  const isWorktreeSnapshotTombstoned = vi.fn().mockResolvedValue(false);
  const bucket = createBucket();
  const env = {
    NEXTAUTH_SECRET: secret,
    WORKTREE_SNAPSHOT_WRITES_ENABLED: 'true',
    WORKTREE_SNAPSHOT_READS_ENABLED: 'true',
    WORKTREE_SNAPSHOTS_BUCKET: bucket,
    SANDBOX_CONTROL: {
      getByName: vi.fn(() => ({
        authorizeWorktreeSnapshot,
        isWorktreeSnapshotTombstoned,
      })),
    },
    ...overrides,
  };
  return { env, bucket, authorizeWorktreeSnapshot, isWorktreeSnapshotTombstoned };
}

function app() {
  const instance = new Hono<HonoContext>();
  registerWorktreeSnapshotRoutes(instance);
  return instance;
}

function requestEnv(env: Record<string, unknown>): Env {
  return env as unknown as Env;
}

describe('worktree snapshot PUT route', () => {
  it('streams the body to R2 with the supplied digest', async () => {
    const { env, bucket, authorizeWorktreeSnapshot } = createEnv();
    const bytes = new TextEncoder().encode('snapshot-archive');
    const sha = digest(bytes);
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'Content-Type': 'application/gzip',
          'x-kilo-sha256': sha,
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(204);
    expect(authorizeWorktreeSnapshot).toHaveBeenCalledWith({
      allocationId: identity.allocationId,
      worktreeId,
    });
    expect(bucket.put).toHaveBeenCalledOnce();
    const [key, body, options] = bucket.put.mock.calls[0]!;
    expect(key).toBe(worktreeSnapshotObjectKey(worktreeId));
    expect(body).toBeInstanceOf(ReadableStream);
    expect(options).toMatchObject({
      sha256: sha,
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: { sha256: sha },
    });
  });

  it('is not found while writes are disabled', async () => {
    const { env, bucket, authorizeWorktreeSnapshot } = createEnv({
      WORKTREE_SNAPSHOT_WRITES_ENABLED: 'false',
    });
    const response = await app().request(
      path(),
      { method: 'PUT', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(response.status).toBe(404);
    expect(authorizeWorktreeSnapshot).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('requires an explicit content length within the cap', async () => {
    const { env, bucket } = createEnv();
    const missing = await app().request(
      path(),
      { method: 'PUT', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(missing.status).toBe(411);

    const invalid = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': 'not-a-number',
        },
      },
      requestEnv(env)
    );
    expect(invalid.status).toBe(400);

    const oversized = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(64 * 1024 * 1024 + 1),
          'x-kilo-sha256': 'a'.repeat(64),
        },
      },
      requestEnv(env)
    );
    expect(oversized.status).toBe(413);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('requires a hex sha256 digest', async () => {
    const { env, bucket } = createEnv();
    const bytes = new TextEncoder().encode('snapshot');
    const missing = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(missing.status).toBe(400);

    const invalid = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': 'not-hex',
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(invalid.status).toBe(400);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('rejects a digest mismatch from R2', async () => {
    const { env, bucket } = createEnv();
    bucket.put.mockRejectedValueOnce(new Error('sha256 checksum mismatch'));
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest(bytes),
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(400);
  });

  it('does not expose the body when storage fails', async () => {
    const { env, bucket } = createEnv();
    bucket.put.mockRejectedValueOnce(new Error('r2 unavailable'));
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest(bytes),
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(503);
  });

  it('rejects non-identity content encoding', async () => {
    const { env } = createEnv();
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest(bytes),
          'Content-Encoding': 'gzip',
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(415);
  });

  it('rejects a grant for another identity', async () => {
    const { env, bucket } = createEnv();
    const bytes = new TextEncoder().encode('snapshot');
    const other = jwt.sign(
      { type: 'worktree_snapshot', identity: { ...identity, allocationId: 'allocation_old' } },
      secret,
      { algorithm: 'HS256', audience: WORKTREE_SNAPSHOT_AUDIENCE, expiresIn: 60 }
    );
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${other}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest(bytes),
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(403);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('rejects a stale allocation, missing route, or tombstone from the DO', async () => {
    const { env, bucket, authorizeWorktreeSnapshot } = createEnv();
    authorizeWorktreeSnapshot.mockResolvedValueOnce(false);
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest(bytes),
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(403);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('discards a just-written object when the worktree is tombstoned after the upload', async () => {
    const { env, bucket, isWorktreeSnapshotTombstoned } = createEnv();
    isWorktreeSnapshotTombstoned.mockResolvedValueOnce(true);
    bucket.head.mockResolvedValueOnce({ etag: 'etag-1' });
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest(bytes),
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(403);
    expect(bucket.put).toHaveBeenCalledOnce();
    expect(bucket.head).toHaveBeenCalledWith(worktreeSnapshotObjectKey(worktreeId));
    expect(bucket.delete).toHaveBeenCalledWith(worktreeSnapshotObjectKey(worktreeId));
  });

  it('discards a stored object larger than the cap despite a small declared length', async () => {
    const { env, bucket, isWorktreeSnapshotTombstoned } = createEnv();
    bucket.put.mockResolvedValueOnce({ etag: 'etag-1', size: 64 * 1024 * 1024 + 1 });
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest(bytes),
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(413);
    expect(bucket.delete).toHaveBeenCalledWith(worktreeSnapshotObjectKey(worktreeId));
    expect(isWorktreeSnapshotTombstoned).not.toHaveBeenCalled();
  });

  it('keeps the upload when only the allocation changes after authorization', async () => {
    const { env, bucket, authorizeWorktreeSnapshot, isWorktreeSnapshotTombstoned } = createEnv();
    authorizeWorktreeSnapshot.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    isWorktreeSnapshotTombstoned.mockResolvedValueOnce(false);
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest(bytes),
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(204);
    expect(authorizeWorktreeSnapshot).toHaveBeenCalledOnce();
    expect(isWorktreeSnapshotTombstoned).toHaveBeenCalledOnce();
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('leaves a newer upload alone when the worktree is tombstoned after the upload', async () => {
    const { env, bucket, isWorktreeSnapshotTombstoned } = createEnv();
    isWorktreeSnapshotTombstoned.mockResolvedValueOnce(true);
    bucket.head.mockResolvedValueOnce({ etag: 'etag-newer' });
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(
      path(),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest(bytes),
        },
        body: bytes,
      },
      requestEnv(env)
    );
    expect(response.status).toBe(403);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('rejects missing authorization and invalid worktree ids', async () => {
    const { env } = createEnv();
    const missing = await app().request(path(), { method: 'PUT' }, requestEnv(env));
    expect(missing.status).toBe(401);

    const invalid = await app().request(
      `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${identity.sandboxId}/${identity.allocationId}/${identity.wrapperInstanceId}/not-a-worktree`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(invalid.status).toBe(400);
  });
});

describe('worktree snapshot GET route', () => {
  const bytes = new TextEncoder().encode('snapshot-archive');
  const sha = digest(bytes);

  function objectBody() {
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      size: bytes.byteLength,
      customMetadata: { sha256: sha },
      httpMetadata: { contentType: 'application/gzip' },
    };
  }

  it('streams the object and its digest', async () => {
    const { env, bucket, authorizeWorktreeSnapshot } = createEnv();
    bucket.get.mockResolvedValueOnce(objectBody());
    const response = await app().request(
      path(),
      { method: 'GET', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-kilo-sha256')).toBe(sha);
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(authorizeWorktreeSnapshot).toHaveBeenCalledOnce();
    expect(bucket.get).toHaveBeenCalledWith(worktreeSnapshotObjectKey(worktreeId));
  });

  it('is not found while reads are disabled', async () => {
    const { env, bucket, authorizeWorktreeSnapshot } = createEnv({
      WORKTREE_SNAPSHOT_READS_ENABLED: 'false',
    });
    const response = await app().request(
      path(),
      { method: 'GET', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(response.status).toBe(404);
    expect(authorizeWorktreeSnapshot).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('requires writes to be enabled as well as reads', async () => {
    const { env, bucket } = createEnv({
      WORKTREE_SNAPSHOT_WRITES_ENABLED: 'false',
      WORKTREE_SNAPSHOT_READS_ENABLED: 'true',
    });
    const response = await app().request(
      path(),
      { method: 'GET', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(response.status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('returns 404 when no snapshot exists', async () => {
    const { env } = createEnv();
    const response = await app().request(
      path(),
      { method: 'GET', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(response.status).toBe(404);
  });

  it('refuses a stale allocation, missing route, or tombstone from the DO', async () => {
    const { env, bucket, authorizeWorktreeSnapshot } = createEnv();
    authorizeWorktreeSnapshot.mockResolvedValueOnce(false);
    const response = await app().request(
      path(),
      { method: 'GET', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(response.status).toBe(403);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('rejects an expired grant', async () => {
    const { env } = createEnv();
    const expired = jwt.sign({ type: 'worktree_snapshot', identity }, secret, {
      algorithm: 'HS256',
      audience: WORKTREE_SNAPSHOT_AUDIENCE,
      expiresIn: -1,
    });
    const response = await app().request(
      path(),
      { method: 'GET', headers: { Authorization: `Bearer ${expired}` } },
      requestEnv(env)
    );
    expect(response.status).toBe(401);
  });
});

describe('worktree snapshot renew route', () => {
  it('exchanges an unexpired grant for a fresh grant with the same identity', async () => {
    const { env, authorizeWorktreeSnapshot } = createEnv();
    const response = await app().request(
      path('/renew'),
      { method: 'POST', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { grant: string };
    expect(validateWorktreeSnapshotGrant(`Bearer ${body.grant}`, secret)).toEqual(identity);
    const decoded = jwt.decode(body.grant) as { iat?: number; exp?: number };
    expect(decoded.iat).toBeTypeOf('number');
    expect(decoded.exp).toBeTypeOf('number');
    expect(decoded.exp! - decoded.iat!).toBe(4 * 60 * 60);
    expect(authorizeWorktreeSnapshot).toHaveBeenCalledOnce();
  });

  it('rejects an expired, mismatched, or unauthorized renewal', async () => {
    const { env, authorizeWorktreeSnapshot } = createEnv();
    const expired = jwt.sign({ type: 'worktree_snapshot', identity }, secret, {
      algorithm: 'HS256',
      audience: WORKTREE_SNAPSHOT_AUDIENCE,
      expiresIn: -1,
    });
    const expiredResponse = await app().request(
      path('/renew'),
      { method: 'POST', headers: { Authorization: `Bearer ${expired}` } },
      requestEnv(env)
    );
    expect(expiredResponse.status).toBe(401);

    const mismatch = jwt.sign(
      {
        type: 'worktree_snapshot',
        identity: { ...identity, wrapperInstanceId: crypto.randomUUID() },
      },
      secret,
      { algorithm: 'HS256', audience: WORKTREE_SNAPSHOT_AUDIENCE, expiresIn: 60 }
    );
    const mismatchResponse = await app().request(
      path('/renew'),
      { method: 'POST', headers: { Authorization: `Bearer ${mismatch}` } },
      requestEnv(env)
    );
    expect(mismatchResponse.status).toBe(403);

    authorizeWorktreeSnapshot.mockResolvedValueOnce(false);
    const unauthorized = await app().request(
      path('/renew'),
      { method: 'POST', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(unauthorized.status).toBe(403);
  });

  it('is not found while writes are disabled', async () => {
    const { env } = createEnv({ WORKTREE_SNAPSHOT_WRITES_ENABLED: 'false' });
    const response = await app().request(
      path('/renew'),
      { method: 'POST', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(response.status).toBe(404);
  });
});
