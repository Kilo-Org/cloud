import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { HonoContext } from '../hono-context.js';
import { mintSandboxLaunchCredential } from './credential.js';
import { worktreeSnapshotObjectKey } from './worktree-snapshot-authorization.js';
import {
  registerWorktreeSnapshotRoutes,
  WORKTREE_SNAPSHOT_ROUTE_PREFIX,
} from './worktree-snapshot-routes.js';

const secret = 'worktree-snapshot-route-test-secret';
const rawCredential = 'a'.repeat(64);
const identity = {
  sandboxId: 'sandbox_test',
  allocationId: '11111111-1111-4111-8111-111111111111',
};
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tokenFor(target = identity): string {
  return mintSandboxLaunchCredential(
    {
      sandboxId: target.sandboxId,
      allocationId: target.allocationId,
      credential: rawCredential,
    },
    secret
  );
}

function token(): string {
  return tokenFor();
}

function pathFor(target = identity, suffix = ''): string {
  return `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${target.sandboxId}/${worktreeId}${suffix}`;
}

function path(): string {
  return pathFor();
}

function createBucket() {
  return {
    put: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
    get: vi.fn().mockResolvedValue(null),
    head: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createConditionalBucket() {
  let object: { etag: string; bytes: Uint8Array } | null = null;
  let sequence = 0;
  let holdNextPut = false;
  let started: () => void = () => undefined;
  let release: () => void = () => undefined;
  const startedPromise = new Promise<void>(resolve => {
    started = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });

  const head = vi.fn(async () => object);
  const put = vi.fn(async (_key: string, body: ReadableStream, options?: R2PutOptions) => {
    if (holdNextPut) {
      holdNextPut = false;
      started();
      await gate;
    }
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const onlyIf = options?.onlyIf;
    const allowed =
      onlyIf !== undefined &&
      !(onlyIf instanceof Headers) &&
      (onlyIf.etagMatches !== undefined
        ? object?.etag === onlyIf.etagMatches
        : onlyIf.etagDoesNotMatch === '*' && object === null);
    if (!allowed) return null;
    object = { etag: `etag-${++sequence}`, bytes };
    return { etag: object.etag, size: bytes.byteLength };
  });
  const remove = vi.fn(async () => {
    object = null;
  });

  return {
    bucket: { head, put, delete: remove },
    gateNextPut() {
      holdNextPut = true;
      return { started: startedPromise, release };
    },
    seedObject(bytes: Uint8Array) {
      object = { etag: `etag-${++sequence}`, bytes };
    },
    storedBytes() {
      return object?.bytes ?? null;
    },
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

function putRequest(target: typeof identity, bytes: Uint8Array) {
  return {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${tokenFor(target)}`,
      'Content-Length': String(bytes.byteLength),
      'x-kilo-sha256': digest(bytes),
    },
    body: bytes,
  };
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
      credential: rawCredential,
    });
    expect(bucket.put).toHaveBeenCalledOnce();
    const [key, body, options] = bucket.put.mock.calls[0]!;
    expect(key).toBe(worktreeSnapshotObjectKey(worktreeId));
    expect(body).toBeInstanceOf(ReadableStream);
    expect(options).toMatchObject({
      sha256: sha,
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: { sha256: sha },
      onlyIf: { etagDoesNotMatch: '*' },
    });
    expect(bucket.head).toHaveBeenCalledWith(worktreeSnapshotObjectKey(worktreeId));
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

  it('rejects a launch credential for another sandbox', async () => {
    const { env, bucket, authorizeWorktreeSnapshot } = createEnv();
    const bytes = new TextEncoder().encode('snapshot');
    const other = mintSandboxLaunchCredential(
      {
        sandboxId: 'sandbox_other',
        allocationId: identity.allocationId,
        credential: rawCredential,
      },
      secret
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
    expect(response.status).toBe(401);
    expect(authorizeWorktreeSnapshot).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('rejects a rotated or wrong-allocation credential from the DO', async () => {
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
    expect(authorizeWorktreeSnapshot).toHaveBeenCalledWith({
      allocationId: identity.allocationId,
      worktreeId,
      credential: rawCredential,
    });
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
    bucket.head.mockResolvedValueOnce(null).mockResolvedValueOnce({ etag: 'etag-1' });
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
    bucket.head.mockResolvedValueOnce(null).mockResolvedValueOnce({ etag: 'etag-1' });
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

  it('does not re-check authority after the conditional write', async () => {
    const { env, bucket, authorizeWorktreeSnapshot, isWorktreeSnapshotTombstoned } = createEnv();
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
    expect(authorizeWorktreeSnapshot).toHaveBeenCalledTimes(2);
    expect(bucket.head).toHaveBeenCalledOnce();
    expect(bucket.put).toHaveBeenCalledOnce();
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('leaves a newer upload alone when the worktree is tombstoned after the upload', async () => {
    const { env, bucket, isWorktreeSnapshotTombstoned } = createEnv();
    isWorktreeSnapshotTombstoned.mockResolvedValueOnce(true);
    bucket.head.mockResolvedValueOnce(null).mockResolvedValueOnce({ etag: 'etag-newer' });
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

  it('rejects a stale allocation at the final authority check without writing', async () => {
    const { env, bucket, authorizeWorktreeSnapshot } = createEnv();
    authorizeWorktreeSnapshot.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(path(), putRequest(identity, bytes), requestEnv(env));
    expect(response.status).toBe(403);
    expect(bucket.head).toHaveBeenCalledOnce();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(bucket.head.mock.invocationCallOrder[0]).toBeLessThan(
      authorizeWorktreeSnapshot.mock.invocationCallOrder[1]!
    );
    expect(authorizeWorktreeSnapshot.mock.invocationCallOrder[1]!).toBeLessThan(
      bucket.put.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('does not overwrite a newer accepted upload when an older allocation upload resumes', async () => {
    const conditional = createConditionalBucket();
    const { env, authorizeWorktreeSnapshot } = createEnv({
      WORKTREE_SNAPSHOTS_BUCKET: conditional.bucket,
    });
    const oldIdentity = { ...identity, allocationId: '22222222-2222-4222-8222-222222222222' };
    const newIdentity = { ...identity, allocationId: '33333333-3333-4333-8333-333333333333' };
    const oldBytes = new TextEncoder().encode('old-state');
    const newBytes = new TextEncoder().encode('new-state');
    const server = app();
    const gate = conditional.gateNextPut();

    const oldUpload = server.request(
      pathFor(oldIdentity),
      putRequest(oldIdentity, oldBytes),
      requestEnv(env)
    );
    await gate.started;
    const newUpload = await server.request(
      pathFor(newIdentity),
      putRequest(newIdentity, newBytes),
      requestEnv(env)
    );
    expect(newUpload.status).toBe(204);
    gate.release();

    expect((await oldUpload).status).toBe(409);
    expect(conditional.storedBytes()).toEqual(newBytes);
    expect(authorizeWorktreeSnapshot).toHaveBeenCalledTimes(4);
    expect(conditional.bucket.head.mock.invocationCallOrder[0]).toBeLessThan(
      authorizeWorktreeSnapshot.mock.invocationCallOrder[1]!
    );
    expect(authorizeWorktreeSnapshot.mock.invocationCallOrder[1]!).toBeLessThan(
      conditional.bucket.put.mock.invocationCallOrder[0]!
    );
  });

  it('uses the captured etag as the conditional write for an existing snapshot', async () => {
    const { env, bucket } = createEnv();
    bucket.head.mockResolvedValueOnce({ etag: 'etag-existing' });
    const bytes = new TextEncoder().encode('snapshot');
    const response = await app().request(path(), putRequest(identity, bytes), requestEnv(env));
    expect(response.status).toBe(204);
    expect(bucket.put.mock.calls[0]![2]).toMatchObject({
      onlyIf: { etagMatches: 'etag-existing' },
    });
  });

  it('does not overwrite an existing snapshot when a paused upload resumes', async () => {
    const conditional = createConditionalBucket();
    const { env } = createEnv({ WORKTREE_SNAPSHOTS_BUCKET: conditional.bucket });
    conditional.seedObject(new TextEncoder().encode('existing-state'));
    const oldIdentity = { ...identity, allocationId: '22222222-2222-4222-8222-222222222222' };
    const newIdentity = { ...identity, allocationId: '33333333-3333-4333-8333-333333333333' };
    const newerBytes = new TextEncoder().encode('newer-state');
    const server = app();
    const gate = conditional.gateNextPut();

    const oldUpload = server.request(
      pathFor(oldIdentity),
      putRequest(oldIdentity, new TextEncoder().encode('old-state')),
      requestEnv(env)
    );
    await gate.started;
    const newUpload = await server.request(
      pathFor(newIdentity),
      putRequest(newIdentity, newerBytes),
      requestEnv(env)
    );
    expect(newUpload.status).toBe(204);
    gate.release();

    expect((await oldUpload).status).toBe(409);
    expect(conditional.storedBytes()).toEqual(newerBytes);
  });

  it('lets only one concurrent first upload win the conditional create', async () => {
    const conditional = createConditionalBucket();
    const { env } = createEnv({ WORKTREE_SNAPSHOTS_BUCKET: conditional.bucket });
    const firstBytes = new TextEncoder().encode('first-state');
    const secondBytes = new TextEncoder().encode('second-state');
    const server = app();
    const gate = conditional.gateNextPut();

    const first = server.request(path(), putRequest(identity, firstBytes), requestEnv(env));
    await gate.started;
    const second = await server.request(path(), putRequest(identity, secondBytes), requestEnv(env));
    expect(second.status).toBe(204);
    gate.release();

    expect((await first).status).toBe(409);
    expect(conditional.storedBytes()).toEqual(secondBytes);
    expect(conditional.bucket.put.mock.calls[0]![2]).toMatchObject({
      onlyIf: { etagDoesNotMatch: '*' },
    });
    expect(conditional.bucket.put.mock.calls[1]![2]).toMatchObject({
      onlyIf: { etagDoesNotMatch: '*' },
    });
  });

  it('rejects missing authorization and invalid worktree ids', async () => {
    const { env } = createEnv();
    const missing = await app().request(path(), { method: 'PUT' }, requestEnv(env));
    expect(missing.status).toBe(401);

    const invalid = await app().request(
      `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${identity.sandboxId}/not-a-worktree`,
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

  it('rejects an invalid launch credential', async () => {
    const { env } = createEnv();
    const response = await app().request(
      path(),
      { method: 'GET', headers: { Authorization: 'Bearer not-a-launch-credential' } },
      requestEnv(env)
    );
    expect(response.status).toBe(401);
  });

  it('returns 503 while the signing secret is unavailable and recovers on retry', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('secrets store unavailable'))
      .mockResolvedValue(secret);
    const { env, bucket } = createEnv({ NEXTAUTH_SECRET: { get } });
    bucket.get.mockResolvedValueOnce(null);

    const unavailable = await app().request(
      path(),
      { method: 'GET', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(unavailable.status).toBe(503);

    const recovered = await app().request(
      path(),
      { method: 'GET', headers: { Authorization: `Bearer ${token()}` } },
      requestEnv(env)
    );
    expect(recovered.status).toBe(404);
  });
});
