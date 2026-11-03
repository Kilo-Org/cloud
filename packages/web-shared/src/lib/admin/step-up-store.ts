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

async function countPasskeys(userId: string, fromDb: typeof db): Promise<number> {
  const [row] = await fromDb
    .select({ count: sql<number>`count(*)::int` })
    .from(passkey_credentials)
    .where(eq(passkey_credentials.kilo_user_id, userId));
  return row?.count ?? 0;
}

/** Read the live proof state for one browser session and action class. */
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

  const [liveProof] = await fromDb
    .select()
    .from(session_step_up_proofs)
    .where(and(...proofFilters))
    .orderBy(desc(session_step_up_proofs.verified_at))
    .limit(1);

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
