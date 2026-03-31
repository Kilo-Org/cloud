import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { kilocode_users, kiloclaw_subscriptions, kiloclaw_email_log } from '@kilocode/db/schema';
import * as z from 'zod';
import { eq, and, inArray, sql, desc } from 'drizzle-orm';
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

type ExtendTrialResult = {
  email: string;
  userId: string;
  instanceId: string | null;
  success: boolean;
  action?: 'extended' | 'restarted';
  newTrialEndsAt?: string;
  trialDays?: number;
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
          const beyondCeiling =
            sub?.status === 'trialing' &&
            sub.trial_ends_at !== null &&
            new Date(sub.trial_ends_at) > new Date(Date.now() + 365 * 86_400_000);
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
      const results: ExtendTrialResult[] = [];

      if (emails.length === 0) return results;

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

      for (const email of normalizedEmails) {
        const user = usersByEmail.get(email);

        if (!user) {
          results.push({
            email,
            userId: '',
            instanceId: null,
            success: false,
            error: 'User not found',
          });
          continue;
        }

        const subscription = latestSubByUserId.get(user.id);

        if (!subscription) {
          results.push({
            email,
            userId: user.id,
            instanceId: null,
            success: false,
            error: 'No KiloClaw subscription found. User must provision an instance first.',
          });
          continue;
        }

        try {
          if (subscription.status === 'trialing') {
            // Extend from the later of current end date or now, so already-expired
            // trials extend from today rather than from a past date.
            // Scoped to the specific row id to avoid touching other instances.
            const [updated] = await db
              .update(kiloclaw_subscriptions)
              .set({
                // Extend from the later of current end date or now, so already-expired
                // trials extend from today. Users whose trial already exceeds 1 year
                // are marked ineligible at match time and never reach this path.
                trial_ends_at: sql`GREATEST(COALESCE(${kiloclaw_subscriptions.trial_ends_at}::timestamptz, now()), now()) + (${trialDays} * interval '1 day')`,
              })
              .where(
                and(
                  eq(kiloclaw_subscriptions.id, subscription.id),
                  eq(kiloclaw_subscriptions.status, 'trialing')
                )
              )
              .returning({ trial_ends_at: kiloclaw_subscriptions.trial_ends_at });

            if (!updated) {
              // Subscription status changed between match and extend (e.g. user subscribed).
              results.push({
                email,
                userId: user.id,
                instanceId: subscription.instance_id,
                success: false,
                error: 'Subscription status changed since match — please re-match and retry.',
              });
              continue;
            }

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

            results.push({
              email,
              userId: user.id,
              instanceId: subscription.instance_id,
              success: true,
              action: 'extended',
              newTrialEndsAt: updated.trial_ends_at ?? undefined,
              trialDays,
            });
          } else if (subscription.status === 'canceled') {
            const now = new Date();
            const oneYearFromNow = new Date(now.getTime() + 365 * 86_400_000);
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
              .returning({ user_id: kiloclaw_subscriptions.user_id });

            if (!resurrected) {
              // Subscription status changed between match and extend (e.g. user reactivated).
              results.push({
                email,
                userId: user.id,
                instanceId: subscription.instance_id,
                success: false,
                error: 'Subscription status changed since match — please re-match and retry.',
              });
              continue;
            }

            // Email log clear and audit log are best-effort — their failure does
            // not undo the resurrection and must not cause a false failure result
            // that prompts a retry (which would extend rather than resurrect).
            try {
              const emailTypesToClear = [
                'claw_trial_1d',
                'claw_trial_5d',
                'claw_suspended_trial',
                'claw_suspended_subscription',
                'claw_suspended_payment',
                'claw_destruction_warning',
                'claw_instance_destroyed',
              ];
              await db
                .delete(kiloclaw_email_log)
                .where(
                  and(
                    eq(kiloclaw_email_log.user_id, user.id),
                    inArray(kiloclaw_email_log.email_type, emailTypesToClear)
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

            results.push({
              email,
              userId: user.id,
              instanceId: subscription.instance_id,
              success: true,
              action: 'restarted',
              newTrialEndsAt: newEnd.toISOString(),
              trialDays,
            });
          } else {
            // Active paid subscription (active, past_due, unpaid) — must not be reset.
            results.push({
              email,
              userId: user.id,
              instanceId: subscription.instance_id,
              success: false,
              error: `Cannot extend trial: subscription status is "${subscription.status}". Only trialing or canceled subscriptions can be modified.`,
            });
          }
        } catch (error) {
          results.push({
            email,
            userId: user.id,
            instanceId: subscription.instance_id,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      return results;
    }),
});
