import 'server-only';

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { CURRENT_UGC_TERMS_VERSION } from '@kilocode/app-shared/moderation';
import { PR_OPERATION_SETTLED_EVENT } from '@kilocode/app-shared/analytics';
import {
  BitbucketMergeEvidenceSchema,
  ReviewEffectResultSchema,
  providerReviewIntentFingerprint,
  serializeReviewWriteRequest,
  type BitbucketMergeEvidence,
  type ProviderReference,
  type ReviewAction,
  type ReviewIntent,
} from '@kilocode/app-shared/provider-review';
import {
  admitOperation,
  markReconcilePending,
  recordOperationAcceptance,
  recordOperationProgress,
  settleOperation,
  MAX_CANONICAL_RESULT_BYTES,
  type OutboxEventInput,
} from '@kilocode/db/operation-ledger';
import { operation_ledgers, user_terms_acceptances } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';

export type ReviewEffectResult = z.infer<typeof ReviewEffectResultSchema>;
export type PersistBitbucketMergeEvidence = (evidence: BitbucketMergeEvidence) => Promise<void>;
export type ReviewOperationRequest = {
  userId: string;
  distinctId: string;
  operationKey: string;
  intent: ReviewIntent;
  effect?: { id: string; action: Exclude<ReviewAction, 'read'> };
};
export function rejectedReviewEffect(
  code: string,
  retry: 'same-key' | 'never' = 'never'
): ReviewEffectResult {
  return { status: 'rejected', code, explanation: code, retry, reconciliation: 'not-needed' };
}
export function unresolvedReviewEffect(
  reason: string,
  reference: ProviderReference | null = null
): ReviewEffectResult {
  return {
    status: 'unresolved',
    reference,
    reason,
    retry: 'reconcile',
    reconciliation: 'required',
  };
}
export function confirmedReviewEffect(reference: ProviderReference | null): ReviewEffectResult {
  return { status: 'confirmed', reference, retry: 'never', reconciliation: 'complete' };
}

export async function assertReviewTermsAccepted(userId: string): Promise<void> {
  const [accepted] = await db
    .select({ id: user_terms_acceptances.id })
    .from(user_terms_acceptances)
    .where(
      and(
        eq(user_terms_acceptances.kilo_user_id, userId),
        eq(user_terms_acceptances.terms_version, CURRENT_UGC_TERMS_VERSION)
      )
    )
    .limit(1);
  if (!accepted) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'terms_required' });
}

// The parent UUID and stable effect ID survive partial publication and client restarts.
export function reviewEffectOperationKey(operationKey: string, effectId?: string): string {
  const key = z.uuid().parse(operationKey);
  return effectId === undefined ? key : uuidv5(z.string().min(1).max(512).parse(effectId), key);
}

export async function runReviewOperation(
  request: ReviewOperationRequest,
  handlers: {
    // Omission selects status-only reconciliation, never a new provider write.
    execute?: (persistMergeEvidence?: PersistBitbucketMergeEvidence) => Promise<ReviewEffectResult>;
    reconcile: (
      stored: ReviewEffectResult | null,
      mergeEvidence?: BitbucketMergeEvidence | null
    ) => Promise<ReviewEffectResult>;
    // Aggregate rows bind batches; only their individual provider effects emit outcomes.
    aggregate?: true;
  }
): Promise<ReviewEffectResult> {
  const { intent, userId } = request;
  if (
    intent.accountId !== userId ||
    !userId ||
    intent.review.repository.provider === 'github' ||
    intent.review.authorization.kind !== 'ownerIntegration'
  )
    return rejectedReviewEffect('operation_identity_mismatch');
  const owner = intent.review.authorization.owner;
  if (owner.type === 'user' && owner.id !== userId)
    return rejectedReviewEffect('operation_identity_mismatch');
  serializeReviewWriteRequest(intent);
  const operationKey = reviewEffectOperationKey(request.operationKey, request.effect?.id);
  const action = request.effect?.action ?? intent.input.action;
  const orgId = owner.type === 'org' ? owner.id : null;
  const resourceKey = `provider-review-operation:v1:${createHash('sha256')
    .update(
      JSON.stringify([
        providerReviewIntentFingerprint(intent),
        request.effect?.id ?? null,
        request.effect?.action ?? null,
      ])
    )
    .digest('hex')}`;
  if (
    handlers.execute &&
    ['comment', 'inlineComment', 'reply', 'submitReview'].includes(intent.input.action)
  )
    await assertReviewTermsAccepted(userId);
  if (!handlers.execute) {
    const [existing] = await db
      .select({ id: operation_ledgers.id })
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.kilo_user_id, userId),
          eq(operation_ledgers.domain, 'pr'),
          eq(operation_ledgers.operation_key, operationKey)
        )
      )
      .limit(1);
    if (!existing) return rejectedReviewEffect('operation_not_admitted', 'same-key');
  }
  let admission: Awaited<ReturnType<typeof admitOperation>>;
  try {
    admission = await admitOperation(db, {
      userId,
      orgId,
      domain: 'pr',
      intent: action,
      operationKey,
      resourceKey,
      taxonomy: 'reconcile-first',
      leaseSeconds: 60,
    });
  } catch {
    return rejectedReviewEffect('ledger_unavailable', 'same-key');
  }
  const { row } = admission;
  if (
    row.kilo_user_id !== userId ||
    row.organization_id !== orgId ||
    row.domain !== 'pr' ||
    row.operation_key !== operationKey ||
    row.intent !== action ||
    row.resource_key !== resourceKey
  )
    return rejectedReviewEffect('operation_key_reuse_mismatch');
  const parsed = ReviewEffectResultSchema.safeParse(row.canonical_result?.result);
  const stored = parsed.success ? parsed.data : null;
  const needsMergeEvidence =
    intent.review.repository.provider === 'bitbucket' && action === 'merge' && !handlers.aggregate;
  const parsedEvidence = BitbucketMergeEvidenceSchema.safeParse(
    row.canonical_result?.bitbucketMergeEvidence
  );
  let mergeEvidence: BitbucketMergeEvidence | null =
    needsMergeEvidence && parsedEvidence.success ? parsedEvidence.data : null;
  // Old Bitbucket rows lack preflight identity. Keep them unresolved until their retention expires;
  // neither a saved result nor matching postflight heads can reconstruct the intended branches.
  if (
    needsMergeEvidence &&
    !mergeEvidence &&
    (stored?.status === 'confirmed' || stored?.status === 'accepted')
  )
    return unresolvedReviewEffect('merge_identity_unavailable', stored.reference);
  if (admission.admission === 'duplicate_settled')
    return stored &&
      (stored.status === 'confirmed' || (stored.status === 'rejected' && stored.retry === 'never'))
      ? stored
      : unresolvedReviewEffect('stored_result_unavailable');
  if (
    admission.admission === 'duplicate_in_flight' ||
    admission.admission === 'duplicate_reconcile_in_progress'
  )
    return stored?.status === 'accepted' ? stored : unresolvedReviewEffect('operation_in_progress');

  const startedAt = Date.now();
  function event(outcome: 'completed' | 'failed' | 'ambiguous'): OutboxEventInput | null {
    if (handlers.aggregate) return null;
    // Keep the existing analytics catalog. Reversible actions have no corresponding legacy event.
    const analyticsIntent =
      action === 'merge'
        ? 'merge'
        : action === 'reply'
          ? 'reply_comment'
          : action === 'comment' || action === 'inlineComment'
            ? 'create_review_comment'
            : action === 'submitReview' || action === 'approve' || action === 'requestChanges'
              ? 'submit_review'
              : null;
    return analyticsIntent === null
      ? null
      : {
          eventName: PR_OPERATION_SETTLED_EVENT,
          distinctId: request.distinctId,
          properties: {
            source: 'web',
            surface: 'pr',
            phase: 'terminal',
            intent: analyticsIntent,
            outcome,
            duration_ms: Math.max(0, Date.now() - startedAt),
            ...(admission.admission === 'admitted'
              ? {}
              : {
                  reconcile_result:
                    outcome === 'completed'
                      ? 'confirmed_completed'
                      : outcome === 'failed'
                        ? 'confirmed_absent'
                        : 'unresolved',
                }),
          },
        };
  }
  let result: ReviewEffectResult;
  try {
    // A persisted confirmation is provider evidence even if the later settlement failed.
    // Only an explicitly persisted, pre-dispatch rejection permits a same-key write retry.
    if (stored?.status === 'confirmed') result = stored;
    else if (
      handlers.execute &&
      (admission.admission === 'admitted' ||
        (stored?.status === 'rejected' && stored.retry === 'same-key'))
    ) {
      // Retire a previous safe-retry receipt before dispatch. A lost response must not leave it replayable.
      const dispatchResult = unresolvedReviewEffect('dispatching');
      const dispatching = await recordOperationProgress(db, row.id, {
        result: dispatchResult,
        ...(needsMergeEvidence ? { bitbucketMergeEvidence: null } : {}),
      });
      if (!dispatching) throw new Error('Dispatch admission did not persist');
      mergeEvidence = null;
      result = await handlers.execute(async evidence => {
        if (!needsMergeEvidence) throw new Error('Unexpected merge evidence');
        // Only the server handler supplies evidence, after its authorized preflight and before dispatch.
        const canonicalResult = {
          result: dispatchResult,
          bitbucketMergeEvidence: BitbucketMergeEvidenceSchema.parse(evidence),
        };
        if (
          Buffer.byteLength(JSON.stringify(canonicalResult), 'utf8') >= MAX_CANONICAL_RESULT_BYTES
        )
          throw new Error('Merge evidence exceeds the ledger limit');
        if (!(await recordOperationProgress(db, row.id, canonicalResult)))
          throw new Error('Merge evidence did not persist');
        mergeEvidence = canonicalResult.bitbucketMergeEvidence;
      });
    } else
      result =
        stored?.status === 'rejected' && stored.retry === 'same-key'
          ? stored
          : await handlers.reconcile(stored, mergeEvidence);
    result = ReviewEffectResultSchema.parse(result);
    if (
      Buffer.byteLength(
        JSON.stringify({
          result,
          ...(mergeEvidence ? { bitbucketMergeEvidence: mergeEvidence } : {}),
        }),
        'utf8'
      ) >= MAX_CANONICAL_RESULT_BYTES
    )
      result = unresolvedReviewEffect('result_too_large');
  } catch {
    result = unresolvedReviewEffect('provider_outcome_unknown');
  }
  try {
    if (
      result.status === 'confirmed' ||
      result.status === 'accepted' ||
      // An unavailable status read cannot erase durable provider acceptance.
      (result.status === 'unresolved' && result.reference && stored?.status !== 'accepted')
    ) {
      const accepted = await recordOperationAcceptance(db, {
        rowId: row.id,
        providerRef: result.reference ? JSON.stringify(result.reference) : null,
        canonicalResult: { result },
      });
      if (!accepted) throw new Error('Acceptance did not persist');
    }
    if (
      result.status === 'confirmed' ||
      (result.status === 'rejected' && result.retry === 'never')
    ) {
      const settled = await settleOperation(db, {
        rowId: row.id,
        status: result.status === 'confirmed' ? 'completed' : 'failed',
        outcomeCode: result.status === 'confirmed' ? 'ok' : result.code,
        canonicalResult: { result },
        outboxEvent: event(result.status === 'confirmed' ? 'completed' : 'failed'),
      });
      const final = ReviewEffectResultSchema.safeParse(settled.row?.canonical_result?.result);
      return final.success ? final.data : unresolvedReviewEffect('ledger_settlement_unknown');
    }
    if (result.status === 'rejected' && !(await recordOperationProgress(db, row.id, { result })))
      throw new Error('Pre-dispatch result did not persist');
    const pending = await markReconcilePending(db, {
      rowId: row.id,
      outboxEvent: result.status === 'unresolved' ? event('ambiguous') : null,
    });
    if (!pending) throw new Error('Reconciliation did not persist');
    return result;
  } catch {
    // Even when both persistence calls fail, a takeover without evidence only reconciles.
    // Never convert a possibly committed effect into a failed row or a write retry.
    try {
      await markReconcilePending(db, { rowId: row.id });
    } catch {
      /* The admitted row still forbids replay. */
    }
    return unresolvedReviewEffect(
      'ledger_persistence_failed',
      'reference' in result ? result.reference : null
    );
  }
}
