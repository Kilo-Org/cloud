import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import { client as stripeClient } from '@/lib/stripe-client';
import {
  cancelAndRefundKiloPassForUser,
  type CancelAndRefundKiloPassStripeClient,
} from '@/lib/kilo-pass/cancel-and-refund';

const BulkCancelSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(500),
  reason: z.string().min(1).trim(),
});

type BulkResultStatus =
  | 'cancelled_and_refunded'
  | 'skipped_no_user'
  | 'skipped_no_subscription'
  | 'skipped_already_canceled'
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
}: {
  emails: readonly string[];
  reason: string;
  adminKiloUserId: string;
  stripe: CancelAndRefundKiloPassStripeClient;
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
      results.push({
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
      results.push({
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
        noteSuffix: '[bulk]',
      });

      if (result.status === 'skipped') {
        results.push({
          email,
          userId: user.id,
          status:
            result.reason.kind === 'no_subscription'
              ? 'skipped_no_subscription'
              : 'skipped_already_canceled',
          refundedAmountCents: null,
          balanceResetAmountUsd: null,
          alreadyBlocked: false,
          error: null,
        });
        continue;
      }

      results.push({
        email,
        userId: user.id,
        status: 'cancelled_and_refunded',
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
      results.push({
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
      if (row.status === 'cancelled_and_refunded') {
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

export const adminKiloPassRouter = createTRPCRouter({
  cancelAndRefundKiloPassBulk: adminProcedure
    .input(BulkCancelSchema)
    .mutation(async ({ input, ctx }) => {
      const outcome = await runBulkCancelAndRefundKiloPass({
        emails: input.emails,
        reason: input.reason,
        adminKiloUserId: ctx.user.id,
        stripe: stripeClient,
      });

      console.log(
        `[admin.kiloPass.cancelAndRefundKiloPassBulk] admin=${ctx.user.id} total=${outcome.summary.total} cancelled=${outcome.summary.cancelled} skipped=${outcome.summary.skipped} errored=${outcome.summary.errored} refundedCents=${outcome.summary.totalRefundedCents}`
      );

      return outcome;
    }),
});
