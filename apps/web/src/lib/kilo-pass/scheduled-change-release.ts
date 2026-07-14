import 'server-only';

import { kilo_pass_scheduled_changes } from '@kilocode/db/schema';
import { auto_deleted_at } from '@/lib/drizzle';
import type { DrizzleTransaction, db as defaultDb } from '@/lib/drizzle';
import { and, eq, inArray, isNull, not } from 'drizzle-orm';

import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassScheduledChangeStatus,
} from '@/lib/kilo-pass/enums';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';

type Db = typeof defaultDb;
type DbOrTx = Db | DrizzleTransaction;

export type StripeSubscriptionSchedulesClient = {
  subscriptionSchedules: {
    release: (scheduleId: string) => Promise<unknown>;
    retrieve?: (scheduleId: string) => Promise<{ status: string }>;
  };
};

export const KILO_PASS_TERMINAL_SCHEDULE_STATUSES = [
  KiloPassScheduledChangeStatus.Released,
  KiloPassScheduledChangeStatus.Canceled,
  KiloPassScheduledChangeStatus.Completed,
] as const;

export function isTerminalKiloPassScheduleStatus(status: KiloPassScheduledChangeStatus): boolean {
  return KILO_PASS_TERMINAL_SCHEDULE_STATUSES.includes(
    status as (typeof KILO_PASS_TERMINAL_SCHEDULE_STATUSES)[number]
  );
}

export async function reconcileKiloPassScheduledChangeTerminalStatus(params: {
  dbOrTx: DbOrTx;
  scheduledChangeId: string;
  status: KiloPassScheduledChangeStatus;
}): Promise<boolean> {
  if (!isTerminalKiloPassScheduleStatus(params.status)) return false;

  const updatedRows = await params.dbOrTx
    .update(kilo_pass_scheduled_changes)
    .set({ status: params.status, ...auto_deleted_at })
    .where(
      and(
        eq(kilo_pass_scheduled_changes.id, params.scheduledChangeId),
        isNull(kilo_pass_scheduled_changes.deleted_at),
        not(inArray(kilo_pass_scheduled_changes.status, KILO_PASS_TERMINAL_SCHEDULE_STATUSES))
      )
    )
    .returning({ id: kilo_pass_scheduled_changes.id });

  return updatedRows.length > 0;
}

export function maybeMapStripeScheduleStatusToDb(
  status: string
): KiloPassScheduledChangeStatus | null {
  switch (status) {
    case 'not_started':
      return KiloPassScheduledChangeStatus.NotStarted;
    case 'active':
      return KiloPassScheduledChangeStatus.Active;
    case 'completed':
      return KiloPassScheduledChangeStatus.Completed;
    case 'released':
      return KiloPassScheduledChangeStatus.Released;
    case 'canceled':
      return KiloPassScheduledChangeStatus.Canceled;
    default:
      return null;
  }
}

export async function releaseScheduledChangeForSubscription(params: {
  dbOrTx: DbOrTx;
  stripe: StripeSubscriptionSchedulesClient;
  stripeEventId?: string;
  stripeSubscriptionId: string;
  stripeScheduleIdIfMissingRow?: string;
  kiloUserIdIfMissingRow?: string | null;
  reason:
    | 'cancel_subscription'
    | 'cancel_scheduled_change'
    | 'schedule_change_replace'
    | 'invoice_paid'
    | 'issue_yearly_remaining_credits'
    | 'schedule_change_creation_failed';
}): Promise<void> {
  const {
    dbOrTx,
    stripe,
    stripeEventId,
    stripeSubscriptionId,
    stripeScheduleIdIfMissingRow,
    kiloUserIdIfMissingRow,
    reason,
  } = params;

  const row = await dbOrTx.query.kilo_pass_scheduled_changes.findFirst({
    columns: {
      id: true,
      kilo_user_id: true,
      stripe_schedule_id: true,
      stripe_subscription_id: true,
      status: true,
    },
    where: and(
      eq(kilo_pass_scheduled_changes.stripe_subscription_id, stripeSubscriptionId),
      isNull(kilo_pass_scheduled_changes.deleted_at)
    ),
  });

  if (!row) {
    if (!stripeScheduleIdIfMissingRow) return;

    await stripe.subscriptionSchedules.release(stripeScheduleIdIfMissingRow);
    await appendKiloPassAuditLog(dbOrTx, {
      action: KiloPassAuditLogAction.StripeWebhookReceived,
      result: KiloPassAuditLogResult.Success,
      kiloUserId: kiloUserIdIfMissingRow ?? null,
      stripeEventId: stripeEventId ?? null,
      stripeSubscriptionId,
      payload: {
        scope: 'kilo_pass_scheduled_change',
        type: 'subscription_schedule.release',
        scheduledChangeId: null,
        scheduleId: stripeScheduleIdIfMissingRow,
        scheduleStatus: null,
        reason,
        note: 'released_without_db_row',
      },
    });
    return;
  }

  // Safety: if the caller is trying to release a specific schedule id but the active DB row points
  // to a different schedule, do NOT release the active row's schedule.
  //
  // This is important for best-effort cleanup paths (e.g. schedule creation failed after Stripe
  // schedule creation, but before DB insert) where a concurrent request may have created its own
  // scheduled-change row. In that situation we only want to release the newly-created schedule
  // (passed explicitly), not the concurrently-created one tracked in DB.
  if (stripeScheduleIdIfMissingRow && stripeScheduleIdIfMissingRow !== row.stripe_schedule_id) {
    await stripe.subscriptionSchedules.release(stripeScheduleIdIfMissingRow);
    await appendKiloPassAuditLog(dbOrTx, {
      action: KiloPassAuditLogAction.StripeWebhookReceived,
      result: KiloPassAuditLogResult.Success,
      kiloUserId: kiloUserIdIfMissingRow ?? null,
      stripeEventId: stripeEventId ?? null,
      stripeSubscriptionId,
      payload: {
        scope: 'kilo_pass_scheduled_change',
        type: 'subscription_schedule.release',
        scheduledChangeId: null,
        scheduleId: stripeScheduleIdIfMissingRow,
        scheduleStatus: null,
        reason,
        note: 'released_schedule_id_mismatch',
        activeScheduledChangeId: row.id,
        activeScheduleId: row.stripe_schedule_id,
        activeScheduleStatus: row.status,
      },
    });
    return;
  }

  // Soft-delete first so that if Stripe release fails, callers can safely retry.
  // Also update status to `released` to reflect intent (even if Stripe later fails,
  // we revert this along with the soft-delete).
  const claimedRows = await dbOrTx
    .update(kilo_pass_scheduled_changes)
    .set({ ...auto_deleted_at, status: KiloPassScheduledChangeStatus.Released })
    .where(
      and(
        eq(kilo_pass_scheduled_changes.id, row.id),
        isNull(kilo_pass_scheduled_changes.deleted_at),
        not(inArray(kilo_pass_scheduled_changes.status, KILO_PASS_TERMINAL_SCHEDULE_STATUSES))
      )
    )
    .returning({ id: kilo_pass_scheduled_changes.id });

  // Another caller or webhook won the state transition after our initial read.
  // Confirm a durable provider outcome before reporting idempotent success.
  if (claimedRows.length === 0) {
    const retrieve = stripe.subscriptionSchedules.retrieve;
    if (retrieve) {
      const schedule = await retrieve(row.stripe_schedule_id);
      const providerStatus = maybeMapStripeScheduleStatusToDb(schedule.status);
      if (providerStatus && isTerminalKiloPassScheduleStatus(providerStatus)) return;
    }
    throw new Error(`Kilo Pass scheduled change release already in progress: ${row.id}`);
  }

  try {
    await stripe.subscriptionSchedules.release(row.stripe_schedule_id);
  } catch (error) {
    let providerStatus: KiloPassScheduledChangeStatus | null = null;
    let providerStateError: unknown = null;
    try {
      const retrieve = stripe.subscriptionSchedules.retrieve;
      if (retrieve) {
        const schedule = await retrieve(row.stripe_schedule_id);
        providerStatus = maybeMapStripeScheduleStatusToDb(schedule.status);
      }
    } catch (retrieveError) {
      providerStateError = retrieveError;
    }

    if (providerStatus && isTerminalKiloPassScheduleStatus(providerStatus)) {
      await dbOrTx
        .update(kilo_pass_scheduled_changes)
        .set({ status: providerStatus })
        .where(
          and(
            eq(kilo_pass_scheduled_changes.id, row.id),
            eq(kilo_pass_scheduled_changes.status, KiloPassScheduledChangeStatus.Released)
          )
        );

      await appendKiloPassAuditLog(dbOrTx, {
        action: KiloPassAuditLogAction.StripeWebhookReceived,
        result: KiloPassAuditLogResult.Success,
        kiloUserId: row.kilo_user_id,
        stripeEventId: stripeEventId ?? null,
        stripeSubscriptionId: row.stripe_subscription_id,
        payload: {
          scope: 'kilo_pass_scheduled_change',
          type: 'subscription_schedule.release',
          scheduledChangeId: row.id,
          scheduleId: row.stripe_schedule_id,
          scheduleStatus: providerStatus,
          reason,
          note: 'release_failed_but_provider_terminal',
        },
      });
      return;
    }

    // Revert the soft delete so the row remains visible and can be retried.
    await dbOrTx
      .update(kilo_pass_scheduled_changes)
      .set({ deleted_at: null, status: row.status })
      .where(
        and(
          eq(kilo_pass_scheduled_changes.id, row.id),
          eq(kilo_pass_scheduled_changes.status, KiloPassScheduledChangeStatus.Released)
        )
      );

    await appendKiloPassAuditLog(dbOrTx, {
      action: KiloPassAuditLogAction.StripeWebhookReceived,
      result: KiloPassAuditLogResult.Failed,
      kiloUserId: row.kilo_user_id,
      stripeEventId: stripeEventId ?? null,
      stripeSubscriptionId: row.stripe_subscription_id,
      payload: {
        scope: 'kilo_pass_scheduled_change',
        type: 'subscription_schedule.release',
        scheduledChangeId: row.id,
        scheduleId: row.stripe_schedule_id,
        scheduleStatus: row.status,
        reason,
        error: error instanceof Error ? error.message : String(error),
        providerStatus,
        providerStateError:
          providerStateError instanceof Error
            ? providerStateError.message
            : providerStateError
              ? String(providerStateError)
              : null,
      },
    });

    throw error;
  }

  await appendKiloPassAuditLog(dbOrTx, {
    action: KiloPassAuditLogAction.StripeWebhookReceived,
    result: KiloPassAuditLogResult.Success,
    kiloUserId: row.kilo_user_id,
    stripeEventId: stripeEventId ?? null,
    stripeSubscriptionId: row.stripe_subscription_id,
    payload: {
      scope: 'kilo_pass_scheduled_change',
      type: 'subscription_schedule.release',
      scheduledChangeId: row.id,
      scheduleId: row.stripe_schedule_id,
      scheduleStatus: row.status,
      reason,
    },
  });
}
