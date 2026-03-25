import 'server-only';

import { and, eq, lt, lte, gte, isNull, isNotNull, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@kilocode/db/schema';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_email_log,
  kiloclaw_earlybird_purchases,
  kilocode_users,
} from '@kilocode/db/schema';
import { format } from 'date-fns';
import type { TemplateName } from '@/lib/email';
import { send as sendEmail } from '@/lib/email';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { ensureAutoIntroSchedule } from '@/lib/kiloclaw/stripe-handlers';
import { isIntroPriceId } from '@/lib/kiloclaw/stripe-price-ids.server';
import { client as stripe } from '@/lib/stripe-client';
import { KILOCLAW_EARLYBIRD_EXPIRY_DATE } from '@/lib/kiloclaw/constants';
import { NEXTAUTH_URL, KILOCLAW_BILLING_ENFORCEMENT } from '@/lib/config.server';
import { sentryLogger } from '@/lib/utils.server';

const logInfo = sentryLogger('kiloclaw-billing-cron', 'info');
const logError = sentryLogger('kiloclaw-billing-cron', 'error');

const MS_PER_DAY = 86_400_000;
const DESTRUCTION_GRACE_DAYS = 7;
const PAST_DUE_THRESHOLD_DAYS = 14;
const TRIAL_WARNING_DAYS = 2;
const DESTRUCTION_WARNING_DAYS = 2;

/** Format a Date for human-readable email display, e.g. "March 15, 2026". */
function formatDateForEmail(d: Date): string {
  return format(d, 'MMMM d, yyyy');
}

type CronSummary = {
  trial_warnings: number;
  earlybird_warnings: number;
  sweep1_trial_expiry: number;
  sweep2_subscription_expiry: number;
  destruction_warnings: number;
  sweep3_instance_destruction: number;
  sweep4_past_due_cleanup: number;
  sweep5_intro_schedules_repaired: number;
  emails_sent: number;
  emails_skipped: number;
  errors: number;
};

/**
 * Idempotent email send: inserts into kiloclaw_email_log with onConflictDoNothing.
 * If rowCount === 0, the email was already sent for this user+type — skip.
 */
async function trySendEmail(
  database: PostgresJsDatabase<typeof schema>,
  userId: string,
  userEmail: string,
  emailType: string,
  templateName: TemplateName,
  templateVars: Record<string, string>,
  summary: CronSummary,
  subjectOverride?: string
): Promise<boolean> {
  // Insert first to claim the slot; if rowCount is 0, already sent — skip.
  // If send fails, delete to allow retry on the next cron run.
  const result = await database
    .insert(kiloclaw_email_log)
    .values({ user_id: userId, email_type: emailType })
    .onConflictDoNothing();
  if (result.rowCount === 0) {
    summary.emails_skipped++;
    return false;
  }
  try {
    const emailResult = await sendEmail({
      to: userEmail,
      templateName,
      templateVars,
      subjectOverride,
    });

    if (!emailResult.sent) {
      if (emailResult.reason === 'provider_not_configured') {
        // Transient — credentials may be added later; remove idempotency guard so the next cron run can retry
        await database
          .delete(kiloclaw_email_log)
          .where(
            and(
              eq(kiloclaw_email_log.user_id, userId),
              eq(kiloclaw_email_log.email_type, emailType)
            )
          );
      }
      // For neverbounce_rejected the address is permanently invalid — keep the
      // idempotency row so we don't re-verify on every sweep.
      summary.emails_skipped++;
      return false;
    }
  } catch (error) {
    try {
      await database
        .delete(kiloclaw_email_log)
        .where(
          and(eq(kiloclaw_email_log.user_id, userId), eq(kiloclaw_email_log.email_type, emailType))
        );
    } catch (deleteError) {
      console.error(
        '[billing-cron] Failed to remove email log row after send failure:',
        deleteError,
        { userId, emailType }
      );
    }
    throw error;
  }
  summary.emails_sent++;
  return true;
}

export async function runKiloClawBillingLifecycleCron(
  database: PostgresJsDatabase<typeof schema>
): Promise<CronSummary> {
  const summary: CronSummary = {
    trial_warnings: 0,
    earlybird_warnings: 0,
    sweep1_trial_expiry: 0,
    sweep2_subscription_expiry: 0,
    destruction_warnings: 0,
    sweep3_instance_destruction: 0,
    sweep4_past_due_cleanup: 0,
    sweep5_intro_schedules_repaired: 0,
    emails_sent: 0,
    emails_skipped: 0,
    errors: 0,
  };

  if (!KILOCLAW_BILLING_ENFORCEMENT) {
    logInfo('KiloClaw billing enforcement is disabled, skipping lifecycle cron');
    return summary;
  }

  const now = new Date().toISOString();
  const client = new KiloClawInternalClient();
  const clawUrl = `${NEXTAUTH_URL}/claw`;

  // ── Sweep 0a: Trial ending-soon warning ─────────────────────────────
  const trialWarningCutoff = new Date(Date.now() + TRIAL_WARNING_DAYS * MS_PER_DAY).toISOString();
  const trialWarningRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
      trial_ends_at: kiloclaw_subscriptions.trial_ends_at,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'trialing'),
        gte(kiloclaw_subscriptions.trial_ends_at, now),
        lte(kiloclaw_subscriptions.trial_ends_at, trialWarningCutoff),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of trialWarningRows) {
    try {
      if (!row.trial_ends_at) continue;
      const daysRemaining = Math.ceil(
        (new Date(row.trial_ends_at).getTime() - Date.now()) / MS_PER_DAY
      );

      if (daysRemaining <= 1) {
        // 1-day warning — more urgent, replaces the ending-soon message
        const sent = await trySendEmail(
          database,
          row.user_id,
          row.email,
          'claw_trial_1d',
          'clawTrialExpiresTomorrow',
          { claw_url: clawUrl },
          summary
        );
        if (sent) summary.trial_warnings++;
      } else {
        // Ending-soon warning (idempotent — skipped if already sent).
        // Key kept as 'claw_trial_5d' so users warned under the old 5-day
        // threshold aren't re-notified after the threshold changed to 2 days.
        const sent = await trySendEmail(
          database,
          row.user_id,
          row.email,
          'claw_trial_5d',
          'clawTrialEndingSoon',
          { days_remaining: String(daysRemaining), claw_url: clawUrl },
          summary,
          `Your KiloClaw Trial Ends in ${daysRemaining} Days`
        );
        if (sent) summary.trial_warnings++;
      }
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 0a (trial warning) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 0b: Earlybird Warnings ───────────────────────────────────
  const earlybirdExpiry = new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE);
  const daysUntilEarlybird = Math.ceil((earlybirdExpiry.getTime() - Date.now()) / MS_PER_DAY);

  if (daysUntilEarlybird > 0 && daysUntilEarlybird <= 14) {
    const earlybirdRows = await database
      .select({
        user_id: kiloclaw_earlybird_purchases.user_id,
        email: kilocode_users.google_user_email,
      })
      .from(kiloclaw_earlybird_purchases)
      .innerJoin(kilocode_users, eq(kiloclaw_earlybird_purchases.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_earlybird_purchases.user_id, kiloclaw_subscriptions.user_id)
      )
      .where(
        and(
          sql`(${kiloclaw_subscriptions.status} IS NULL OR ${kiloclaw_subscriptions.status} NOT IN ('active', 'trialing'))`,
          isNull(kiloclaw_subscriptions.suspended_at)
        )
      );

    for (const row of earlybirdRows) {
      try {
        const expiryDate = formatDateForEmail(earlybirdExpiry);

        if (daysUntilEarlybird <= 1) {
          // 1-day warning — more urgent, replaces the 14-day message
          const sent = await trySendEmail(
            database,
            row.user_id,
            row.email,
            'claw_earlybird_1d',
            'clawEarlybirdExpiresTomorrow',
            { expiry_date: expiryDate, claw_url: clawUrl },
            summary
          );
          if (sent) summary.earlybird_warnings++;
        } else {
          // 14-day warning (idempotent — skipped if already sent)
          const sent = await trySendEmail(
            database,
            row.user_id,
            row.email,
            'claw_earlybird_14d',
            'clawEarlybirdEndingSoon',
            {
              days_remaining: String(daysUntilEarlybird),
              expiry_date: expiryDate,
              claw_url: clawUrl,
            },
            summary
          );
          if (sent) summary.earlybird_warnings++;
        }
      } catch (error) {
        summary.errors++;
        captureException(error);
        logError('Sweep 0b (earlybird warning) failed for user', {
          user_id: row.user_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ── Sweep 1: Trial Expiry ──────────────────────────────────────────
  const expiredTrials = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'trialing'),
        lt(kiloclaw_subscriptions.trial_ends_at, now),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of expiredTrials) {
    try {
      // Per spec: stop/destroy failures MUST be logged and the state
      // transition MUST proceed regardless, so transient outages don't
      // leave expired accounts active.
      try {
        await client.stop(row.user_id);
      } catch (stopError) {
        const isExpected =
          stopError instanceof KiloClawApiError &&
          (stopError.statusCode === 404 || stopError.statusCode === 409);
        if (isExpected) {
          logInfo('Sweep 1: stop() returned expected error, proceeding with state transition', {
            user_id: row.user_id,
            statusCode: stopError.statusCode,
            error: stopError.message,
          });
        } else {
          captureException(stopError);
          logError('Sweep 1: stop() failed, proceeding with state transition', {
            user_id: row.user_id,
            error: stopError instanceof Error ? stopError.message : String(stopError),
          });
        }
      }
      const destructionDeadline = new Date(Date.now() + DESTRUCTION_GRACE_DAYS * MS_PER_DAY);
      await database
        .update(kiloclaw_subscriptions)
        .set({
          status: 'canceled',
          suspended_at: now,
          destruction_deadline: destructionDeadline.toISOString(),
        })
        .where(eq(kiloclaw_subscriptions.user_id, row.user_id));
      summary.sweep1_trial_expiry++;

      await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_suspended_trial',
        'clawSuspendedTrial',
        {
          destruction_date: formatDateForEmail(destructionDeadline),
          claw_url: clawUrl,
        },
        summary
      );
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 1 (trial expiry) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 2: Subscription Period Expiry ────────────────────────────
  const expiredSubscriptions = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'canceled'),
        lt(kiloclaw_subscriptions.current_period_end, now),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of expiredSubscriptions) {
    try {
      try {
        await client.stop(row.user_id);
      } catch (stopError) {
        const isExpected =
          stopError instanceof KiloClawApiError &&
          (stopError.statusCode === 404 || stopError.statusCode === 409);
        if (isExpected) {
          logInfo('Sweep 2: stop() returned expected error, proceeding with state transition', {
            user_id: row.user_id,
            statusCode: stopError.statusCode,
            error: stopError.message,
          });
        } else {
          captureException(stopError);
          logError('Sweep 2: stop() failed, proceeding with state transition', {
            user_id: row.user_id,
            error: stopError instanceof Error ? stopError.message : String(stopError),
          });
        }
      }
      const destructionDeadline = new Date(Date.now() + DESTRUCTION_GRACE_DAYS * MS_PER_DAY);
      await database
        .update(kiloclaw_subscriptions)
        .set({
          suspended_at: now,
          destruction_deadline: destructionDeadline.toISOString(),
        })
        .where(eq(kiloclaw_subscriptions.user_id, row.user_id));
      summary.sweep2_subscription_expiry++;

      await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_suspended_subscription',
        'clawSuspendedSubscription',
        {
          destruction_date: formatDateForEmail(destructionDeadline),
          claw_url: clawUrl,
        },
        summary
      );
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 2 (subscription expiry) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 2.5: Destruction 2-day Warning ───────────────────────────
  const twoDaysFromNow = new Date(Date.now() + DESTRUCTION_WARNING_DAYS * MS_PER_DAY).toISOString();
  const destructionWarningRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
      destruction_deadline: kiloclaw_subscriptions.destruction_deadline,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        gte(kiloclaw_subscriptions.destruction_deadline, now),
        lte(kiloclaw_subscriptions.destruction_deadline, twoDaysFromNow),
        isNotNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of destructionWarningRows) {
    try {
      if (!row.destruction_deadline) continue;
      const sent = await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_destruction_warning',
        'clawDestructionWarning',
        {
          destruction_date: formatDateForEmail(new Date(row.destruction_deadline)),
          claw_url: clawUrl,
        },
        summary
      );
      if (sent) summary.destruction_warnings++;
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 2.5 (destruction warning) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 3: Instance Destruction ──────────────────────────────────
  const destructionCandidates = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        lt(kiloclaw_subscriptions.destruction_deadline, now),
        isNotNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of destructionCandidates) {
    try {
      try {
        await client.destroy(row.user_id);
      } catch (destroyError) {
        const isExpected =
          destroyError instanceof KiloClawApiError &&
          (destroyError.statusCode === 404 || destroyError.statusCode === 409);
        if (isExpected) {
          logInfo('Sweep 3: destroy() returned expected error, proceeding with state transition', {
            user_id: row.user_id,
            statusCode: destroyError.statusCode,
            error: destroyError.message,
          });
        } else {
          captureException(destroyError);
          logError('Sweep 3: destroy() failed, proceeding with state transition', {
            user_id: row.user_id,
            error: destroyError instanceof Error ? destroyError.message : String(destroyError),
          });
        }
      }
      // Mark active instances as destroyed
      await database
        .update(kiloclaw_instances)
        .set({ destroyed_at: now })
        .where(
          and(eq(kiloclaw_instances.user_id, row.user_id), isNull(kiloclaw_instances.destroyed_at))
        );
      await database
        .update(kiloclaw_subscriptions)
        .set({ destruction_deadline: null })
        .where(eq(kiloclaw_subscriptions.user_id, row.user_id));
      summary.sweep3_instance_destruction++;

      await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_instance_destroyed',
        'clawInstanceDestroyed',
        { claw_url: clawUrl },
        summary
      );

      // Clear instance-ready email log so a future re-provision can trigger it again.
      // The email_type is scoped per-instance (claw_instance_ready:{sandboxId}),
      // so we use a prefix match to clear all variants for this user.
      await database
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, row.user_id),
            sql`${kiloclaw_email_log.email_type} LIKE 'claw_instance_ready:%'`
          )
        );
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 3 (instance destruction) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 4: Past-Due Cleanup ──────────────────────────────────────
  const fourteenDaysAgo = new Date(Date.now() - PAST_DUE_THRESHOLD_DAYS * MS_PER_DAY).toISOString();
  const pastDueRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'past_due'),
        lt(kiloclaw_subscriptions.past_due_since, fourteenDaysAgo),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of pastDueRows) {
    try {
      try {
        await client.stop(row.user_id);
      } catch (stopError) {
        const isExpected =
          stopError instanceof KiloClawApiError &&
          (stopError.statusCode === 404 || stopError.statusCode === 409);
        if (isExpected) {
          logInfo('Sweep 4: stop() returned expected error, proceeding with state transition', {
            user_id: row.user_id,
            statusCode: stopError.statusCode,
            error: stopError.message,
          });
        } else {
          captureException(stopError);
          logError('Sweep 4: stop() failed, proceeding with state transition', {
            user_id: row.user_id,
            error: stopError instanceof Error ? stopError.message : String(stopError),
          });
        }
      }
      const destructionDeadline = new Date(Date.now() + DESTRUCTION_GRACE_DAYS * MS_PER_DAY);
      await database
        .update(kiloclaw_subscriptions)
        .set({
          suspended_at: now,
          destruction_deadline: destructionDeadline.toISOString(),
        })
        .where(eq(kiloclaw_subscriptions.user_id, row.user_id));
      summary.sweep4_past_due_cleanup++;

      await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_suspended_payment',
        'clawSuspendedPayment',
        {
          destruction_date: formatDateForEmail(destructionDeadline),
          claw_url: clawUrl,
        },
        summary
      );
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 4 (past-due cleanup) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 5: Repair stranded intro-price subscriptions ─────────────
  const strandedIntroRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'active'),
        isNull(kiloclaw_subscriptions.stripe_schedule_id),
        isNotNull(kiloclaw_subscriptions.stripe_subscription_id),
        eq(kiloclaw_subscriptions.cancel_at_period_end, false)
      )
    );

  for (const row of strandedIntroRows) {
    try {
      const stripeSubId = row.stripe_subscription_id;
      if (!stripeSubId) continue;
      const liveSub = await stripe.subscriptions.retrieve(stripeSubId);
      const priceId = liveSub.items.data[0]?.price?.id;
      if (!priceId || !isIntroPriceId(priceId)) continue;
      if (liveSub.schedule) continue;

      await ensureAutoIntroSchedule(stripeSubId, row.user_id);
      summary.sweep5_intro_schedules_repaired++;
      logInfo('Sweep 5: repaired stranded intro-price subscription', {
        user_id: row.user_id,
        stripe_subscription_id: row.stripe_subscription_id,
      });
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 5 (intro schedule repair) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logInfo('KiloClaw billing lifecycle cron completed', { summary });
  return summary;
}
