import type { WorkerDb } from '@kilocode/db/client';
import { deployments_ephemeral, kilocode_users } from '@kilocode/db/schema';
import { isSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

export type ClaimedEphemeralDeployment = {
  id: string;
  internalWorkerName: string;
  deploymentSlug: string | null;
};

export type CreatePendingEphemeralDeploymentResult =
  | {
      created: true;
      deployment: {
        id: string;
        internalWorkerName: string;
      };
    }
  | {
      created: false;
      reason: 'owner_unavailable';
    };

export async function createPendingEphemeralDeployment(
  db: WorkerDb,
  params: {
    ownedByUserId: string;
    internalWorkerName: string;
    pendingCleanupAt: string;
  }
): Promise<CreatePendingEphemeralDeploymentResult> {
  return db.transaction(async tx => {
    const [owner] = await tx
      .select({ blockedReason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, params.ownedByUserId))
      .for('update')
      .limit(1);

    if (!owner || isSoftDeletedBlockedReason(owner.blockedReason)) {
      return { created: false, reason: 'owner_unavailable' };
    }

    const [deployment] = await tx
      .insert(deployments_ephemeral)
      .values({
        owned_by_user_id: params.ownedByUserId,
        source_type: 'html',
        internal_worker_name: params.internalWorkerName,
        status: 'pending',
        next_cleanup_at: params.pendingCleanupAt,
      })
      .returning({
        id: deployments_ephemeral.id,
        internalWorkerName: deployments_ephemeral.internal_worker_name,
      });

    if (!deployment) {
      throw new Error('Failed to insert pending ephemeral deployment');
    }

    return { created: true, deployment };
  });
}

export async function activateEphemeralDeployment(
  db: WorkerDb,
  params: {
    deploymentId: string;
    deploymentSlug: string;
    expiresAt: string;
    now: string;
  }
): Promise<boolean> {
  const activated = await db
    .update(deployments_ephemeral)
    .set({
      deployment_slug: params.deploymentSlug,
      status: 'active',
      expires_at: params.expiresAt,
      next_cleanup_at: params.expiresAt,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(deployments_ephemeral.id, params.deploymentId),
        eq(deployments_ephemeral.status, 'pending'),
        isNull(deployments_ephemeral.cleanup_claim_token),
        isNull(deployments_ephemeral.cleanup_claimed_until),
        gt(deployments_ephemeral.next_cleanup_at, params.now)
      )
    )
    .returning({ id: deployments_ephemeral.id });

  return activated.length === 1;
}

export async function markEphemeralDeploymentForCleanup(
  db: WorkerDb,
  params: { deploymentId: string; internalWorkerName: string; now: string }
): Promise<boolean> {
  const marked = await db
    .insert(deployments_ephemeral)
    .values({
      id: params.deploymentId,
      source_type: 'html',
      internal_worker_name: params.internalWorkerName,
      status: 'cleanup_retry',
      next_cleanup_at: params.now,
    })
    .onConflictDoUpdate({
      target: deployments_ephemeral.internal_worker_name,
      set: {
        status: 'cleanup_retry',
        next_cleanup_at: params.now,
        updated_at: sql`now()`,
      },
      setWhere: and(
        isNull(deployments_ephemeral.cleanup_claim_token),
        isNull(deployments_ephemeral.cleanup_claimed_until)
      ),
    })
    .returning({ id: deployments_ephemeral.id });

  return marked.length === 1;
}

export async function claimDueEphemeralDeployments(
  db: WorkerDb,
  params: { claimToken: string; now: string; claimedUntil: string; limit: number }
): Promise<ClaimedEphemeralDeployment[]> {
  const claimed = await db.execute<{
    id: string;
    internal_worker_name: string;
    deployment_slug: string | null;
  }>(sql`
    UPDATE ${deployments_ephemeral}
    SET
      ${sql.identifier(deployments_ephemeral.cleanup_claim_token.name)} = ${params.claimToken}::uuid,
      ${sql.identifier(deployments_ephemeral.cleanup_claimed_until.name)} = ${params.claimedUntil}::timestamptz,
      ${sql.identifier(deployments_ephemeral.updated_at.name)} = now()
    WHERE ${deployments_ephemeral.id} IN (
      SELECT ${deployments_ephemeral.id}
      FROM ${deployments_ephemeral}
      WHERE ${deployments_ephemeral.next_cleanup_at} <= ${params.now}::timestamptz
        AND (
          ${deployments_ephemeral.cleanup_claimed_until} IS NULL
          OR ${deployments_ephemeral.cleanup_claimed_until} <= ${params.now}::timestamptz
        )
      ORDER BY ${deployments_ephemeral.next_cleanup_at} ASC, ${deployments_ephemeral.id} ASC
      LIMIT ${params.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      ${deployments_ephemeral.id},
      ${deployments_ephemeral.internal_worker_name},
      ${deployments_ephemeral.deployment_slug}
  `);

  return claimed.rows.map(row => ({
    id: row.id,
    internalWorkerName: row.internal_worker_name,
    deploymentSlug: row.deployment_slug,
  }));
}

export async function completeClaimedEphemeralDeploymentCleanup(
  db: WorkerDb,
  params: { deploymentId: string; claimToken: string }
): Promise<boolean> {
  const deleted = await db
    .delete(deployments_ephemeral)
    .where(
      and(
        eq(deployments_ephemeral.id, params.deploymentId),
        eq(deployments_ephemeral.cleanup_claim_token, params.claimToken)
      )
    )
    .returning({ id: deployments_ephemeral.id });

  return deleted.length === 1;
}

export async function retryClaimedEphemeralDeploymentCleanup(
  db: WorkerDb,
  params: { deploymentId: string; claimToken: string; nextCleanupAt: string }
): Promise<boolean> {
  const retried = await db
    .update(deployments_ephemeral)
    .set({
      status: 'cleanup_retry',
      next_cleanup_at: params.nextCleanupAt,
      cleanup_claim_token: null,
      cleanup_claimed_until: null,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(deployments_ephemeral.id, params.deploymentId),
        eq(deployments_ephemeral.cleanup_claim_token, params.claimToken)
      )
    )
    .returning({ id: deployments_ephemeral.id });

  return retried.length === 1;
}

export async function completeUnclaimedEphemeralDeploymentCleanup(
  db: WorkerDb,
  params: { internalWorkerName: string }
): Promise<boolean> {
  const deleted = await db
    .delete(deployments_ephemeral)
    .where(
      and(
        eq(deployments_ephemeral.internal_worker_name, params.internalWorkerName),
        isNull(deployments_ephemeral.cleanup_claim_token),
        isNull(deployments_ephemeral.cleanup_claimed_until)
      )
    )
    .returning({ id: deployments_ephemeral.id });

  return deleted.length === 1;
}
