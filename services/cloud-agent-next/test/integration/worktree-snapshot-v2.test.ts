import { drizzle } from 'drizzle-orm/durable-sqlite';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import {
  allocation as allocationTable,
  routes as routesTable,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import type { Env } from '../../src/types.js';
import type { HonoContext } from '../../src/hono-context.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  mintSandboxLaunchCredential,
} from '../../src/sandbox-control/credential.js';
import {
  worktreeSnapshotObjectKey,
  worktreeSnapshotTombstoneKey,
} from '../../src/sandbox-control/worktree-snapshot-authorization.js';
import {
  registerWorktreeSnapshotRoutes,
  WORKTREE_SNAPSHOT_ROUTE_PREFIX,
} from '../../src/sandbox-control/worktree-snapshot-routes.js';
import { WORKTREE_SNAPSHOT_MAX_BYTES } from '../../src/shared/worktree-snapshot.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const secret = (env as unknown as { NEXTAUTH_SECRET: string }).NEXTAUTH_SECRET;
const bucket = (env as unknown as { RUNTIME_RELEASE_BUCKET: R2Bucket }).RUNTIME_RELEASE_BUCKET;

function app(): Hono<HonoContext> {
  const instance = new Hono<HonoContext>();
  registerWorktreeSnapshotRoutes(instance);
  return instance;
}

function appEnv(snapshotBucket: R2Bucket = bucket): Env {
  return {
    NEXTAUTH_SECRET: secret,
    WORKTREE_SNAPSHOT_WRITES_ENABLED: 'true',
    WORKTREE_SNAPSHOT_READS_ENABLED: 'true',
    WORKTREE_SNAPSHOTS_BUCKET: snapshotBucket,
    SANDBOX_CONTROL: sandboxes,
  } as unknown as Env;
}

function ids() {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  return {
    sandboxId: `sbx__snapshot_${suffix}`,
    allocationId: crypto.randomUUID(),
    credential: generateSandboxCredential(),
    worktreeId: `worktree_${crypto.randomUUID()}` as const,
    sessionId: `workspace_${crypto.randomUUID()}`,
    kiloSessionId: `ses_${suffix.slice(0, 26)}`,
  };
}

type Seeded = ReturnType<typeof ids> & { sandbox: DurableObjectStub<SandboxControlV2> };

async function seed(
  state: 'connected' | 'stopped',
  input: ReturnType<typeof ids>
): Promise<Seeded> {
  const sandbox = sandboxes.getByName(input.sandboxId);
  await runInDurableObject(sandbox, async instance => {
    Object.assign((instance as unknown as { env: Env }).env, {
      WORKTREE_SNAPSHOTS_BUCKET: bucket,
    });
    await instance.getAllocationState();
  });
  await runInDurableObject(sandbox, async (_instance, doState) => {
    await doState.storage.put(
      'wrapper_credential_hash',
      await hashSandboxCredential(input.credential)
    );
    const db = drizzle(doState.storage, { logger: false });
    db.update(allocationTable)
      .set({
        state,
        allocation_id: input.allocationId,
        connection_id: null,
        provider_ref: null,
        unconfirmed_provider_ref: null,
      })
      .where(eq(allocationTable.id, 'current'))
      .run();
    db.insert(routesTable)
      .values({
        session_id: input.sessionId,
        spec: JSON.stringify({
          sessionId: input.sessionId,
          kiloSessionId: input.kiloSessionId,
          directory: '/workspace/snapshot',
          attemptId: 'attempt_snapshot',
        }),
        grant: null,
        credential_source: JSON.stringify({
          userId: 'user_snapshot',
          kiloSessionId: input.kiloSessionId,
          kiloToken: 'kilo-token',
          scopeId: input.worktreeId,
        }),
        repo_key: null,
        environment: null,
        state: 'ready',
        attempt_id: 'attempt_snapshot',
        attempt_deadline_at: null,
        reason: null,
        updated_at: Date.now(),
      })
      .run();
  });
  return { ...input, sandbox };
}

function path(input: ReturnType<typeof ids>, suffix = ''): string {
  return `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${input.sandboxId}/${input.worktreeId}${suffix}`;
}

function launchToken(input: ReturnType<typeof ids>, allocationId = input.allocationId): string {
  return mintSandboxLaunchCredential(
    {
      sandboxId: input.sandboxId,
      allocationId,
      credential: input.credential,
    },
    secret
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function objectBytes(key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

type SnapshotBucket = {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions
  ): Promise<R2Object | null>;
  delete(key: string | string[]): Promise<void>;
};

const openGates = new Set<() => void>();

function gatedSnapshotBucket(real: R2Bucket) {
  let holdNextPut = false;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  let openGate!: () => void;
  const gate = new Promise<void>(resolve => {
    openGate = resolve;
  });
  const putPreconditions: Array<R2Conditional | Headers | undefined> = [];

  const release = () => {
    openGates.delete(release);
    openGate();
  };

  const adapter: SnapshotBucket = {
    head: key => real.head(key),
    get: key => real.get(key),
    put: async (key, value, options) => {
      putPreconditions.push(options?.onlyIf);
      if (holdNextPut) {
        holdNextPut = false;
        markStarted();
        await gate;
      }
      return real.put(key, value, options as R2PutOptions & { onlyIf: R2Conditional | Headers });
    },
    delete: keys => real.delete(keys),
  };

  return {
    bucket: adapter as unknown as R2Bucket,
    putPreconditions,
    gateNextPut() {
      holdNextPut = true;
      openGates.add(release);
      return { started, release };
    },
  };
}

async function runStaleUploadRace(existing: boolean): Promise<void> {
  const input = ids();
  const { sandbox } = await seed('connected', input);
  const key = worktreeSnapshotObjectKey(input.worktreeId);
  if (existing) await bucket.put(key, new TextEncoder().encode('existing-state'));

  const gated = gatedSnapshotBucket(bucket);
  const oldBytes = new TextEncoder().encode('old-allocation-state');
  const nextBytes = new TextEncoder().encode('new-allocation-state');
  const nextAllocationId = crypto.randomUUID();
  const nextInput = { ...input, allocationId: nextAllocationId };
  const gate = gated.gateNextPut();

  const oldUpload = app().request(
    path(input),
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${launchToken(input)}`,
        'Content-Length': String(oldBytes.byteLength),
        'x-kilo-sha256': await sha256Hex(oldBytes),
      },
      body: oldBytes,
    },
    appEnv(gated.bucket)
  );

  let oldStatus: number | undefined;
  try {
    await gate.started;

    await runInDurableObject(sandbox, async (_instance, doState) => {
      const db = drizzle(doState.storage, { logger: false });
      db.update(allocationTable)
        .set({ allocation_id: nextAllocationId })
        .where(eq(allocationTable.id, 'current'))
        .run();
    });

    const nextUpload = await app().request(
      path(nextInput),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(nextInput)}`,
          'Content-Length': String(nextBytes.byteLength),
          'x-kilo-sha256': await sha256Hex(nextBytes),
        },
        body: nextBytes,
      },
      appEnv(gated.bucket)
    );
    expect(nextUpload.status).toBe(204);
    expect(await objectBytes(key)).toEqual(nextBytes);
  } finally {
    gate.release();
    oldStatus = (await oldUpload).status;
  }

  expect(oldStatus).toBe(409);
  expect(await objectBytes(key)).toEqual(nextBytes);
  expect(gated.putPreconditions).toHaveLength(2);
  if (existing) {
    expect(gated.putPreconditions[0]).toMatchObject({ etagMatches: expect.any(String) });
    expect(gated.putPreconditions[1]).toEqual(gated.putPreconditions[0]);
  } else {
    expect(gated.putPreconditions).toEqual([{ etagDoesNotMatch: '*' }, { etagDoesNotMatch: '*' }]);
  }
}

afterEach(async () => {
  for (const release of [...openGates]) release();
  openGates.clear();
  await reset();
});

describe('worktree snapshot routes on the Workers runtime', () => {
  it('accepts a direct request stream and verifies the R2 checksum', async () => {
    const input = ids();
    await seed('connected', input);
    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    const digest = await sha256Hex(bytes);

    const put = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': digest,
        },
        body: bytes,
      },
      appEnv()
    );
    expect(put.status).toBe(204);
    expect(await bucket.head(worktreeSnapshotObjectKey(input.worktreeId))).not.toBeNull();

    const get = await app().request(
      path(input),
      { method: 'GET', headers: { Authorization: `Bearer ${launchToken(input)}` } },
      appEnv()
    );
    expect(get.status).toBe(200);
    expect(get.headers.get('x-kilo-sha256')).toBe(digest);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it('revokes a rotated credential within the same allocation', async () => {
    const input = ids();
    const { sandbox } = await seed('connected', input);
    const rotated = generateSandboxCredential();
    expect(
      await sandbox.authorizeWorktreeSnapshot({
        allocationId: input.allocationId,
        worktreeId: input.worktreeId,
        credential: input.credential,
      })
    ).toBe(true);

    await runInDurableObject(sandbox, async (_instance, doState) => {
      await doState.storage.put('wrapper_credential_hash', await hashSandboxCredential(rotated));
    });

    expect(
      await sandbox.authorizeWorktreeSnapshot({
        allocationId: input.allocationId,
        worktreeId: input.worktreeId,
        credential: input.credential,
      })
    ).toBe(false);
    expect(
      await sandbox.authorizeWorktreeSnapshot({
        allocationId: input.allocationId,
        worktreeId: input.worktreeId,
        credential: rotated,
      })
    ).toBe(true);

    const bytes = crypto.getRandomValues(new Uint8Array(128));
    const headers = {
      'Content-Length': String(bytes.byteLength),
      'x-kilo-sha256': await sha256Hex(bytes),
    };
    const oldToken = launchToken(input);
    const oldUpload = await app().request(
      path(input),
      { method: 'PUT', headers: { ...headers, Authorization: `Bearer ${oldToken}` }, body: bytes },
      appEnv()
    );
    expect(oldUpload.status).toBe(403);

    const rotatedToken = mintSandboxLaunchCredential(
      {
        sandboxId: input.sandboxId,
        allocationId: input.allocationId,
        credential: rotated,
      },
      secret
    );
    const rotatedUpload = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: { ...headers, Authorization: `Bearer ${rotatedToken}` },
        body: bytes,
      },
      appEnv()
    );
    expect(rotatedUpload.status).toBe(204);
  });

  it('rejects a stopped allocation', async () => {
    const input = ids();
    const { sandbox } = await seed('stopped', input);
    expect(
      await sandbox.authorizeWorktreeSnapshot({
        allocationId: input.allocationId,
        worktreeId: input.worktreeId,
        credential: input.credential,
      })
    ).toBe(false);
    const bytes = crypto.getRandomValues(new Uint8Array(128));
    const response = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': await sha256Hex(bytes),
        },
        body: bytes,
      },
      appEnv()
    );
    expect(response.status).toBe(403);
  });

  it('rejects a body whose bytes do not match the declared digest', async () => {
    const input = ids();
    await seed('connected', input);
    const bytes = crypto.getRandomValues(new Uint8Array(1024));

    const put = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': '0'.repeat(64),
        },
        body: bytes,
      },
      appEnv()
    );
    expect(put.status).toBe(400);
    expect(await bucket.head(worktreeSnapshotObjectKey(input.worktreeId))).toBeNull();
  });

  it('refuses a stale allocation, a missing route, and a tombstone after deletion', async () => {
    const input = ids();
    await seed('connected', input);
    const bytes = crypto.getRandomValues(new Uint8Array(256));
    const digest = await sha256Hex(bytes);
    const headers = {
      'Content-Length': String(bytes.byteLength),
      'x-kilo-sha256': digest,
    };

    const staleAllocation = crypto.randomUUID();
    const stale = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: { ...headers, Authorization: `Bearer ${launchToken(input, staleAllocation)}` },
        body: bytes,
      },
      appEnv()
    );
    expect(stale.status).toBe(403);

    const missing = ids();
    const missingPath = `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${input.sandboxId}/${missing.worktreeId}`;
    const noRoute = await app().request(
      missingPath,
      {
        method: 'PUT',
        headers: {
          ...headers,
          Authorization: `Bearer ${launchToken(input)}`,
        },
        body: bytes,
      },
      appEnv()
    );
    expect(noRoute.status).toBe(403);
  });

  it('discards the just-written object when the worktree is tombstoned after upload', async () => {
    const input = ids();
    const fakeEnv = {
      ...appEnv(),
      SANDBOX_CONTROL: {
        getByName: () => ({
          authorizeWorktreeSnapshot: async () => true,
          isWorktreeSnapshotTombstoned: async () => true,
        }),
      },
    } as unknown as Env;
    const bytes = crypto.getRandomValues(new Uint8Array(512));

    const put = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': await sha256Hex(bytes),
        },
        body: bytes,
      },
      fakeEnv
    );
    expect(put.status).toBe(403);
    expect(await bucket.head(worktreeSnapshotObjectKey(input.worktreeId))).toBeNull();
  });

  it('preserves an accepted upload when the allocation changes', async () => {
    const input = ids();
    const { sandbox } = await seed('connected', input);
    const bytes = crypto.getRandomValues(new Uint8Array(512));

    const put = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': await sha256Hex(bytes),
        },
        body: bytes,
      },
      appEnv()
    );
    expect(put.status).toBe(204);

    await runInDurableObject(sandbox, async (_instance, doState) => {
      const db = drizzle(doState.storage, { logger: false });
      db.update(allocationTable)
        .set({ allocation_id: crypto.randomUUID() })
        .where(eq(allocationTable.id, 'current'))
        .run();
    });

    const get = await app().request(
      path(input),
      { method: 'GET', headers: { Authorization: `Bearer ${launchToken(input)}` } },
      appEnv()
    );
    expect(get.status).toBe(403);
    expect(await bucket.head(worktreeSnapshotObjectKey(input.worktreeId))).not.toBeNull();
  });

  it('rejects a paused old-allocation upload when a newer upload creates a missing object', async () => {
    await runStaleUploadRace(false);
  });

  it('rejects a paused old-allocation upload when a newer upload replaces an existing object', async () => {
    await runStaleUploadRace(true);
  });

  it('publishes a held upload after allocation replacement when no newer publication intervenes', async () => {
    const input = ids();
    const { sandbox } = await seed('connected', input);
    const key = worktreeSnapshotObjectKey(input.worktreeId);
    const gated = gatedSnapshotBucket(bucket);
    const bytes = new TextEncoder().encode('held-allocation-state');
    const gate = gated.gateNextPut();

    const upload = app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': await sha256Hex(bytes),
        },
        body: bytes,
      },
      appEnv(gated.bucket)
    );

    await gate.started;
    await runInDurableObject(sandbox, async (_instance, doState) => {
      const db = drizzle(doState.storage, { logger: false });
      db.update(allocationTable)
        .set({ allocation_id: crypto.randomUUID() })
        .where(eq(allocationTable.id, 'current'))
        .run();
    });
    gate.release();

    expect((await upload).status).toBe(204);
    expect(await objectBytes(key)).toEqual(bytes);

    const get = await app().request(
      path(input),
      { method: 'GET', headers: { Authorization: `Bearer ${launchToken(input)}` } },
      appEnv(gated.bucket)
    );
    expect(get.status).toBe(403);
  });

  it('leaves the last good checkpoint when the body is shorter than Content-Length', async () => {
    const input = ids();
    await seed('connected', input);
    const key = worktreeSnapshotObjectKey(input.worktreeId);
    const lastGood = new TextEncoder().encode('last-good-state');
    await bucket.put(key, lastGood);
    const bytes = new TextEncoder().encode('short-state');

    const response = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength + 1),
          'x-kilo-sha256': await sha256Hex(bytes),
        },
        body: bytes,
      },
      appEnv()
    );

    expect(response.status).toBe(400);
    expect(await objectBytes(key)).toEqual(lastGood);
  });

  it('leaves the last good checkpoint when the digest does not match', async () => {
    const input = ids();
    await seed('connected', input);
    const key = worktreeSnapshotObjectKey(input.worktreeId);
    const lastGood = new TextEncoder().encode('last-good-state');
    await bucket.put(key, lastGood);
    const bytes = crypto.getRandomValues(new Uint8Array(1024));

    const response = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': '0'.repeat(64),
        },
        body: bytes,
      },
      appEnv()
    );

    expect(response.status).toBe(400);
    expect(await objectBytes(key)).toEqual(lastGood);
  });

  it('leaves the last good checkpoint when a lying Content-Length hides a body over the cap', async () => {
    const input = ids();
    await seed('connected', input);
    const key = worktreeSnapshotObjectKey(input.worktreeId);
    const lastGood = new TextEncoder().encode('last-good-state');
    await bucket.put(key, lastGood);

    const declaredLength = 1024;
    const digest = await sha256Hex(new Uint8Array(declaredLength));
    const chunkSize = 1024 * 1024;
    const totalChunks = Math.ceil(WORKTREE_SNAPSHOT_MAX_BYTES / chunkSize) + 1;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= totalChunks) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new Uint8Array(chunkSize));
      },
    });

    const response = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(declaredLength),
          'x-kilo-sha256': digest,
        },
        body,
      },
      appEnv()
    );

    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(totalChunks);
    expect(await objectBytes(key)).toEqual(lastGood);
  });

  it('deletes the snapshot and writes a tombstone with the worktree', async () => {
    const input = ids();
    const { sandbox } = await seed('stopped', input);
    const bytes = crypto.getRandomValues(new Uint8Array(512));
    await bucket.put(worktreeSnapshotObjectKey(input.worktreeId), bytes);
    await expect(
      sandbox.isWorktreeSnapshotTombstoned({ worktreeId: input.worktreeId })
    ).resolves.toBe(false);

    await expect(
      sandbox.deleteWorktreeResources({
        worktreeId: input.worktreeId,
        kiloUserId: 'user_snapshot',
        location: { sandboxId: input.sandboxId, provider: 'cloudflare' },
        sessionIds: [input.kiloSessionId],
      })
    ).resolves.toEqual({ deleted: true, sessionIds: [input.kiloSessionId] });

    expect(await bucket.head(worktreeSnapshotObjectKey(input.worktreeId))).toBeNull();
    const tombstone = await runInDurableObject(sandbox, (_instance, state) =>
      state.storage.get(worktreeSnapshotTombstoneKey(input.worktreeId))
    );
    expect(tombstone).toBeDefined();
    await expect(
      sandbox.isWorktreeSnapshotTombstoned({ worktreeId: input.worktreeId })
    ).resolves.toBe(true);
    await expect(
      sandbox.authorizeWorktreeSnapshot({
        allocationId: input.allocationId,
        worktreeId: input.worktreeId,
        credential: input.credential,
      })
    ).resolves.toBe(false);

    const put = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': await sha256Hex(bytes),
        },
        body: bytes,
      },
      appEnv()
    );
    expect(put.status).toBe(403);
    expect(await bucket.head(worktreeSnapshotObjectKey(input.worktreeId))).toBeNull();

    const get = await app().request(
      path(input),
      { method: 'GET', headers: { Authorization: `Bearer ${launchToken(input)}` } },
      appEnv()
    );
    expect(get.status).toBe(403);
  });

  it('deletes an upload that completes while the worktree deletion is in flight', async () => {
    const input = ids();
    const { sandbox } = await seed('connected', input);
    const key = worktreeSnapshotObjectKey(input.worktreeId);
    const gated = gatedSnapshotBucket(bucket);
    const bytes = new TextEncoder().encode('racing-deletion-state');
    const gate = gated.gateNextPut();

    const upload = app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${launchToken(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': await sha256Hex(bytes),
        },
        body: bytes,
      },
      appEnv(gated.bucket)
    );

    await gate.started;
    await runInDurableObject(sandbox, async (_instance, doState) => {
      const db = drizzle(doState.storage, { logger: false });
      db.update(allocationTable)
        .set({ state: 'stopped', connection_id: null })
        .where(eq(allocationTable.id, 'current'))
        .run();
    });
    await sandbox.deleteWorktreeResources({
      worktreeId: input.worktreeId,
      kiloUserId: 'user_snapshot',
      location: { sandboxId: input.sandboxId, provider: 'cloudflare' },
      sessionIds: [input.kiloSessionId],
    });
    gate.release();

    expect((await upload).status).toBe(403);
    expect(await bucket.head(key)).toBeNull();
    await expect(
      sandbox.isWorktreeSnapshotTombstoned({ worktreeId: input.worktreeId })
    ).resolves.toBe(true);

    const get = await app().request(
      path(input),
      { method: 'GET', headers: { Authorization: `Bearer ${launchToken(input)}` } },
      appEnv(gated.bucket)
    );
    expect(get.status).toBe(403);
  });

  it('keeps the tombstone and unrelated queue operations available while a delete is held', async () => {
    const input = ids();
    const { sandbox } = await seed('stopped', input);
    let deleteStarted = false;
    const fakeBucket = {
      head: async () => null,
      get: async () => null,
      put: async () => {
        throw new Error('unexpected snapshot put');
      },
      delete: async () => {
        deleteStarted = true;
        return new Promise<void>(() => undefined);
      },
    };
    await runInDurableObject(sandbox, async instance => {
      Object.assign((instance as unknown as { env: Env }).env, {
        WORKTREE_SNAPSHOTS_BUCKET: fakeBucket,
      });
    });

    const deletion = sandbox.deleteWorktreeResources({
      worktreeId: input.worktreeId,
      kiloUserId: 'user_snapshot',
      location: { sandboxId: input.sandboxId, provider: 'cloudflare' },
      sessionIds: [input.kiloSessionId],
    });
    await waitFor(() => deleteStarted);

    const state = await sandbox.getAllocationState();
    expect(state.kind).toBe('stopped');
    await expect(
      sandbox.isWorktreeSnapshotTombstoned({ worktreeId: input.worktreeId })
    ).resolves.toBe(true);
    await expect(deletion).resolves.toEqual({
      deleted: true,
      sessionIds: [input.kiloSessionId],
    });
  });

  it('keeps the tombstone when the snapshot object delete fails', async () => {
    const input = ids();
    const { sandbox } = await seed('stopped', input);
    const fakeBucket = {
      head: async () => null,
      get: async () => null,
      put: async () => {
        throw new Error('unexpected snapshot put');
      },
      delete: async () => {
        throw new Error('r2 delete unavailable');
      },
    };
    await runInDurableObject(sandbox, async instance => {
      Object.assign((instance as unknown as { env: Env }).env, {
        WORKTREE_SNAPSHOTS_BUCKET: fakeBucket,
      });
    });

    await expect(
      sandbox.deleteWorktreeResources({
        worktreeId: input.worktreeId,
        kiloUserId: 'user_snapshot',
        location: { sandboxId: input.sandboxId, provider: 'cloudflare' },
        sessionIds: [input.kiloSessionId],
      })
    ).resolves.toEqual({ deleted: true, sessionIds: [input.kiloSessionId] });

    await expect(
      sandbox.isWorktreeSnapshotTombstoned({ worktreeId: input.worktreeId })
    ).resolves.toBe(true);
    await expect(
      sandbox.authorizeWorktreeSnapshot({
        allocationId: input.allocationId,
        worktreeId: input.worktreeId,
        credential: input.credential,
      })
    ).resolves.toBe(false);
  });

  it('keeps the tombstone when a deletion is replayed', async () => {
    const input = ids();
    const { sandbox } = await seed('stopped', input);
    const deletion = {
      worktreeId: input.worktreeId,
      kiloUserId: 'user_snapshot',
      location: { sandboxId: input.sandboxId, provider: 'cloudflare' as const },
      sessionIds: [input.kiloSessionId],
    };

    await expect(sandbox.deleteWorktreeResources(deletion)).resolves.toEqual({
      deleted: true,
      sessionIds: [input.kiloSessionId],
    });
    await expect(sandbox.deleteWorktreeResources(deletion)).resolves.toEqual({
      deleted: true,
      sessionIds: [input.kiloSessionId],
    });
    await expect(
      sandbox.isWorktreeSnapshotTombstoned({ worktreeId: input.worktreeId })
    ).resolves.toBe(true);
  });

  it('bounds a hung snapshot object delete', async () => {
    const input = ids();
    const { sandbox } = await seed('stopped', input);
    const fakeBucket = {
      head: async () => null,
      get: async () => null,
      put: async () => {
        throw new Error('unexpected snapshot put');
      },
      delete: async () => new Promise<void>(() => undefined),
    };
    await runInDurableObject(sandbox, async instance => {
      Object.assign((instance as unknown as { env: Env }).env, {
        WORKTREE_SNAPSHOTS_BUCKET: fakeBucket,
      });
    });

    const startedAt = Date.now();
    await expect(
      sandbox.deleteWorktreeResources({
        worktreeId: input.worktreeId,
        kiloUserId: 'user_snapshot',
        location: { sandboxId: input.sandboxId, provider: 'cloudflare' },
        sessionIds: [input.kiloSessionId],
      })
    ).resolves.toEqual({ deleted: true, sessionIds: [input.kiloSessionId] });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expect(
      sandbox.isWorktreeSnapshotTombstoned({ worktreeId: input.worktreeId })
    ).resolves.toBe(true);
  });
});
