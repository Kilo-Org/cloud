import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
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
} from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  STEP_UP_RETENTION_AFTER_EXPIRY_MS,
  isOperationStepUpClass,
  stepUpPolicyFor,
} from '@kilocode/web-shared/lib/admin/step-up-policy';
import {
  stepUpBindingValue,
  type StepUpOperation,
} from '@kilocode/web-shared/lib/admin/step-up-binding';

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
  /**
   * The exact operation an operation-class proof must name. Required for those
   * classes; a session-class evaluation ignores it.
   */
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
 * SHA-256 of the canonical operation text. Both the challenge and the proof
 * store this value; the operation itself is never stored.
 */
export function hashStepUpBinding(
  actionClass: PrivilegedActionClass,
  operation: StepUpOperation
): string {
  return createHash('sha256').update(stepUpBindingValue(actionClass, operation)).digest('hex');
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
 * A session-class proof is only read. An operation-class proof is claimed by
 * the same conditional `UPDATE` that reads it: `consumed_at` is set only when a
 * proof exists whose stored binding equals the binding of this request, so one
 * proof authorizes one operation and two concurrent requests cannot both win.
 * A session proof never satisfies an operation-class request, because the two
 * purposes never match.
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
  const operationClass = isOperationStepUpClass(params.actionClass);
  const passkeyCount = await countPasskeys(params.userId, fromDb);

  const proofFilters = [
    eq(session_step_up_proofs.kilo_user_id, params.userId),
    eq(session_step_up_proofs.session_id_hash, sessionIdHash),
    eq(session_step_up_proofs.purpose, policy.purpose),
    isNull(session_step_up_proofs.revoked_at),
    isNull(session_step_up_proofs.consumed_at),
    gt(session_step_up_proofs.expires_at, nowIso),
    gte(
      session_step_up_proofs.verified_at,
      new Date(now.getTime() - policy.maxAgeMs).toISOString()
    ),
  ];

  let liveProof: SessionStepUpProof | undefined;

  if (operationClass) {
    if (!params.operation) {
      // Fail closed: an operation class cannot be evaluated without the
      // operation the proof must name.
      throw new Error('An operation step-up proof requires the operation it authorizes');
    }
    const bindingHash = hashStepUpBinding(params.actionClass, params.operation);
    const claimedFilters = [
      ...proofFilters,
      eq(session_step_up_proofs.action_binding_hash, bindingHash),
    ];
    // The subquery picks the newest matching proof; the outer predicate is
    // re-checked against the locked row, so exactly one concurrent caller wins.
    [liveProof] = await fromDb
      .update(session_step_up_proofs)
      .set({ consumed_at: nowIso })
      .where(
        and(
          ...claimedFilters,
          inArray(
            session_step_up_proofs.id,
            fromDb
              .select({ id: session_step_up_proofs.id })
              .from(session_step_up_proofs)
              .where(and(...claimedFilters))
              .orderBy(desc(session_step_up_proofs.verified_at))
              .limit(1)
          )
        )
      )
      .returning();
  } else {
    [liveProof] = await fromDb
      .select()
      .from(session_step_up_proofs)
      .where(and(...proofFilters, isNull(session_step_up_proofs.action_binding_hash)))
      .orderBy(desc(session_step_up_proofs.verified_at))
      .limit(1);
  }

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
      // `mode:'string'` hands back the Postgres text form, so staleness is
      // compared by the database, not by JavaScript string order.
      stale: sql<boolean>`${session_step_up_proofs.expires_at} <= ${nowIso}`,
      consumed_at: session_step_up_proofs.consumed_at,
      revoked_at: session_step_up_proofs.revoked_at,
    })
    .from(session_step_up_proofs)
    .where(
      and(
        eq(session_step_up_proofs.kilo_user_id, params.userId),
        eq(session_step_up_proofs.session_id_hash, sessionIdHash),
        eq(session_step_up_proofs.purpose, policy.purpose)
      )
    )
    .orderBy(desc(session_step_up_proofs.verified_at))
    .limit(1);

  if (latestProof && operationClass) {
    // A spent proof, a fresh proof bound to a different operation, and a
    // missing binding all read as "verify for this operation now". Only an
    // expired one keeps the expiry explanation.
    const spent = latestProof.consumed_at !== null;
    return {
      state: latestProof.revoked_at
        ? { status: 'revoked', verifiedAt: new Date(latestProof.verified_at).toISOString() }
        : spent || !latestProof.stale
          ? { status: passkeyCount === 0 ? 'not_enrolled' : 'required' }
          : { status: 'expired', verifiedAt: new Date(latestProof.verified_at).toISOString() },
      proof: null,
      passkeyCount,
    };
  }

  if (latestProof) {
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
