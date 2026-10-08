import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomInt, randomUUID } from 'crypto';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  agent_configs,
  github_app_installations,
  kilocode_users,
  platform_integrations,
  security_findings,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
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

const relinkAlert = {
  number: 4242,
  state: 'open',
  dependency: {
    package: { ecosystem: 'npm', name: 'lodash' },
    manifest_path: 'package.json',
    scope: 'runtime',
  },
  security_advisory: {
    ghsa_id: 'GHSA-relink-0000-0001',
    cve_id: null,
    summary: 'Relink test advisory',
    description: 'Advisory used to exercise platform integration relinking.',
    severity: 'high',
    cvss: { score: 7.5, vector_string: null },
    cwes: [{ cwe_id: 'CWE-1321', name: 'Prototype Pollution' }],
  },
  security_vulnerability: {
    vulnerable_version_range: '< 4.17.21',
    first_patched_version: { identifier: '4.17.21' },
  },
  created_at: '2026-01-15T00:00:00Z',
  updated_at: '2026-01-15T00:00:00Z',
  fixed_at: null,
  dismissed_at: null,
  html_url: 'https://github.com/acme/relink/security/dependabot/4242',
  url: 'https://api.github.com/repos/acme/relink/dependabot/alerts/4242',
};

function stubRelinkFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify([relinkAlert]), { status: 200 }))
  );
}

async function insertSyncIntegration(repoFullName: string): Promise<string> {
  const id = randomUUID();
  const [, repoName] = repoFullName.split('/');
  await client.db.insert(platform_integrations).values({
    id,
    owned_by_user_id: testUserId,
    platform: 'github',
    integration_type: 'app',
    platform_installation_id: `security-sync-relink-${randomUUID()}`,
    permissions: { vulnerability_alerts: 'read' },
    repositories: [{ id: 1, name: repoName ?? 'relink', full_name: repoFullName, private: true }],
    integration_status: 'active',
    github_connection_role: 'workflow',
  });
  return id;
}

async function readRelinkFinding(repoFullName: string) {
  const [finding] = await client.db
    .select()
    .from(security_findings)
    .where(
      and(
        eq(security_findings.repo_full_name, repoFullName),
        eq(security_findings.owned_by_user_id, testUserId)
      )
    );
  if (!finding) throw new Error(`Missing relink finding for ${repoFullName}`);
  return finding;
}

async function cleanupRelink(repoFullName: string, integrationIds: string[]): Promise<void> {
  await client.db
    .delete(security_findings)
    .where(
      and(
        eq(security_findings.repo_full_name, repoFullName),
        eq(security_findings.owned_by_user_id, testUserId)
      )
    );
  for (const id of integrationIds) {
    await client.db.delete(platform_integrations).where(eq(platform_integrations.id, id));
  }
}

function createSyncOwnerDeps() {
  return {
    db: client.db as never,
    gitTokenService: { getToken: vi.fn(async () => 'github-token') } as never,
    owner,
  };
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

  it('takes over an expired lease and adopts the previous run progress', async () => {
    await resetRuntimeState({
      sync_lease: { runId: 'old-run', chunkIndex: 6, expiresAt: '2000-01-01T00:00:00.000Z' },
      sync_run: {
        ...progress('old-run', ['old-repo'], 6),
        staleRepos: ['gone-repo'],
        synced: 3,
        noProgressChunks: 1,
      },
    });

    const claimed = await claimOwnerSyncLease(client.db as never, owner, 'new-run', 0);
    expect(claimed).not.toBeNull();

    const state = await readRuntimeState();
    expect(state.sync_run).toEqual({
      ...progress('new-run', ['old-repo'], 0),
      staleRepos: ['gone-repo'],
      synced: 3,
      chunkIndex: undefined,
    });
    expect(state.sync_run).not.toHaveProperty('chunkIndex');
    expect(state.sync_lease).toMatchObject({ runId: 'new-run', chunkIndex: 0 });

    // The adopted cursor carries no chunk fence, so the new run's chunk 0 can write and complete.
    await expect(
      writeSyncRunProgress(client.db as never, owner, progress('new-run', ['new-repo'], 0))
    ).resolves.toEqual({ written: true });
    expect((await readRuntimeState()).sync_run).toMatchObject({
      completedRepos: expect.arrayContaining(['old-repo', 'new-repo']),
    });
    await expect(
      advanceOwnerSyncFreshness(client.db as never, owner, 'new-run', 0)
    ).resolves.toEqual({ advanced: true });

    // The displaced run cannot reclaim the lease, even at a higher chunk index.
    await expect(claimOwnerSyncLease(client.db as never, owner, 'old-run', 7)).resolves.toBeNull();
  });

  it('continues an abandoned run from its checkpoint and completes the owner', async () => {
    const integrationId = randomUUID();
    await client.db.insert(platform_integrations).values({
      id: integrationId,
      owned_by_user_id: testUserId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: `security-sync-lease-${randomUUID()}`,
      permissions: { vulnerability_alerts: 'read' },
      repositories: [
        { id: 1, name: 'a', full_name: 'acme/a', private: true },
        { id: 2, name: 'b', full_name: 'acme/b', private: true },
        { id: 3, name: 'c', full_name: 'acme/c', private: true },
      ],
      integration_status: 'active',
      github_connection_role: 'workflow',
    });
    try {
      await resetRuntimeState({
        sync_lease: { runId: 'dead-run', chunkIndex: 3, expiresAt: '2000-01-01T00:00:00.000Z' },
        sync_run: progress('dead-run', ['acme/a', 'acme/b'], 3),
      });
      const fetchStub = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
      vi.stubGlobal('fetch', fetchStub);

      const result = await syncOwner({
        db: client.db as never,
        gitTokenService: { getToken: vi.fn(async () => 'github-token') } as never,
        owner,
        runId: 'next-run',
        chunkIndex: 0,
        budgetMs: 60_000,
      });

      expect(result).toMatchObject({ exhaustedBudget: false, remainingRepoCount: 0, errors: 0 });
      const fetchedUrls = fetchStub.mock.calls.map(call => String((call as unknown[])[0]));
      expect(fetchedUrls).toHaveLength(1);
      expect(fetchedUrls[0]).toContain('/repos/acme/c/dependabot/alerts');

      const state = await readRuntimeState();
      expect(typeof state.last_synced_at).toBe('string');
      expect(state.last_completed_run_id).toBe('next-run');
      expect(state.sync_run).toBeUndefined();
      expect(state.sync_lease).toBeUndefined();
    } finally {
      await client.db
        .delete(platform_integrations)
        .where(eq(platform_integrations.id, integrationId));
    }
  });

  it('starts a fresh cursor when a new run claims an owner without progress', async () => {
    const claimed = await claimOwnerSyncLease(client.db as never, owner, 'first-run', 0);
    expect(claimed).not.toBeNull();

    const state = await readRuntimeState();
    expect(state.sync_run).toEqual({ ...progress('first-run', [], 0), chunkIndex: undefined });
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

  it.each(['link', 'sla'] as const)(
    'preserves a local dismissal during a %s-only update',
    async change => {
      const repo = `acme/relink-null-${randomUUID()}`;
      const integrationId = await insertSyncIntegration(repo);
      const ignoredAt = '2026-02-01T00:00:00.000Z';
      try {
        stubRelinkFetch();
        await syncOwner({ ...createSyncOwnerDeps(), runId: 'relink-null-1', chunkIndex: 0 });

        const inserted = await readRelinkFinding(repo);
        expect(inserted.platform_integration_id).toBe(integrationId);

        await client.db
          .update(security_findings)
          .set({
            platform_integration_id: change === 'link' ? null : integrationId,
            status: 'ignored',
            ignored_reason: 'manual-dismissal',
            ignored_by: 'test-user',
            fixed_at: ignoredAt,
          })
          .where(eq(security_findings.id, inserted.id));

        if (change === 'sla') {
          await client.db
            .update(agent_configs)
            .set({ config: { sla_high_days: 14 } })
            .where(eq(agent_configs.id, agentConfigId));
        }

        stubRelinkFetch();
        await syncOwner({ ...createSyncOwnerDeps(), runId: 'relink-null-2', chunkIndex: 0 });

        const relinked = await readRelinkFinding(repo);
        expect(relinked).toMatchObject({
          platform_integration_id: integrationId,
          status: 'ignored',
          ignored_reason: 'manual-dismissal',
          ignored_by: 'test-user',
        });
        expect(new Date(relinked.fixed_at ?? '').toISOString()).toBe(ignoredAt);
        if (change === 'sla') expect(relinked.sla_due_at).not.toBe(inserted.sla_due_at);
      } finally {
        await cleanupRelink(repo, [integrationId]);
        await client.db
          .update(agent_configs)
          .set({ config: {} })
          .where(eq(agent_configs.id, agentConfigId));
      }
    }
  );

  it('updates platform_integration_id when the active integration changes', async () => {
    const repo = `acme/relink-changed-${randomUUID()}`;
    const integrationA = await insertSyncIntegration(repo);
    let integrationB: string | null = null;
    try {
      stubRelinkFetch();
      await syncOwner({ ...createSyncOwnerDeps(), runId: 'relink-changed-1', chunkIndex: 0 });
      expect((await readRelinkFinding(repo)).platform_integration_id).toBe(integrationA);

      await client.db
        .update(platform_integrations)
        .set({ integration_status: 'suspended' })
        .where(eq(platform_integrations.id, integrationA));
      integrationB = await insertSyncIntegration(repo);

      stubRelinkFetch();
      await syncOwner({ ...createSyncOwnerDeps(), runId: 'relink-changed-2', chunkIndex: 0 });

      expect((await readRelinkFinding(repo)).platform_integration_id).toBe(integrationB);
    } finally {
      await cleanupRelink(repo, [integrationA, ...(integrationB ? [integrationB] : [])]);
    }
  });

  it('does not write an unchanged finding on re-sync', async () => {
    const repo = `acme/relink-noop-${randomUUID()}`;
    const integrationId = await insertSyncIntegration(repo);
    const sentinel = '2020-01-01T00:00:00.000Z';
    try {
      stubRelinkFetch();
      await syncOwner({ ...createSyncOwnerDeps(), runId: 'relink-noop-1', chunkIndex: 0 });

      const inserted = await readRelinkFinding(repo);
      await client.db
        .update(security_findings)
        .set({ last_synced_at: sentinel })
        .where(eq(security_findings.id, inserted.id));

      stubRelinkFetch();
      await syncOwner({ ...createSyncOwnerDeps(), runId: 'relink-noop-2', chunkIndex: 0 });

      const after = await readRelinkFinding(repo);
      expect(new Date(after.last_synced_at).getTime()).toBe(new Date(sentinel).getTime());
    } finally {
      await cleanupRelink(repo, [integrationId]);
    }
  });

  it.each(['association', 'canonical', 'new-alert'] as const)(
    'rejects stale %s observations after integration retirement',
    async retirement => {
      const repo = `acme/relink-retired-${randomUUID()}`;
      const integrationA = await insertSyncIntegration(repo);
      let integrationB: string | null = null;
      let canonicalId: string | null = null;
      try {
        stubRelinkFetch();
        await syncOwner({ ...createSyncOwnerDeps(), runId: 'relink-retired-1', chunkIndex: 0 });

        if (retirement === 'canonical') {
          canonicalId = randomUUID();
          const installationId = randomInt(1, 2 ** 48 - 1).toString();
          await client.db.insert(github_app_installations).values({
            id: canonicalId,
            installation_id: installationId,
            github_app_type: 'standard',
            lifecycle_state: 'active',
            permissions: { vulnerability_alerts: 'read' },
            repositories: [{ id: 1, name: 'repo', full_name: repo, private: true }],
          });
          await client.db
            .update(platform_integrations)
            .set({
              github_installation_id: canonicalId,
              platform_installation_id: installationId,
              github_app_type: 'standard',
            })
            .where(eq(platform_integrations.id, integrationA));
        }

        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            if (canonicalId) {
              await client.db
                .update(github_app_installations)
                .set({ lifecycle_state: 'suspended' })
                .where(eq(github_app_installations.id, canonicalId));
            } else {
              await client.db
                .update(platform_integrations)
                .set({ integration_status: 'suspended' })
                .where(eq(platform_integrations.id, integrationA));
            }
            integrationB = await insertSyncIntegration(repo);
            await client.db
              .update(security_findings)
              .set({
                platform_integration_id: integrationB,
                status: 'ignored',
                ignored_reason: 'manual-dismissal',
                ignored_by: 'test-user',
                fixed_at: '2026-02-01T00:00:00.000Z',
              })
              .where(
                and(
                  eq(security_findings.repo_full_name, repo),
                  eq(security_findings.owned_by_user_id, testUserId)
                )
              );
            return new Response(
              JSON.stringify([
                { ...relinkAlert, number: retirement === 'new-alert' ? 4243 : relinkAlert.number },
              ]),
              { status: 200 }
            );
          })
        );

        const result = await syncOwner({
          ...createSyncOwnerDeps(),
          runId: 'relink-retired-2',
          chunkIndex: 0,
        });
        expect(result.errors).toBe(retirement === 'new-alert' ? 1 : 0);

        const after = await readRelinkFinding(repo);
        expect(after).toMatchObject({
          platform_integration_id: integrationB,
          status: 'ignored',
          ignored_reason: 'manual-dismissal',
          ignored_by: 'test-user',
        });
        expect(new Date(after.fixed_at ?? '').toISOString()).toBe('2026-02-01T00:00:00.000Z');
        const rows = await client.db
          .select({ id: security_findings.id })
          .from(security_findings)
          .where(
            and(
              eq(security_findings.repo_full_name, repo),
              eq(security_findings.owned_by_user_id, testUserId)
            )
          );
        expect(rows).toHaveLength(1);
      } finally {
        await cleanupRelink(repo, [integrationA, ...(integrationB ? [integrationB] : [])]);
        if (canonicalId) {
          await client.db
            .delete(github_app_installations)
            .where(eq(github_app_installations.id, canonicalId));
        }
      }
    }
  );
});
