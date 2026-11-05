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
  mintWorktreeSnapshotGrant,
  worktreeSnapshotObjectKey,
  worktreeSnapshotTombstoneKey,
} from '../../src/sandbox-control/worktree-snapshot-grant.js';
import {
  registerWorktreeSnapshotRoutes,
  WORKTREE_SNAPSHOT_ROUTE_PREFIX,
} from '../../src/sandbox-control/worktree-snapshot-routes.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const secret = (env as unknown as { NEXTAUTH_SECRET: string }).NEXTAUTH_SECRET;
const bucket = (env as unknown as { RUNTIME_RELEASE_BUCKET: R2Bucket }).RUNTIME_RELEASE_BUCKET;

function app(): Hono<HonoContext> {
  const instance = new Hono<HonoContext>();
  registerWorktreeSnapshotRoutes(instance);
  return instance;
}

function appEnv(): Env {
  return {
    NEXTAUTH_SECRET: secret,
    WORKTREE_SNAPSHOT_WRITES_ENABLED: 'true',
    WORKTREE_SNAPSHOT_READS_ENABLED: 'true',
    WORKTREE_SNAPSHOTS_BUCKET: bucket,
    SANDBOX_CONTROL: sandboxes,
  } as unknown as Env;
}

function ids() {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  return {
    sandboxId: `sbx__snapshot_${suffix}`,
    allocationId: `allocation_${suffix}`,
    wrapperInstanceId: crypto.randomUUID(),
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
  return `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${input.sandboxId}/${input.allocationId}/${input.wrapperInstanceId}/${input.worktreeId}${suffix}`;
}

function grant(input: ReturnType<typeof ids>, allocationId = input.allocationId): string {
  return mintWorktreeSnapshotGrant(
    {
      sandboxId: input.sandboxId,
      allocationId,
      wrapperInstanceId: input.wrapperInstanceId,
    },
    secret
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

afterEach(async () => {
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
          Authorization: `Bearer ${grant(input)}`,
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
      { method: 'GET', headers: { Authorization: `Bearer ${grant(input)}` } },
      appEnv()
    );
    expect(get.status).toBe(200);
    expect(get.headers.get('x-kilo-sha256')).toBe(digest);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
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
          Authorization: `Bearer ${grant(input)}`,
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

    const staleAllocation = `allocation_stale_${crypto.randomUUID().replaceAll('-', '')}`;
    const stalePath = `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${input.sandboxId}/${staleAllocation}/${input.wrapperInstanceId}/${input.worktreeId}`;
    const stale = await app().request(
      stalePath,
      {
        method: 'PUT',
        headers: { ...headers, Authorization: `Bearer ${grant(input, staleAllocation)}` },
        body: bytes,
      },
      appEnv()
    );
    expect(stale.status).toBe(403);

    const missing = ids();
    const missingPath = `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${input.sandboxId}/${input.allocationId}/${input.wrapperInstanceId}/${missing.worktreeId}`;
    const noRoute = await app().request(
      missingPath,
      {
        method: 'PUT',
        headers: {
          ...headers,
          Authorization: `Bearer ${mintWorktreeSnapshotGrant(
            {
              sandboxId: input.sandboxId,
              allocationId: input.allocationId,
              wrapperInstanceId: input.wrapperInstanceId,
            },
            secret
          )}`,
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
          Authorization: `Bearer ${grant(input)}`,
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
          Authorization: `Bearer ${grant(input)}`,
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
        .set({ allocation_id: `allocation_next_${crypto.randomUUID().replaceAll('-', '')}` })
        .where(eq(allocationTable.id, 'current'))
        .run();
    });

    const get = await app().request(
      path(input),
      { method: 'GET', headers: { Authorization: `Bearer ${grant(input)}` } },
      appEnv()
    );
    expect(get.status).toBe(403);
    expect(await bucket.head(worktreeSnapshotObjectKey(input.worktreeId))).not.toBeNull();
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
      })
    ).resolves.toBe(false);

    const put = await app().request(
      path(input),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${grant(input)}`,
          'Content-Length': String(bytes.byteLength),
          'x-kilo-sha256': await sha256Hex(bytes),
        },
        body: bytes,
      },
      appEnv()
    );
    expect(put.status).toBe(403);
    expect(await bucket.head(worktreeSnapshotObjectKey(input.worktreeId))).toBeNull();
  });
});
