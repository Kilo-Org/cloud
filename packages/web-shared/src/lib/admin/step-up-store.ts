import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, gt, isNull, lt, sql } from 'drizzle-orm';
import {
  passkey_credentials,
  session_step_up_challenges,
  session_step_up_proofs,
  type SessionStepUpProof,
} from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import type {
  AdminStepUpState,
  PrivilegedActionClass,
  StepUpOperation,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  STEP_UP_RETENTION_AFTER_EXPIRY_MS,
  stepUpPolicyFor,
} from '@kilocode/web-shared/lib/admin/step-up-policy';

/**
 * Read/write helpers for session-bound MFA step-up.
 *
 * Every write and guard proof read in this module must use the primary `db`:
 * a proof minted moments ago has to authorize the very next request, and a
 * revocation has to take effect immediately. Callers pass an existing primary
 * transaction when one is already open.
 */

export type StepUpEvaluationParams = {
  userId: string;
  webSessionId?: string | null;
  actionClass: PrivilegedActionClass;
  /** Required when the class has the per-operation policy. */
  operation?: StepUpOperation;
  now?: Date;
};

export type StepUpEvaluation = {
  state: AdminStepUpState;
  proof: SessionStepUpProof | null;
  passkeyCount: number;
};

export function hashWebSessionId(webSessionId: string): string {
  return createHash('sha256').update(webSessionId).digest('hex');
}

/**
 * The composite lookup key of a per-operation proof. The action class, the
 * operation identity and the target are hashed together, so a proof minted for
 * one operation matches no other operation even when both share a class.
 */
export function stepUpBindingHash(
  actionClass: PrivilegedActionClass,
  operation: StepUpOperation
): string {
  return createHash('sha256')
    .update(
      [actionClass, operation.id, operation.targetKind, operation.targetId ?? ''].join('\u0000')
    )
    .digest('hex');
}

async function countPasskeys(userId: string, fromDb: typeof db): Promise<number> {
  const [row] = await fromDb
    .select({ count: sql<number>`count(*)::int` })
    .from(passkey_credentials)
    .where(eq(passkey_credentials.kilo_user_id, userId));
  return row?.count ?? 0;
}

/**
 * Read the live proof state for one browser session and action class.
 *
 * A session class reads the reusable session proof. An operation class reads
 * the proof bound to exactly this operation and target, and claims it in the
 * same statement that reads it: `consumed_at` is set only when it is still
 * null, so one proof authorizes one request and a concurrent caller loses.
 */
export async function evaluateStepUp(
  params: StepUpEvaluationParams,
  fromDb: typeof db = db
): Promise<StepUpEvaluation> {
  if (!params.webSessionId) {
    return { state: { status: 'session_unbound' }, proof: null, passkeyCount: 0 };
  }

  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const sessionIdHash = hashWebSessionId(params.webSessionId);
  const policy = stepUpPolicyFor(params.actionClass);
  const passkeyCount = await countPasskeys(params.userId, fromDb);

  const bindingHash =
    policy.purpose === 'operation'
      ? stepUpBindingHash(params.actionClass, requireOperation(params))
      : null;

  const proofFilters = [
    eq(session_step_up_proofs.kilo_user_id, params.userId),
    eq(session_step_up_proofs.session_id_hash, sessionIdHash),
    eq(session_step_up_proofs.purpose, policy.purpose),
    isNull(session_step_up_proofs.revoked_at),
    gt(session_step_up_proofs.expires_at, nowIso),
    gte(
      session_step_up_proofs.verified_at,
      new Date(now.getTime() - policy.maxAgeMs).toISOString()
    ),
    ...(bindingHash ? [eq(session_step_up_proofs.action_binding_hash, bindingHash)] : []),
  ];

  // One operation proof authorizes one request: claim the newest live proof for
  // this binding by setting `consumed_at` in the same statement, and let
  // PostgreSQL pick the single row. A concurrent caller either wins another
  // live proof of the same binding or finds none.
  const claimOneOfBinding = sql`${session_step_up_proofs.id} IN (
    SELECT "id" FROM "session_step_up_proofs"
    WHERE "kilo_user_id" = ${params.userId}
      AND "session_id_hash" = ${sessionIdHash}
      AND "purpose" = ${policy.purpose}
      AND "action_binding_hash" = ${bindingHash}
      AND "revoked_at" IS NULL
      AND "consumed_at" IS NULL
      AND "expires_at" > ${nowIso}
      AND "verified_at" >= ${new Date(now.getTime() - policy.maxAgeMs).toISOString()}
    ORDER BY "verified_at" DESC
    LIMIT 1
  )`;

  const liveProof =
    bindingHash === null
      ? (
          await fromDb
            .select()
            .from(session_step_up_proofs)
            .where(and(...proofFilters, isNull(session_step_up_proofs.consumed_at)))
            .orderBy(desc(session_step_up_proofs.verified_at))
            .limit(1)
        )[0]
      : (
          await fromDb
            .update(session_step_up_proofs)
            .set({ consumed_at: nowIso })
            .where(
              and(...proofFilters, isNull(session_step_up_proofs.consumed_at), claimOneOfBinding)
            )
            .returning()
        )[0];

  if (liveProof) {
    return {
      state: {
        status: 'fresh',
        method: 'webauthn_uv',
        verifiedAt: new Date(liveProof.verified_at).toISOString(),
        expiresAt: new Date(liveProof.expires_at).toISOString(),
      },
      proof: liveProof,
      passkeyCount,
    };
  }

  const [latestProof] = await fromDb
    .select({
      verified_at: session_step_up_proofs.verified_at,
      revoked_at: session_step_up_proofs.revoked_at,
      consumed_at: session_step_up_proofs.consumed_at,
    })
    .from(session_step_up_proofs)
    .where(
      and(
        eq(session_step_up_proofs.kilo_user_id, params.userId),
        eq(session_step_up_proofs.session_id_hash, sessionIdHash),
        eq(session_step_up_proofs.purpose, policy.purpose),
        ...(bindingHash ? [eq(session_step_up_proofs.action_binding_hash, bindingHash)] : [])
      )
    )
    .orderBy(desc(session_step_up_proofs.verified_at))
    .limit(1);

  // A proof already spent on its operation cannot explain a refusal as
  // staleness, so it reports the same state as a missing one.
  if (latestProof && !latestProof.consumed_at) {
    return {
      state: latestProof.revoked_at
        ? {
            status: 'revoked',
            verifiedAt: new Date(latestProof.verified_at).toISOString(),
          }
        : {
            status: 'expired',
            verifiedAt: new Date(latestProof.verified_at).toISOString(),
          },
      proof: null,
      passkeyCount,
    };
  }

  return {
    state: passkeyCount === 0 ? { status: 'not_enrolled' } : { status: 'required' },
    proof: null,
    passkeyCount,
  };
}

function requireOperation(params: StepUpEvaluationParams): StepUpOperation {
  if (!params.operation) {
    throw new Error('step-up operation binding required');
  }
  return params.operation;
}

/**
 * Revoke every live proof for a user. Used when the session that could use them
 * is invalidated: sign-out, role or permission change, block, and deletion
 * intake. Safe to call inside an existing transaction.
 */
export async function revokeStepUpProofs(
  userId: string,
  reason: string,
  fromDb: typeof db | DrizzleTransaction = db,
  now: Date = new Date()
): Promise<number> {
  const revoked = await fromDb
    .update(session_step_up_proofs)
    .set({ revoked_at: now.toISOString(), revoked_reason: reason })
    .where(
      and(
        eq(session_step_up_proofs.kilo_user_id, userId),
        isNull(session_step_up_proofs.revoked_at)
      )
    )
    .returning({ id: session_step_up_proofs.id });

  return revoked.length;
}

/** Remove all step-up rows for a user as part of hard deletion/anonymization. */
export async function deleteStepUpRowsForUser(
  tx: DrizzleTransaction,
  userId: string
): Promise<void> {
  await tx.delete(session_step_up_proofs).where(eq(session_step_up_proofs.kilo_user_id, userId));
  await tx
    .delete(session_step_up_challenges)
    .where(eq(session_step_up_challenges.kilo_user_id, userId));
}

/**
 * Delete challenges and proofs one day past expiry. A row past expiry can no
 * longer authorize anything; the extra day keeps a recent refusal explainable
 * while bounding the table.
 */
export async function cleanupExpiredSessionStepUpRows(
  now: Date = new Date()
): Promise<{ challenges: number; proofs: number }> {
  const cutoff = new Date(now.getTime() - STEP_UP_RETENTION_AFTER_EXPIRY_MS).toISOString();

  const challenges = await db
    .delete(session_step_up_challenges)
    .where(lt(session_step_up_challenges.expires_at, cutoff))
    .returning({ id: session_step_up_challenges.id });

  const proofs = await db
    .delete(session_step_up_proofs)
    .where(lt(session_step_up_proofs.expires_at, cutoff))
    .returning({ id: session_step_up_proofs.id });

  return { challenges: challenges.length, proofs: proofs.length };
}
