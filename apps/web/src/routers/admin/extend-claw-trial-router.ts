import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import { kilocode_users, kiloclaw_subscriptions, kiloclaw_email_log } from '@kilocode/db/schema';
import * as z from 'zod';
import { eq, and, inArray, sql, desc, isNull } from 'drizzle-orm';
import { createKiloClawAdminAuditLog } from '@/lib/kiloclaw/admin-audit-log';

const MAX_USERS = 1000;

type MatchedUser = {
  email: string;
  userId: string;
  userName: string | null;
  subscriptionStatus: string | null;
  instanceId: string | null;
  stripeSubscriptionId: string | null;
  trialEndsAt: string | null;
};

type UnmatchedEmail = {
  email: string;
};

type MatchUsersResult = {
  matched: MatchedUser[];
  unmatched: UnmatchedEmail[];
};

export type ExtendTrialResult = {
  email: string;
  userId: string;
  instanceId: string | null;
  success: boolean;
  action?: 'extended' | 'restarted';
  newTrialEndsAt?: string;
  error?: string;
};

/**
 * For each user_id in the given array, return the most recently created
 * kiloclaw_subscriptions row. Users with no subscription are omitted.
 *
 * DISTINCT ON (user_id) ORDER BY user_id, created_at DESC lets Postgres pick
 * exactly one row per user with a single index scan — no application-side
 * deduplication needed.
 *
 * Multi-instance users (one subscription row per instance) are handled
 * consistently: only their latest subscription is targeted.
 */
async function fetchLatestSubscriptionPerUser(
  userIds: string[]
): Promise<Map<string, typeof kiloclaw_subscriptions.$inferSelect>> {
  if (userIds.length === 0) return new Map();

  const rows = await db
    .selectDistinctOn([kiloclaw_subscriptions.user_id])
    .from(kiloclaw_subscriptions)
    .where(inArray(kiloclaw_subscriptions.user_id, userIds))
    .orderBy(kiloclaw_subscriptions.user_id, desc(kiloclaw_subscriptions.created_at));

  return new Map(rows.map(r => [r.user_id, r]));
}

type AdminContext = {
  user: { id: string; google_user_email: string; google_user_name: string | null };
};

function adminSubscriptionActor(ctx: AdminContext) {
  return {
    actorType: 'user',
    actorId: ctx.user.id,
  } as const;
}

async function writeBestEffortSubscriptionChangeLog(
  ctx: AdminContext,
  params: {
    subscriptionId: string;
    action: 'admin_override' | 'reactivated';
    reason: string;
    before: typeof kiloclaw_subscriptions.$inferSelect;
    after: typeof kiloclaw_subscriptions.$inferSelect;
  }
) {
  try {
    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: params.subscriptionId,
      actor: adminSubscriptionActor(ctx),
      action: params.action,
      reason: params.reason,
      before: params.before,
      after: params.after,
    });
  } catch (error) {
    // Trial change already committed. Log failure must not trigger retry.
    console.error('[admin-extend-claw-trial] Failed to write subscription change log:', error);
  }
}

const EMAIL_TYPES_TO_CLEAR = [
  'claw_trial_1d',
  'claw_trial_5d',
  'claw_suspended_trial',
  'claw_suspended_subscription',
  'claw_suspended_payment',
  'claw_destruction_warning',
  'claw_instance_destroyed',
] as const;

async function processOneEmail(
  email: string,
  usersByEmail: Map<string, { id: string; email: string }>,
  latestSubByUserId: Map<string, typeof kiloclaw_subscriptions.$inferSelect>,
  trialDays: number,
  ctx: AdminContext
): Promise<ExtendTrialResult> {
  const user = usersByEmail.get(email);

  if (!user) {
    return { email, userId: '', instanceId: null, success: false, error: 'User not found' };
  }

  const subscription = latestSubByUserId.get(user.id);

  if (!subscription) {
    return {
      email,
      userId: user.id,
      instanceId: null,
      success: false,
      error: 'No KiloClaw subscription found. User must provision an instance first.',
    };
  }

  if (subscription.status === 'trialing') {
    // Extend from the later of current end date or now, so already-expired
    // trials extend from today rather than from a past date.
    // Scoped to the specific row id to avoid touching other instances.
    const [updated] = await db
      .update(kiloclaw_subscriptions)
      .set({
        // Extend from the later of current end date or now, capped at 1 year
        // from now. The at_limit check at match time prevents users already
        // past the ceiling from being submitted, but the LEAST here enforces
        // the ceiling on the resulting value for users currently within it
        // (e.g. 200 days remaining + 365 days requested = capped at 365).
        trial_ends_at: sql`LEAST(GREATEST(COALESCE(${kiloclaw_subscriptions.trial_ends_at}::timestamptz, now()), now()) + (${trialDays} * interval '1 day'), now() + interval '1 year')`,
      })
      .where(
        and(
          eq(kiloclaw_subscriptions.id, subscription.id),
          eq(kiloclaw_subscriptions.status, 'trialing')
        )
      )
      .returning();

    if (!updated) {
      // Subscription status changed between match and extend (e.g. user subscribed).
      return {
        email,
        userId: user.id,
        instanceId: subscription.instance_id,
        success: false,
        error: 'Subscription status changed since match — please re-match and retry.',
      };
    }

    await writeBestEffortSubscriptionChangeLog(ctx, {
      subscriptionId: subscription.id,
      action: 'admin_override',
      reason: 'bulk_extend_trial',
      before: subscription,
      after: updated,
    });

    // Audit log is best-effort — its failure does not undo the extension
    // and must not cause a false failure result that prompts a retry.
    try {
      await createKiloClawAdminAuditLog({
        action: 'kiloclaw.subscription.bulk_trial_grant',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        target_user_id: user.id,
        message: `Trial extended by ${trialDays} days via bulk extend, new end: ${updated.trial_ends_at}`,
        metadata: {
          source: 'bulk_extend',
          trialDays,
          subscriptionId: subscription.id,
          previousTrialEndsAt: subscription.trial_ends_at,
          newTrialEndsAt: updated.trial_ends_at,
          action: 'extended',
        },
      });
    } catch {
      // Non-fatal
    }

    return {
      email,
      userId: user.id,
      instanceId: subscription.instance_id,
      success: true,
      action: 'extended',
      newTrialEndsAt: updated.trial_ends_at ?? undefined,
    };
  }

  if (subscription.status === 'canceled') {
    const now = new Date();
    // Use the same 1-year interval semantics as the SQL ceiling in the trialing path.
    // addYears is not available without date-fns, so compute via date arithmetic to
    // match what Postgres's `interval '1 year'` produces (calendar year, not 365 days).
    const oneYearFromNow = new Date(now);
    oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
    const newEnd = new Date(
      Math.min(now.getTime() + trialDays * 86_400_000, oneYearFromNow.getTime())
    );

    // Resurrect as a fresh trial, mirroring the single-user admin reset path.
    // Scoped to the specific row id to avoid touching other instances.
    const [resurrected] = await db
      .update(kiloclaw_subscriptions)
      .set({
        status: 'trialing',
        plan: 'trial',
        trial_started_at: now.toISOString(),
        trial_ends_at: newEnd.toISOString(),
        stripe_subscription_id: null,
        stripe_schedule_id: null,
        scheduled_plan: null,
        scheduled_by: null,
        cancel_at_period_end: false,
        // payment_source and pending_conversion are intentionally left
        // as-is: stripe_subscription_id = null is the real guard against
        // stale Stripe webhook replays, and the billing implications of
        // clearing these fields on a canceled row haven't been fully
        // analyzed for every payment_source value.
        current_period_start: null,
        current_period_end: null,
        commit_ends_at: null,
        past_due_since: null,
        suspended_at: null,
        destruction_deadline: null,
      })
      .where(
        and(
          eq(kiloclaw_subscriptions.id, subscription.id),
          eq(kiloclaw_subscriptions.status, 'canceled')
        )
      )
      .returning();

    if (!resurrected) {
      // Subscription status changed between match and extend (e.g. user reactivated).
      return {
        email,
        userId: user.id,
        instanceId: subscription.instance_id,
        success: false,
        error: 'Subscription status changed since match — please re-match and retry.',
      };
    }

    await writeBestEffortSubscriptionChangeLog(ctx, {
      subscriptionId: subscription.id,
      action: 'reactivated',
      reason: 'bulk_restart_trial',
      before: subscription,
      after: resurrected,
    });

    // Email log clear and audit log are best-effort — their failure does
    // not undo the resurrection and must not cause a false failure result
    // that prompts a retry (which would extend rather than resurrect).
    try {
      await db
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, user.id),
            subscription.instance_id
              ? eq(kiloclaw_email_log.instance_id, subscription.instance_id)
              : isNull(kiloclaw_email_log.instance_id),
            inArray(kiloclaw_email_log.email_type, [...EMAIL_TYPES_TO_CLEAR])
          )
        );

      await createKiloClawAdminAuditLog({
        action: 'kiloclaw.subscription.bulk_trial_grant',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        target_user_id: user.id,
        message: `Trial restarted for ${trialDays} days via bulk extend (was canceled)`,
        metadata: {
          source: 'bulk_extend',
          trialDays,
          subscriptionId: subscription.id,
          previousStatus: subscription.status,
          newTrialEndsAt: newEnd.toISOString(),
          action: 'restarted',
        },
      });
    } catch {
      // Non-fatal
    }

    return {
      email,
      userId: user.id,
      instanceId: subscription.instance_id,
      success: true,
      action: 'restarted',
      newTrialEndsAt: newEnd.toISOString(),
    };
  }

  // Active paid subscription (active, past_due, unpaid) — must not be reset.
  return {
    email,
    userId: user.id,
    instanceId: subscription.instance_id,
    success: false,
    error: `Cannot extend trial: subscription status is "${subscription.status}". Only trialing or canceled subscriptions can be modified.`,
  };
}

export const extendClawTrialRouter = createTRPCRouter({
  /**
   * Match a list of emails to existing Kilo user accounts, including their
   * most recent KiloClaw subscription status (null = no subscription yet).
   *
   * For users with multiple instances (multiple subscription rows), only the
   * most recently created subscription is considered.
   */
  matchUsers: adminProcedure
    .input(z.object({ emails: z.array(z.string().email()).max(MAX_USERS) }))
    .query(async ({ input }): Promise<MatchUsersResult> => {
      const { emails } = input;
      if (emails.length === 0) {
        return { matched: [], unmatched: [] };
      }

      const normalizedEmails = [...new Set(emails.map(e => e.toLowerCase()))];

      const users = await db
        .select({
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
          name: kilocode_users.google_user_name,
        })
        .from(kilocode_users)
        .where(inArray(kilocode_users.google_user_email, normalizedEmails));

      if (users.length === 0) {
        return {
          matched: [],
          unmatched: normalizedEmails.map(email => ({ email })),
        };
      }

      const userIds = users.map(u => u.id);
      const latestSubByUserId = await fetchLatestSubscriptionPerUser(userIds);
      const usersByEmail = new Map(users.map(u => [u.email.toLowerCase(), u]));

      const matched: MatchedUser[] = [];
      const unmatched: UnmatchedEmail[] = [];

      for (const email of normalizedEmails) {
        const user = usersByEmail.get(email);
        if (user) {
          const sub = latestSubByUserId.get(user.id);
          // at_limit when trial already meets or exceeds the 1-year ceiling so
          // that extending would produce the same or an earlier date. Use an
          // exact ms-level comparison against a calendar-year boundary (same
          // semantics as Postgres `interval '1 year'`) — no day truncation, so
          // trials ending later on the same calendar day as the boundary are
          // still shown as eligible and the SQL LEAST will cap them correctly.
          const now = new Date();
          const oneYearFromNow = new Date(now);
          oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
          const beyondCeiling =
            sub?.status === 'trialing' &&
            sub.trial_ends_at !== null &&
            new Date(sub.trial_ends_at) >= oneYearFromNow;
          matched.push({
            email: user.email,
            userId: user.id,
            userName: user.name,
            subscriptionStatus: beyondCeiling ? 'at_limit' : (sub?.status ?? null),
            instanceId: sub?.instance_id ?? null,
            stripeSubscriptionId: sub?.stripe_subscription_id ?? null,
            trialEndsAt: sub?.trial_ends_at ?? null,
          });
        } else {
          unmatched.push({ email });
        }
      }

      return { matched, unmatched };
    }),

  /**
   * Extend or resurrect KiloClaw trials for a list of email addresses.
   *
   * Only the most recently created subscription row per user is targeted —
   * this future-proofs against users with multiple instances.
   *
   * - status 'trialing': extends trial_ends_at by N days from the later of
   *   the current end date or now (so expired trials extend from today).
   * - status 'canceled': resurrects as a fresh trial for N days and clears
   *   billing email log entries so trial notifications can fire again.
   * - no subscription: skipped with an error.
   * - active / past_due / unpaid: skipped with an error.
   */
  extendTrials: adminProcedure
    .input(
      z.object({
        emails: z.array(z.string().email()).max(MAX_USERS),
        trialDays: z.number().int().positive().max(365),
      })
    )
    .mutation(async ({ input, ctx }): Promise<ExtendTrialResult[]> => {
      const { emails, trialDays } = input;

      if (emails.length === 0) return [];

      const normalizedEmails = [...new Set(emails.map(e => e.toLowerCase()))];

      // Resolve emails → users in one query
      const users = await db
        .select({
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
        })
        .from(kilocode_users)
        .where(inArray(kilocode_users.google_user_email, normalizedEmails));

      const usersByEmail = new Map(users.map(u => [u.email.toLowerCase(), u]));

      // Fetch the most recently created subscription per user in one query
      const userIds = users.map(u => u.id);
      const latestSubByUserId = await fetchLatestSubscriptionPerUser(userIds);

      // Process all emails concurrently — each email's DB work is independent.
      const settled = await Promise.allSettled(
        normalizedEmails.map(email =>
          processOneEmail(email, usersByEmail, latestSubByUserId, trialDays, ctx)
        )
      );

      return settled.map((outcome, i) => {
        if (outcome.status === 'fulfilled') return outcome.value;
        const email = normalizedEmails[i];
        return {
          email,
          userId: usersByEmail.get(email)?.id ?? '',
          instanceId: null,
          success: false,
          error: outcome.reason instanceof Error ? outcome.reason.message : 'Unknown error',
        };
      });
    }),
});
