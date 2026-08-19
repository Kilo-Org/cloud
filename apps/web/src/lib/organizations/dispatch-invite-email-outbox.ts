/**
 * Cron drainer for the invite-email outbox (P2-B-11).
 *
 * One pass: reclaim stale claims, claim due rows, send the invite email, mark
 * delivered/retry/fail. The row transitions live in
 * `@kilocode/db/external-side-effect-outbox`; this module orchestrates them and
 * sends via `sendOrganizationInviteEmail`. A `neverbounce_rejected` result is a
 * definitive, non-retryable failure; any other send error backs off and retries
 * up to `INVITE_EMAIL_OUTBOX_MAX_ATTEMPTS` before failing.
 */
import 'server-only';

import { db } from '@/lib/drizzle';
import { sendOrganizationInviteEmail } from '@/lib/email';
import { sentryLogger } from '@/lib/utils.server';
import {
  claimDueInviteEmails,
  markInviteEmailDelivered,
  markInviteEmailFailed,
  markInviteEmailRetry,
  reclaimStaleInviteEmails,
} from '@kilocode/db/external-side-effect-outbox';
import type { ExternalSideEffectOutboxRow } from '@kilocode/db/schema';

const logInfo = sentryLogger('invite-email-outbox', 'info');
const logWarning = sentryLogger('invite-email-outbox', 'warning');
const logError = sentryLogger('invite-email-outbox', 'error');

const DEFAULT_CLAIM_LIMIT = 100;

export type InviteEmailOutboxDispatchSummary = {
  reclaimed: number;
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
};

type OutboxDispatchOutcome = 'delivered' | 'retried' | 'failed';

/**
 * Drains the invite-email outbox in one cron pass and returns a per-step
 * summary for the cron route.
 */
export async function dispatchQueuedInviteEmails(params?: {
  limit?: number;
}): Promise<InviteEmailOutboxDispatchSummary> {
  // Reclaim `sending` claims left behind by crashed drainers.
  const reclaimed = await reclaimStaleInviteEmails(db);
  for (const row of reclaimed) {
    logWarning('Reclaimed stale invite email outbox claim', outboxLogFields(row));
  }

  // Claim due `pending` rows in bounded batches and send each.
  const counts: Record<OutboxDispatchOutcome, number> = { delivered: 0, retried: 0, failed: 0 };
  let claimedTotal = 0;
  let remaining = params?.limit ?? DEFAULT_CLAIM_LIMIT;
  while (remaining > 0) {
    const claimed = await claimDueInviteEmails(db, remaining);
    if (claimed.length === 0) {
      break;
    }
    claimedTotal += claimed.length;
    remaining -= claimed.length;
    for (const row of claimed) {
      counts[await dispatchInviteEmail(row)] += 1;
    }
  }

  return { reclaimed: reclaimed.length, claimed: claimedTotal, ...counts };
}

/**
 * Sends one claimed invite email and drives its delivery mark. Marks are
 * claim-fenced on `claimed_at`, so a late mark from a reclaimed claim is a
 * no-op that leaves the row to the newer claim.
 */
async function dispatchInviteEmail(
  row: ExternalSideEffectOutboxRow
): Promise<OutboxDispatchOutcome> {
  const claimedAt = row.claimed_at;
  if (!claimedAt) {
    // Unreachable through `claimDueInviteEmails`, which always stamps the claim.
    logError('Invite email outbox row claimed without a claim token', outboxLogFields(row));
    return 'failed';
  }

  const payload = row.payload;

  let result;
  try {
    result = await sendOrganizationInviteEmail({
      to: payload.to,
      organizationName: payload.organizationName,
      inviterName: payload.inviterName,
      acceptInviteUrl: payload.acceptInviteUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError('Invite email outbox send failed', { ...outboxLogFields(row), error: message });
    const retry = await markInviteEmailRetry(db, { id: row.id, claimedAt, error: message });
    return retry?.outcome === 'failed' ? 'failed' : 'retried';
  }

  if (!result.sent) {
    logError('Invite email outbox send rejected', {
      ...outboxLogFields(row),
      reason: result.reason,
    });
    if (result.reason === 'neverbounce_rejected') {
      const failed = await markInviteEmailFailed(db, {
        id: row.id,
        claimedAt,
        error: result.reason,
      });
      return failed ? 'failed' : 'retried';
    }
    const retry = await markInviteEmailRetry(db, { id: row.id, claimedAt, error: result.reason });
    return retry?.outcome === 'failed' ? 'failed' : 'retried';
  }

  const delivered = await markInviteEmailDelivered(db, { id: row.id, claimedAt });
  if (!delivered) {
    // The claim was reclaimed and re-claimed mid-flight; the newer claim owns
    // the row now.
    logWarning(
      'Invite email delivery mark skipped: claim already transitioned',
      outboxLogFields(row)
    );
    return 'delivered';
  }
  logInfo('Delivered invite email', outboxLogFields(delivered));
  return 'delivered';
}

function outboxLogFields(row: ExternalSideEffectOutboxRow): Record<string, unknown> {
  return {
    outbox_id: row.id,
    invitation_id: row.invitation_id,
    status: row.status,
    attempts: row.attempts,
    dispatch_source: 'cron',
  };
}
