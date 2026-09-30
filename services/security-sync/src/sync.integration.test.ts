import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { createDrizzleClient } from '@kilocode/db/client';
import { agent_configs, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  advanceOwnerSyncFreshness,
  claimOwnerSyncLease,
  clearSyncRunProgress,
  releaseOwnerSyncLease,
  syncOwner,
  writeSyncRunProgress,
  SECURITY_SYNC_LEASE_TTL_MS,
} from './sync.js';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const testUserId = `security-sync-lease-${randomUUID()}`;
const agentConfigId = randomUUID();
const owner = { userId: testUserId };

let client: ReturnType<typeof createDrizzleClient>;

function progress(runId: string, completedRepos: string[], chunkIndex: number) {
  return {
    runId,
    completedRepos,
    staleRepos: [],
    authInvalidRepos: [],
    synced: 0,
    errors: 0,
    skipped: 0,
    authInvalid: 0,
    reauthRequired: false,
    noProgressChunks: 0,
    chunkIndex,
  };
}

async function readRuntimeState(): Promise<Record<string, unknown>> {
  const [row] = await client.db
    .select({ runtime_state: agent_configs.runtime_state })
    .from(agent_configs)
    .where(eq(agent_configs.id, agentConfigId));
  return (row?.runtime_state ?? {}) as Record<string, unknown>;
}

async function resetRuntimeState(state: Record<string, unknown> = {}): Promise<void> {
  await client.db
    .update(agent_configs)
    .set({ runtime_state: state })
    .where(eq(agent_configs.id, agentConfigId));
}

describe('security sync owner lease in PostgreSQL', () => {
  beforeAll(async () => {
    client = createDrizzleClient({ connectionString, ssl: false });
    await client.db.insert(kilocode_users).values({
      id: testUserId,
      google_user_email: `${testUserId}@example.com`,
      google_user_name: 'Security Sync Lease DB Test',
      google_user_image_url: 'https://example.com/avatar.png',
      stripe_customer_id: `cus_${randomUUID()}`,
    });
    await client.db.insert(agent_configs).values({
      id: agentConfigId,
      owned_by_user_id: testUserId,
      agent_type: 'security_scan',
      platform: 'github',
      config: {},
      created_by: 'test',
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetRuntimeState({});
  });

  afterAll(async () => {
    await client.db.delete(agent_configs).where(eq(agent_configs.id, agentConfigId));
    await client.db.delete(kilocode_users).where(eq(kilocode_users.id, testUserId));
    await client.pool.end();
  });

  it('denies a claim while another run holds the lease', async () => {
    const before = Date.now();
    const claimed = await claimOwnerSyncLease(client.db as never, owner, 'holder-run', 0);
    expect(claimed).not.toBeNull();
    expect(claimed?.runtimeState).toMatchObject({
      sync_lease: expect.objectContaining({ runId: 'holder-run', chunkIndex: 0 }),
    });
    await expect(
      claimOwnerSyncLease(client.db as never, owner, 'other-run', 0)
    ).resolves.toBeNull();

    const state = await readRuntimeState();
    const lease = state.sync_lease as { runId: string; chunkIndex: number; expiresAt: string };
    expect(lease).toMatchObject({ runId: 'holder-run', chunkIndex: 0 });
    expect(state.sync_run).toMatchObject({ runId: 'holder-run', completedRepos: [] });
    const expiresAt = new Date(lease.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(before + SECURITY_SYNC_LEASE_TTL_MS - 60_000);
    expect(expiresAt).toBeLessThan(Date.now() + SECURITY_SYNC_LEASE_TTL_MS + 60_000);
  });

  it('lets exactly one of two concurrent connections acquire the lease', async () => {
    const clientB = createDrizzleClient({ connectionString, ssl: false });
    try {
      const [a, b] = await Promise.all([
        claimOwnerSyncLease(client.db as never, owner, 'run-a', 0),
        claimOwnerSyncLease(clientB.db as never, owner, 'run-b', 0),
      ]);
      expect([a, b].filter(result => result !== null)).toHaveLength(1);

      const winner = a ? 'run-a' : 'run-b';
      const state = await readRuntimeState();
      expect(state.sync_lease).toMatchObject({ runId: winner, chunkIndex: 0 });
    } finally {
      await clientB.pool.end();
    }
  });

  it('takes over an expired lease with a fresh skeleton and no cursor copy', async () => {
    await resetRuntimeState({
      sync_lease: { runId: 'old-run', chunkIndex: 0, expiresAt: '2000-01-01T00:00:00.000Z' },
      sync_run: progress('old-run', ['old-repo'], 0),
    });

    const claimed = await claimOwnerSyncLease(client.db as never, owner, 'new-run', 0);
    expect(claimed).not.toBeNull();

    const state = await readRuntimeState();
    expect(state.sync_run).toMatchObject({ runId: 'new-run', completedRepos: [] });
    expect(JSON.stringify(state.sync_run)).not.toContain('old-repo');
    expect(state.sync_run).not.toHaveProperty('chunkIndex');
    expect(state.sync_lease).toMatchObject({ runId: 'new-run', chunkIndex: 0 });

    // The displaced run cannot reclaim the lease, even at a higher chunk index.
    await expect(claimOwnerSyncLease(client.db as never, owner, 'old-run', 5)).resolves.toBeNull();
  });

  it('rejects foreign write, clear, and freshness mutations', async () => {
    await claimOwnerSyncLease(client.db as never, owner, 'run-f', 0);

    await expect(
      writeSyncRunProgress(client.db as never, owner, progress('other-run', ['acme/a'], 0))
    ).resolves.toEqual({ written: false });
    await expect(clearSyncRunProgress(client.db as never, owner, 'other-run', 0)).resolves.toEqual({
      cleared: false,
    });
    await expect(
      advanceOwnerSyncFreshness(client.db as never, owner, 'other-run', 0)
    ).resolves.toEqual({ advanced: false });

    const state = await readRuntimeState();
    expect(state.sync_lease).toMatchObject({ runId: 'run-f', chunkIndex: 0 });
    expect(state.sync_run).toMatchObject({ runId: 'run-f', completedRepos: [] });
    expect(state.last_synced_at).toBeUndefined();
    expect(state.last_completed_run_id).toBeUndefined();
  });

  it('rejects older same-run clear and freshness and leaves state unchanged', async () => {
    await claimOwnerSyncLease(client.db as never, owner, 'run-older', 1);
    await expect(
      writeSyncRunProgress(client.db as never, owner, progress('run-older', ['acme/a'], 1))
    ).resolves.toEqual({ written: true });

    await expect(clearSyncRunProgress(client.db as never, owner, 'run-older', 0)).resolves.toEqual({
      cleared: false,
    });
    await expect(
      advanceOwnerSyncFreshness(client.db as never, owner, 'run-older', 0)
    ).resolves.toEqual({ advanced: false });

    const state = await readRuntimeState();
    expect(state.sync_run).toMatchObject({
      runId: 'run-older',
      completedRepos: ['acme/a'],
      chunkIndex: 1,
    });
    expect(state.sync_lease).toMatchObject({ runId: 'run-older', chunkIndex: 1 });
    expect(state.last_synced_at).toBeUndefined();
    expect(state.last_completed_run_id).toBeUndefined();
  });

  it('fences chunk writes: older rejected, equal accepted, union preserved', async () => {
    await claimOwnerSyncLease(client.db as never, owner, 'run-c', 1);

    await expect(
      writeSyncRunProgress(client.db as never, owner, {
        ...progress('run-c', ['acme/a'], 1),
        synced: 3,
        errors: 1,
      })
    ).resolves.toEqual({ written: true });
    await expect(
      writeSyncRunProgress(client.db as never, owner, {
        ...progress('run-c', ['acme/b'], 1),
        synced: 7,
        errors: 2,
      })
    ).resolves.toEqual({ written: true });

    let state = await readRuntimeState();
    expect(state.sync_run).toMatchObject({
      completedRepos: ['acme/a', 'acme/b'],
      synced: 7,
      errors: 2,
      chunkIndex: 1,
    });

    await expect(
      writeSyncRunProgress(client.db as never, owner, progress('run-c', ['acme/c'], 0))
    ).resolves.toEqual({ written: false });

    state = await readRuntimeState();
    expect(state.sync_run).toMatchObject({
      completedRepos: ['acme/a', 'acme/b'],
      chunkIndex: 1,
    });
    expect(state.sync_lease).toMatchObject({ runId: 'run-c', chunkIndex: 1 });
  });

  it('guards release by run id and chunk fence', async () => {
    await claimOwnerSyncLease(client.db as never, owner, 'run-r', 2);

    await expect(releaseOwnerSyncLease(client.db as never, owner, 'other-run', 2)).resolves.toEqual(
      { released: false }
    );
    await expect(releaseOwnerSyncLease(client.db as never, owner, 'run-r', 1)).resolves.toEqual({
      released: false,
    });
    await expect(releaseOwnerSyncLease(client.db as never, owner, 'run-r', 2)).resolves.toEqual({
      released: true,
    });
    expect((await readRuntimeState()).sync_lease).toBeUndefined();
  });

  it('completion sets last_completed_run_id and removes the cursor', async () => {
    await claimOwnerSyncLease(client.db as never, owner, 'run-done', 0);

    await expect(
      advanceOwnerSyncFreshness(client.db as never, owner, 'run-done', 0)
    ).resolves.toEqual({ advanced: true });

    const state = await readRuntimeState();
    expect(state.last_completed_run_id).toBe('run-done');
    expect(state.sync_run).toBeUndefined();
    expect(typeof state.last_synced_at).toBe('string');

    await expect(releaseOwnerSyncLease(client.db as never, owner, 'run-done', 0)).resolves.toEqual({
      released: true,
    });

    const getToken = vi.fn(async () => {
      throw new Error('getToken must not be called for a completed redelivery');
    });
    const redelivered = await syncOwner({
      db: client.db as never,
      gitTokenService: { getToken } as never,
      owner,
      runId: 'run-done',
      chunkIndex: 0,
    });

    expect(redelivered).not.toHaveProperty('claimDenied');
    expect(redelivered).not.toHaveProperty('staleChunk');
    expect(redelivered).not.toHaveProperty('checkpointRejected');
    expect(redelivered.exhaustedBudget).toBe(false);
    expect(getToken).not.toHaveBeenCalled();

    const after = await readRuntimeState();
    expect(after.sync_run).toBeUndefined();
    expect(after.sync_lease).toBeUndefined();
  });

  it('returns staleChunk for an older same-run delivery without minting a token', async () => {
    await claimOwnerSyncLease(client.db as never, owner, 'run-stale', 2);
    const getToken = vi.fn(async () => 'github-token');
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    const result = await syncOwner({
      db: client.db as never,
      gitTokenService: { getToken } as never,
      owner,
      runId: 'run-stale',
      chunkIndex: 1,
    });

    expect(result).toMatchObject({ staleChunk: true, exhaustedBudget: false });
    expect(result).not.toHaveProperty('claimDenied');
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();

    const state = await readRuntimeState();
    expect(state.sync_lease).toMatchObject({ runId: 'run-stale', chunkIndex: 2 });
  });
});
