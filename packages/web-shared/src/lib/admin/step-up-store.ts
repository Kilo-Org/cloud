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
  PrivilegedTarget,
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
  /** Required for a single-use sensitive operation proof. */
  actionBinding?: StepUpActionBinding | null;
  now?: Date;
};

export type StepUpEvaluation = {
  state: AdminStepUpState;
  proof: SessionStepUpProof | null;
  passkeyCount: number;
};

export type StepUpActionBinding = {
  inventoryId: string | null;
  target: PrivilegedTarget;
};

const ACTION_BINDING_VERSION = 'v1';

export function hashWebSessionId(webSessionId: string): string {
  return createHash('sha256').update(webSessionId).digest('hex');
}

export function hashStepUpActionBinding(binding: StepUpActionBinding): string {
  const target = binding.target;
  return createHash('sha256')
    .update(
      [ACTION_BINDING_VERSION, binding.inventoryId ?? '', target.kind, target.id ?? ''].join('|')
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
 * Evaluate the strongest proof available for one session and action class.
 * This is a read only: it never consumes an operation proof, so an observe-mode
 * guard cannot change the outcome of a later enforced check.
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
  const actionBindingHash =
    policy.purpose === 'operation' && params.actionBinding
      ? hashStepUpActionBinding(params.actionBinding)
      : null;

  if (policy.purpose === 'operation' && actionBindingHash === null) {
    // A sensitive action needs an operation-bound proof, and this call has no
    // binding to match. Report enrollment so the client knows whether a proof
    // is even possible.
    const passkeyCount = await countPasskeys(params.userId, fromDb);
    return {
      state: passkeyCount === 0 ? { status: 'not_enrolled' } : { status: 'required' },
      proof: null,
      passkeyCount,
    };
  }

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
    ...(actionBindingHash === null
      ? []
      : [eq(session_step_up_proofs.action_binding_hash, actionBindingHash)]),
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
        proofId: liveProof.id,
        method: 'webauthn_uv',
        verifiedAt: liveProof.verified_at,
        expiresAt: liveProof.expires_at,
      },
      proof: liveProof,
      passkeyCount,
    };
  }

  const [latestProof] = await fromDb
    .select({ verified_at: session_step_up_proofs.verified_at })
    .from(session_step_up_proofs)
    .where(
      and(
        eq(session_step_up_proofs.kilo_user_id, params.userId),
        eq(session_step_up_proofs.session_id_hash, sessionIdHash),
        eq(session_step_up_proofs.purpose, policy.purpose),
        ...(actionBindingHash === null
          ? []
          : [eq(session_step_up_proofs.action_binding_hash, actionBindingHash)])
      )
    )
    .orderBy(desc(session_step_up_proofs.verified_at))
    .limit(1);

  if (latestProof) {
    return {
      state: { status: 'expired', verifiedAt: latestProof.verified_at },
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

/** Revoke the live proofs bound to one browser session ("Lock now"). */
export async function revokeCurrentSessionStepUpProofs(
  userId: string,
  webSessionId: string,
  reason: string,
  now: Date = new Date()
): Promise<number> {
  const revoked = await db
    .update(session_step_up_proofs)
    .set({ revoked_at: now.toISOString(), revoked_reason: reason })
    .where(
      and(
        eq(session_step_up_proofs.kilo_user_id, userId),
        eq(session_step_up_proofs.session_id_hash, hashWebSessionId(webSessionId)),
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
