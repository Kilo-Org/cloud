import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import { client as stripeClient } from '@kilocode/web-shared/lib/stripe-client';
import {
  cancelAndRefundKiloPassForUser,
  type CancelAndRefundKiloPassStripeClient,
} from '@/lib/kilo-pass/cancel-and-refund';
import {
  type AdminActionEntry,
  recordAdminAction,
  redactEmailAddressesInAuditText,
  userActionTarget,
} from '@/lib/admin/admin-action-audit';
import { superadminProcedure } from '@/lib/trpc/admin-procedures';

const BulkCancelSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(500),
  reason: z.string().trim().min(1).max(500),
  refundLatestPayment: z.boolean().default(true),
});

type BulkResultStatus =
  | 'cancelled'
  | 'cancelled_and_refunded'
  | 'skipped_no_user'
  | 'skipped_no_subscription'
  | 'skipped_already_canceled'
  | 'skipped_store_managed'
  | 'error';

type BulkResultRow = {
  email: string;
  userId: string | null;
  status: BulkResultStatus;
  refundedAmountCents: number | null;
  balanceResetAmountUsd: number | null;
  alreadyBlocked: boolean;
  error: string | null;
};

function dedupeEmails(emails: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export async function runBulkCancelAndRefundKiloPass({
  emails,
  reason,
  adminKiloUserId,
  stripe,
  refundLatestPayment,
  onResult,
}: {
  emails: readonly string[];
  reason: string;
  adminKiloUserId: string;
  stripe: CancelAndRefundKiloPassStripeClient;
  refundLatestPayment: boolean;
  /** Called once per account as soon as its outcome is known, so a partial batch stays attributable. */
  onResult?: (row: BulkResultRow) => Promise<void>;
}): Promise<{
  results: BulkResultRow[];
  summary: {
    total: number;
    cancelled: number;
    skipped: number;
    errored: number;
    totalRefundedCents: number;
  };
}> {
  const uniqueEmails = dedupeEmails(emails);
  const results: BulkResultRow[] = [];

  async function record(row: BulkResultRow): Promise<void> {
    results.push(row);
    await onResult?.(row);
  }

  for (const email of uniqueEmails) {
    // `google_user_email` stores the provider email as-is (no case normalization)
    // and is case-sensitively unique. Look up case-insensitively so pasted
    // `user@example.com` matches a stored `User@example.com`. If two rows
    // differ only in case, bail out for that email rather than picking one.
    const matchingUsers = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(sql`lower(${kilocode_users.google_user_email}) = ${email}`)
      .limit(2);

    if (matchingUsers.length === 0) {
      await record({
        email,
        userId: null,
        status: 'skipped_no_user',
        refundedAmountCents: null,
        balanceResetAmountUsd: null,
        alreadyBlocked: false,
        error: null,
      });
      continue;
    }

    if (matchingUsers.length > 1) {
      await record({
        email,
        userId: null,
        status: 'error',
        refundedAmountCents: null,
        balanceResetAmountUsd: null,
        alreadyBlocked: false,
        error: 'Multiple accounts match this email (case-insensitive); resolve manually',
      });
      continue;
    }

    const user = matchingUsers[0];

    try {
      const result = await cancelAndRefundKiloPassForUser({
        db,
        stripe,
        userId: user.id,
        reason,
        adminKiloUserId,
        refundLatestPayment,
        noteSuffix: '[bulk]',
      });

      if (result.status === 'skipped') {
        const reasonKind = result.reason.kind;
        const status: BulkResultStatus =
          reasonKind === 'no_subscription'
            ? 'skipped_no_subscription'
            : reasonKind === 'already_canceled'
              ? 'skipped_already_canceled'
              : 'skipped_store_managed';
        await record({
          email,
          userId: user.id,
          status,
          refundedAmountCents: null,
          balanceResetAmountUsd: null,
          alreadyBlocked: false,
          error: null,
        });
        continue;
      }

      await record({
        email,
        userId: user.id,
        status: result.status,
        refundedAmountCents: result.refundedAmountCents,
        balanceResetAmountUsd: result.balanceResetAmountUsd,
        alreadyBlocked: result.alreadyBlocked,
        error: null,
      });
    } catch (err) {
      captureException(err, {
        tags: { source: 'admin.kiloPass.cancelAndRefundKiloPassBulk' },
        extra: { email, userId: user.id },
      });
      await record({
        email,
        userId: user.id,
        status: 'error',
        refundedAmountCents: null,
        balanceResetAmountUsd: null,
        alreadyBlocked: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary = results.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.status === 'cancelled' || row.status === 'cancelled_and_refunded') {
        acc.cancelled += 1;
        acc.totalRefundedCents += row.refundedAmountCents ?? 0;
      } else if (row.status === 'error') {
        acc.errored += 1;
      } else {
        acc.skipped += 1;
      }
      return acc;
    },
    { total: 0, cancelled: 0, skipped: 0, errored: 0, totalRefundedCents: 0 }
  );

  return { results, summary };
}

/**
 * One entry per account the batch acted on. Skipped accounts are not audited: no
 * action ran for them. A row that errored mid-way may have created a Stripe
 * refund before the failure, so it is recorded as an attempt with an unknown
 * outcome rather than left unattributed.
 *
 * `cancelled_and_refunded` does not prove a refund was created: the helper
 * reports it whenever a refund was requested, even when there was no paid
 * invoice, no payment intent, or Stripe had already refunded the charge. The
 * wording keys off the refunded amount instead.
 */
function bulkAuditEntry(
  row: BulkResultRow,
  params: { batchId: string; reason: string; refundLatestPayment: boolean }
): AdminActionEntry | null {
  if (!row.userId) return null;

  const outcome =
    row.status === 'error'
      ? 'attempted with unknown outcome'
      : row.refundedAmountCents != null
        ? 'and refunded the latest payment'
        : params.refundLatestPayment
          ? 'with no refundable payment'
          : 'without a Stripe refund';
  const message =
    row.status === 'cancelled' || row.status === 'cancelled_and_refunded'
      ? `Cancelled Kilo Pass ${outcome} via bulk admin cancel`
      : row.status === 'error'
        ? `Kilo Pass cancel ${outcome} via bulk admin cancel`
        : null;
  if (!message) return null;

  // No provider error text: the audit table is browsable by every platform
  // admin and the message can quote arbitrary Stripe or database values.
  // `batchId` groups the rows one request wrote; the caller passes the reason
  // already sanitized for recording.
  return {
    action: 'kilo_pass.cancel_refund',
    target: userActionTarget(row.userId),
    message,
    metadata: {
      batchId: params.batchId,
      status: row.status,
      reason: params.reason,
      refundLatestPayment: params.refundLatestPayment,
      refundedAmountCents: row.refundedAmountCents,
      balanceResetAmountUsd: row.balanceResetAmountUsd,
      alreadyBlocked: row.alreadyBlocked,
    },
  };
}

export const adminKiloPassRouter = createTRPCRouter({
  cancelAndRefundKiloPassBulk: superadminProcedure
    .input(BulkCancelSchema)
    .mutation(async ({ input, ctx }) => {
      const batchId = crypto.randomUUID();
      // The helper writes the reason to the target user records (block reason,
      // admin note and credit transaction description); the audit rows repeat it.
      const reason = redactEmailAddressesInAuditText(input.reason);
      const outcome = await runBulkCancelAndRefundKiloPass({
        emails: input.emails,
        adminKiloUserId: ctx.user.id,
        stripe: stripeClient,
        reason,
        refundLatestPayment: input.refundLatestPayment,
        onResult: async row => {
          const entry = bulkAuditEntry(row, {
            batchId,
            reason,
            refundLatestPayment: input.refundLatestPayment,
          });
          if (entry) await recordAdminAction(ctx, entry);
        },
      });

      console.log(
        `[admin.kiloPass.cancelAndRefundKiloPassBulk] admin=${ctx.user.id} batch=${batchId} total=${outcome.summary.total} cancelled=${outcome.summary.cancelled} skipped=${outcome.summary.skipped} errored=${outcome.summary.errored} refundLatestPayment=${input.refundLatestPayment} refundedCents=${outcome.summary.totalRefundedCents}`
      );

      return outcome;
    }),
});
