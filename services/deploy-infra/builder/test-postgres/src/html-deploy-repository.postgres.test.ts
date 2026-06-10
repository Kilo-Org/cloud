import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { deployments, deployments_ephemeral, kilocode_users } from '@kilocode/db/schema';
import { eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  activateEphemeralDeployment,
  claimDueEphemeralDeployments,
  completeClaimedEphemeralDeploymentCleanup,
  completeUnclaimedEphemeralDeploymentCleanup,
  createPendingEphemeralDeployment,
  markEphemeralDeploymentForCleanup,
  retryClaimedEphemeralDeploymentCleanup,
} from '../../src/html-deploy/repository';
import { isStoredDeploymentSlug } from '../../src/html-deploy/stored-slug';

const fixturePrefix = `postgres-builder-${randomUUID()}`;
const now = '2026-06-03T12:00:00.000Z';
let fixtureSequence = 0;

function fixtureName(label: string): string {
  fixtureSequence += 1;
  return `${fixturePrefix}-${label}-${fixtureSequence}`;
}

function minutesAfter(timestamp: string, minutes: number): string {
  return new Date(new Date(timestamp).getTime() + minutes * 60_000).toISOString();
}

async function settleAsyncWork(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });

  return { promise, resolve: () => resolvePromise?.() };
}

async function insertOwner(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({ id: fixtureName('owner'), ...overrides });
}

async function insertEphemeralDeployment(
  overrides: Partial<typeof deployments_ephemeral.$inferInsert> = {}
) {
  const [deployment] = await db
    .insert(deployments_ephemeral)
    .values({
      source_type: 'html',
      internal_worker_name: fixtureName('qdpl'),
      status: 'pending',
      next_cleanup_at: now,
      ...overrides,
    })
    .returning();

  if (!deployment) throw new Error('Expected ephemeral deployment fixture');
  return deployment;
}

async function selectEphemeralDeployment(deploymentId: string) {
  const [deployment] = await db
    .select()
    .from(deployments_ephemeral)
    .where(eq(deployments_ephemeral.id, deploymentId));
  if (!deployment) throw new Error(`Expected ephemeral deployment ${deploymentId}`);
  return deployment;
}

afterEach(async () => {
  await db
    .delete(deployments_ephemeral)
    .where(like(deployments_ephemeral.internal_worker_name, `${fixturePrefix}%`));
  await db.delete(deployments).where(like(deployments.internal_worker_name, `${fixturePrefix}%`));
  await db.delete(kilocode_users).where(like(kilocode_users.id, `${fixturePrefix}%`));
});

describe('builder ephemeral deployment Postgres repository', () => {
  it('inserts a pending deployment for a retained owner with a nullable alias and rejects a soft-deleted owner', async () => {
    const retainedOwner = await insertOwner();
    const internalWorkerName = fixtureName('qdpl');

    const inserted = await createPendingEphemeralDeployment(db, {
      ownedByUserId: retainedOwner.id,
      internalWorkerName,
      pendingCleanupAt: minutesAfter(now, 10),
    });

    expect(inserted).toEqual({
      created: true,
      deployment: {
        id: expect.any(String),
        internalWorkerName,
      },
    });
    if (!inserted.created) throw new Error('Expected pending deployment insertion');
    expect(await selectEphemeralDeployment(inserted.deployment.id)).toEqual(
      expect.objectContaining({
        owned_by_user_id: retainedOwner.id,
        internal_worker_name: internalWorkerName,
        deployment_slug: null,
        status: 'pending',
        expires_at: null,
      })
    );

    const softDeletedOwner = await insertOwner({
      blocked_reason: 'soft-deleted at 2026-06-03T11:00:00.000Z',
    });
    await expect(
      createPendingEphemeralDeployment(db, {
        ownedByUserId: softDeletedOwner.id,
        internalWorkerName: fixtureName('qdpl'),
        pendingCleanupAt: minutesAfter(now, 10),
      })
    ).resolves.toEqual({ created: false, reason: 'owner_unavailable' });
  });

  it('waits for a retained-owner lock and rejects provisioning after soft-delete commits', async () => {
    const owner = await insertOwner();
    const ownerLocked = deferred();
    const releaseOwnerLock = deferred();
    let insertionSettled = false;

    const softDelete = db.transaction(async tx => {
      await tx
        .update(kilocode_users)
        .set({ blocked_reason: `soft-deleted at ${now}` })
        .where(eq(kilocode_users.id, owner.id));
      ownerLocked.resolve();
      await releaseOwnerLock.promise;
    });

    await ownerLocked.promise;
    const insertion = createPendingEphemeralDeployment(db, {
      ownedByUserId: owner.id,
      internalWorkerName: fixtureName('qdpl'),
      pendingCleanupAt: minutesAfter(now, 10),
    });
    void insertion.then(
      () => {
        insertionSettled = true;
      },
      () => {
        insertionSettled = true;
      }
    );

    try {
      await settleAsyncWork();
      expect(insertionSettled).toBe(false);
    } finally {
      releaseOwnerLock.resolve();
      await softDelete;
    }

    await expect(insertion).resolves.toEqual({ created: false, reason: 'owner_unavailable' });
  });

  it('activates only a live unclaimed pending deployment and marks partial creation for cleanup', async () => {
    const pending = await insertEphemeralDeployment({ next_cleanup_at: minutesAfter(now, 10) });
    const expiresAt = minutesAfter(now, 60);

    await expect(
      activateEphemeralDeployment(db, {
        deploymentId: pending.id,
        deploymentSlug: fixtureName('public'),
        expiresAt,
        now,
      })
    ).resolves.toBe(true);
    await expect(
      activateEphemeralDeployment(db, {
        deploymentId: pending.id,
        deploymentSlug: fixtureName('public'),
        expiresAt,
        now,
      })
    ).resolves.toBe(false);

    const active = await selectEphemeralDeployment(pending.id);
    expect(active).toEqual(expect.objectContaining({ status: 'active' }));
    expect(new Date(active.next_cleanup_at).toISOString()).toBe(expiresAt);
    await expect(
      claimDueEphemeralDeployments(db, {
        claimToken: randomUUID(),
        now,
        claimedUntil: minutesAfter(now, 20),
        limit: 25,
      })
    ).resolves.toEqual([]);

    const expiredPending = await insertEphemeralDeployment({ next_cleanup_at: now });
    await expect(
      activateEphemeralDeployment(db, {
        deploymentId: expiredPending.id,
        deploymentSlug: fixtureName('public'),
        expiresAt,
        now,
      })
    ).resolves.toBe(false);

    const claimedPending = await insertEphemeralDeployment({
      next_cleanup_at: minutesAfter(now, 10),
      cleanup_claim_token: randomUUID(),
      cleanup_claimed_until: minutesAfter(now, 20),
    });
    await expect(
      activateEphemeralDeployment(db, {
        deploymentId: claimedPending.id,
        deploymentSlug: fixtureName('public'),
        expiresAt,
        now,
      })
    ).resolves.toBe(false);

    const partialCreation = await insertEphemeralDeployment({
      next_cleanup_at: minutesAfter(now, 10),
    });
    await expect(
      markEphemeralDeploymentForCleanup(db, {
        deploymentId: partialCreation.id,
        internalWorkerName: partialCreation.internal_worker_name,
        now,
      })
    ).resolves.toBe(true);
    expect(await selectEphemeralDeployment(partialCreation.id)).toEqual(
      expect.objectContaining({ status: 'cleanup_retry' })
    );
    expect(
      new Date((await selectEphemeralDeployment(partialCreation.id)).next_cleanup_at).toISOString()
    ).toBe(now);
  });

  it('recreates a nullable-owner cleanup tombstone with the stable Worker name after the lifecycle row is deleted', async () => {
    const deletedLifecycle = await insertEphemeralDeployment({
      owned_by_user_id: (await insertOwner()).id,
      next_cleanup_at: minutesAfter(now, 10),
    });

    await db.delete(deployments_ephemeral).where(eq(deployments_ephemeral.id, deletedLifecycle.id));

    await expect(
      markEphemeralDeploymentForCleanup(db, {
        deploymentId: deletedLifecycle.id,
        internalWorkerName: deletedLifecycle.internal_worker_name,
        now,
      })
    ).resolves.toBe(true);
    const tombstone = await selectEphemeralDeployment(deletedLifecycle.id);
    expect(tombstone).toEqual(
      expect.objectContaining({
        owned_by_user_id: null,
        internal_worker_name: deletedLifecycle.internal_worker_name,
        status: 'cleanup_retry',
        cleanup_claim_token: null,
        cleanup_claimed_until: null,
      })
    );
    expect(new Date(tombstone.next_cleanup_at).toISOString()).toBe(now);
  });

  it('preserves claim ownership when immediate rollback marking and unclaimed completion race claimed cleanup', async () => {
    const claimToken = randomUUID();
    const claimedUntil = minutesAfter(now, 20);
    const claimed = await insertEphemeralDeployment({
      status: 'cleanup_retry',
      cleanup_claim_token: claimToken,
      cleanup_claimed_until: claimedUntil,
    });

    await expect(
      markEphemeralDeploymentForCleanup(db, {
        deploymentId: claimed.id,
        internalWorkerName: claimed.internal_worker_name,
        now,
      })
    ).resolves.toBe(false);
    await expect(
      completeUnclaimedEphemeralDeploymentCleanup(db, {
        internalWorkerName: claimed.internal_worker_name,
      })
    ).resolves.toBe(false);
    const preservedClaim = await selectEphemeralDeployment(claimed.id);
    expect(preservedClaim).toEqual(
      expect.objectContaining({
        status: 'cleanup_retry',
        cleanup_claim_token: claimToken,
      })
    );
    expect(new Date(preservedClaim.cleanup_claimed_until ?? '').toISOString()).toBe(claimedUntil);
  });

  it('completes unclaimed cleanup for a recreated lifecycle tombstone by Worker name', async () => {
    const deletedLifecycle = await insertEphemeralDeployment();

    await db.delete(deployments_ephemeral).where(eq(deployments_ephemeral.id, deletedLifecycle.id));
    await expect(
      markEphemeralDeploymentForCleanup(db, {
        deploymentId: deletedLifecycle.id,
        internalWorkerName: deletedLifecycle.internal_worker_name,
        now,
      })
    ).resolves.toBe(true);

    await expect(
      completeUnclaimedEphemeralDeploymentCleanup(db, {
        internalWorkerName: deletedLifecycle.internal_worker_name,
      })
    ).resolves.toBe(true);
    await expect(
      db
        .select()
        .from(deployments_ephemeral)
        .where(
          eq(deployments_ephemeral.internal_worker_name, deletedLifecycle.internal_worker_name)
        )
    ).resolves.toEqual([]);
  });

  it('claims at most 25 due deployments and gives overlapping sweeps disjoint work', async () => {
    await db.insert(deployments_ephemeral).values(
      Array.from({ length: 30 }, () => ({
        source_type: 'html' as const,
        internal_worker_name: fixtureName('qdpl'),
        status: 'cleanup_retry' as const,
        next_cleanup_at: now,
      }))
    );

    const firstClaimToken = randomUUID();
    const secondClaimToken = randomUUID();
    const [firstSweep, secondSweep] = await Promise.all([
      claimDueEphemeralDeployments(db, {
        claimToken: firstClaimToken,
        now,
        claimedUntil: minutesAfter(now, 20),
        limit: 25,
      }),
      claimDueEphemeralDeployments(db, {
        claimToken: secondClaimToken,
        now,
        claimedUntil: minutesAfter(now, 20),
        limit: 25,
      }),
    ]);

    expect(firstSweep.length).toBeLessThanOrEqual(25);
    expect(secondSweep.length).toBeLessThanOrEqual(25);
    expect(firstSweep).toHaveLength(25);
    expect(secondSweep).toHaveLength(5);
    expect(
      new Set([...firstSweep, ...secondSweep].map(deployment => deployment.id))
    ).toHaveProperty('size', 30);
  });

  it('recovers stale claims while leaving live claims untouched', async () => {
    const staleClaim = await insertEphemeralDeployment({
      status: 'cleanup_retry',
      cleanup_claim_token: randomUUID(),
      cleanup_claimed_until: minutesAfter(now, -1),
    });
    const liveClaim = await insertEphemeralDeployment({
      status: 'cleanup_retry',
      cleanup_claim_token: randomUUID(),
      cleanup_claimed_until: minutesAfter(now, 1),
    });
    const replacementToken = randomUUID();

    const claimed = await claimDueEphemeralDeployments(db, {
      claimToken: replacementToken,
      now,
      claimedUntil: minutesAfter(now, 20),
      limit: 25,
    });

    expect(claimed.map(deployment => deployment.id)).toEqual([staleClaim.id]);
    expect(await selectEphemeralDeployment(staleClaim.id)).toEqual(
      expect.objectContaining({ cleanup_claim_token: replacementToken })
    );
    expect(await selectEphemeralDeployment(liveClaim.id)).toEqual(
      expect.objectContaining({ cleanup_claim_token: liveClaim.cleanup_claim_token })
    );
  });

  it('completes and retries claimed cleanup only for a matching token with caller-scheduled five-minute retry', async () => {
    const claimToken = randomUUID();
    const wrongClaimToken = randomUUID();
    const claimedUntil = minutesAfter(now, 20);
    const retryAt = minutesAfter(now, 5);
    const retried = await insertEphemeralDeployment({
      status: 'cleanup_retry',
      cleanup_claim_token: claimToken,
      cleanup_claimed_until: claimedUntil,
    });

    await expect(
      retryClaimedEphemeralDeploymentCleanup(db, {
        deploymentId: retried.id,
        claimToken: wrongClaimToken,
        nextCleanupAt: retryAt,
      })
    ).resolves.toBe(false);
    const unchangedClaim = await selectEphemeralDeployment(retried.id);
    expect(unchangedClaim).toEqual(expect.objectContaining({ cleanup_claim_token: claimToken }));
    expect(new Date(unchangedClaim.cleanup_claimed_until ?? '').toISOString()).toBe(claimedUntil);

    await expect(
      retryClaimedEphemeralDeploymentCleanup(db, {
        deploymentId: retried.id,
        claimToken,
        nextCleanupAt: retryAt,
      })
    ).resolves.toBe(true);
    const retryRow = await selectEphemeralDeployment(retried.id);
    expect(retryRow).toEqual(
      expect.objectContaining({
        status: 'cleanup_retry',
        cleanup_claim_token: null,
        cleanup_claimed_until: null,
      })
    );
    expect(new Date(retryRow.next_cleanup_at).toISOString()).toBe(retryAt);

    const completed = await insertEphemeralDeployment({
      status: 'cleanup_retry',
      cleanup_claim_token: claimToken,
      cleanup_claimed_until: claimedUntil,
    });
    await expect(
      completeClaimedEphemeralDeploymentCleanup(db, {
        deploymentId: completed.id,
        claimToken: wrongClaimToken,
      })
    ).resolves.toBe(false);
    await expect(
      completeClaimedEphemeralDeploymentCleanup(db, {
        deploymentId: completed.id,
        claimToken,
      })
    ).resolves.toBe(true);
    await expect(
      db.select().from(deployments_ephemeral).where(eq(deployments_ephemeral.id, completed.id))
    ).resolves.toEqual([]);
  });
});

describe('builder stored slug Postgres lookup', () => {
  it('finds persistent and ephemeral deployment slugs and internal worker names', async () => {
    const owner = await insertOwner();
    const persistentSlug = fixtureName('persistent-public');
    const persistentWorker = fixtureName('persistent-worker');
    const ephemeralSlug = fixtureName('ephemeral-public');
    const ephemeralWorker = fixtureName('ephemeral-worker');

    await db.insert(deployments).values({
      created_by_user_id: owner.id,
      owned_by_user_id: owner.id,
      deployment_slug: persistentSlug,
      internal_worker_name: persistentWorker,
      repository_source: 'https://example.com/repository.git',
      branch: 'main',
      deployment_url: `https://${persistentSlug}.example.com`,
      last_build_id: randomUUID(),
    });
    await insertEphemeralDeployment({
      owned_by_user_id: owner.id,
      internal_worker_name: ephemeralWorker,
      deployment_slug: ephemeralSlug,
      status: 'active',
      expires_at: minutesAfter(now, 60),
      next_cleanup_at: minutesAfter(now, 60),
    });

    await expect(isStoredDeploymentSlug(db, persistentSlug)).resolves.toBe(true);
    await expect(isStoredDeploymentSlug(db, persistentWorker)).resolves.toBe(true);
    await expect(isStoredDeploymentSlug(db, ephemeralSlug)).resolves.toBe(true);
    await expect(isStoredDeploymentSlug(db, ephemeralWorker)).resolves.toBe(true);
    await expect(isStoredDeploymentSlug(db, fixtureName('unused'))).resolves.toBe(false);
  });
});
