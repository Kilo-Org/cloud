import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  kiloclaw_subscriptions,
  kiloclaw_email_log,
  kiloclaw_trial_grants,
} from '@kilocode/db/schema';
import * as z from 'zod';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { createKiloClawAdminAuditLog } from '@/lib/kiloclaw/admin-audit-log';

const MAX_EMAILS = 1000;

type MatchedUser = {
  email: string;
  userId: string;
  userName: string | null;
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
  success: boolean;
  action?: 'extended' | 'restarted' | 'granted';
  newTrialEndsAt?: string;
  trialDays?: number;
  error?: string;
};

export const extendClawTrialRouter = createTRPCRouter({
  /**
   * Match a list of emails to existing Kilo user accounts.
   * Returns matched users and unmatched emails.
   */
  matchUsers: adminProcedure
    .input(z.object({ emails: z.array(z.string().email()).max(MAX_EMAILS) }))
    .mutation(async ({ input }): Promise<MatchUsersResult> => {
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

      const usersByEmail = new Map(users.map(u => [u.email.toLowerCase(), u]));

      const matched: MatchedUser[] = [];
      const unmatched: UnmatchedEmail[] = [];

      for (const email of normalizedEmails) {
        const user = usersByEmail.get(email);
        if (user) {
          matched.push({
            email: user.email,
            userId: user.id,
            userName: user.name,
          });
        } else {
          unmatched.push({ email });
        }
      }

      return { matched, unmatched };
    }),

  /**
   * Extend/reset/grant KiloClaw trials for a list of emails.
   *
   * For each email:
   * - If user has an active trial (trialing): extend trial_ends_at by N days.
   * - If user's trial expired or subscription is canceled: restart as new trial for N days.
   * - If user never had a trial (no subscription record): create a trial_grant so
   *   they get the custom trial duration when they first visit /claw.
   */
  extendTrials: adminProcedure
    .input(
      z.object({
        emails: z.array(z.string().email()).max(MAX_EMAILS),
        trialDays: z.number().int().positive().max(365),
      })
    )
    .mutation(async ({ input, ctx }): Promise<ExtendTrialResult[]> => {
      const { emails, trialDays } = input;
      const results: ExtendTrialResult[] = [];

      if (emails.length === 0) return results;

      const normalizedEmails = [...new Set(emails.map(e => e.toLowerCase()))];

      // Find all matching users
      const users = await db
        .select({
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
          name: kilocode_users.google_user_name,
        })
        .from(kilocode_users)
        .where(inArray(kilocode_users.google_user_email, normalizedEmails));

      const usersByEmail = new Map(users.map(u => [u.email.toLowerCase(), u]));

      // Fetch existing subscriptions for all matched users
      const userIds = users.map(u => u.id);
      const subscriptions =
        userIds.length > 0
          ? await db
              .select()
              .from(kiloclaw_subscriptions)
              .where(inArray(kiloclaw_subscriptions.user_id, userIds))
          : [];

      const subscriptionsByUserId = new Map(subscriptions.map(s => [s.user_id, s]));

      for (const email of normalizedEmails) {
        const user = usersByEmail.get(email);

        if (!user) {
          results.push({
            email,
            userId: '',
            success: false,
            error: 'User not found',
          });
          continue;
        }

        const subscription = subscriptionsByUserId.get(user.id);

        try {
          const now = new Date();

          if (subscription?.status === 'trialing') {
            // Active trial — extend from current end date (or now if already past).
            // Use a SQL expression so the update is relative to the stored value,
            // preventing lost extensions from concurrent reads.
            const msToAdd = trialDays * 86_400_000;

            const [updated] = await db.transaction(async tx => {
              const [row] = await tx
                .update(kiloclaw_subscriptions)
                .set({
                  trial_ends_at: sql`GREATEST(${kiloclaw_subscriptions.trial_ends_at}, now()) + interval '${sql.raw(String(msToAdd))} milliseconds'`,
                })
                .where(eq(kiloclaw_subscriptions.user_id, user.id))
                .returning({ trial_ends_at: kiloclaw_subscriptions.trial_ends_at });

              await createKiloClawAdminAuditLog({
                action: 'kiloclaw.subscription.bulk_trial_grant',
                actor_id: ctx.user.id,
                actor_email: ctx.user.google_user_email,
                actor_name: ctx.user.google_user_name,
                target_user_id: user.id,
                message: `Trial extended by ${trialDays} days, new end: ${row?.trial_ends_at}`,
                metadata: {
                  trialDays,
                  previousTrialEndsAt: subscription.trial_ends_at,
                  newTrialEndsAt: row?.trial_ends_at,
                  action: 'extended',
                },
                tx,
              });

              return [row];
            });

            results.push({
              email,
              userId: user.id,
              success: true,
              action: 'extended',
              newTrialEndsAt: updated?.trial_ends_at ?? undefined,
              trialDays,
            });
          } else if (subscription?.status === 'canceled') {
            // Canceled subscription — reset to a new trial
            const newEnd = new Date(now.getTime() + trialDays * 86_400_000);

            await db.transaction(async tx => {
              await tx
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
                  current_period_start: null,
                  current_period_end: null,
                  commit_ends_at: null,
                  past_due_since: null,
                  suspended_at: null,
                  destruction_deadline: null,
                })
                .where(eq(kiloclaw_subscriptions.user_id, user.id));

              // Clear email logs so trial notifications can fire again
              const emailTypesToClear = [
                'claw_trial_1d',
                'claw_trial_5d',
                'claw_suspended_trial',
                'claw_suspended_subscription',
                'claw_suspended_payment',
                'claw_destruction_warning',
                'claw_instance_destroyed',
              ];
              await tx
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
                message: `Trial restarted for ${trialDays} days (was ${subscription.status})`,
                metadata: {
                  trialDays,
                  previousStatus: subscription.status,
                  newTrialEndsAt: newEnd.toISOString(),
                  action: 'restarted',
                },
                tx,
              });
            });

            results.push({
              email,
              userId: user.id,
              success: true,
              action: 'restarted',
              newTrialEndsAt: newEnd.toISOString(),
              trialDays,
            });
          } else if (subscription) {
            // Subscription exists but is an active paid plan (active, past_due, unpaid, etc.)
            // — must not be reset, same guard as single-user admin flow.
            results.push({
              email,
              userId: user.id,
              success: false,
              error: `Cannot extend trial: subscription status is "${subscription.status}". Only trialing or canceled subscriptions can be modified.`,
            });
          } else {
            // No subscription — user has never visited /claw.
            await db.transaction(async tx => {
              await tx
                .insert(kiloclaw_trial_grants)
                .values({
                  email: email.toLowerCase(),
                  trial_days: trialDays,
                  granted_by_user_id: ctx.user.id,
                  granted_by_email: ctx.user.google_user_email,
                })
                .onConflictDoUpdate({
                  target: kiloclaw_trial_grants.email,
                  set: {
                    trial_days: trialDays,
                    granted_by_user_id: ctx.user.id,
                    granted_by_email: ctx.user.google_user_email,
                    consumed_at: null,
                  },
                });

              await createKiloClawAdminAuditLog({
                action: 'kiloclaw.subscription.bulk_trial_grant',
                actor_id: ctx.user.id,
                actor_email: ctx.user.google_user_email,
                actor_name: ctx.user.google_user_name,
                target_user_id: user.id,
                message: `Trial grant of ${trialDays} days stored for first /claw visit`,
                metadata: {
                  trialDays,
                  action: 'granted',
                },
                tx,
              });
            });

            results.push({
              email,
              userId: user.id,
              success: true,
              action: 'granted',
              trialDays,
            });
          }
        } catch (error) {
          results.push({
            email,
            userId: user.id,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      return results;
    }),
});
