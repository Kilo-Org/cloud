import 'server-only';

import { eq, and, isNull, inArray } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_email_log,
} from '@kilocode/db/schema';
import { sentryLogger } from '@/lib/utils.server';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { workerInstanceId } from '@/lib/kiloclaw/instance-registry';
import { resolveCurrentPersonalSubscriptionRow } from '@/lib/kiloclaw/current-personal-subscription';

const logInfo = sentryLogger('kiloclaw-instance-lifecycle', 'info');
const logError = sentryLogger('kiloclaw-instance-lifecycle', 'error');
const AUTO_RESUME_INITIAL_BACKOFF_MS = 2 * 60 * 60 * 1000;
const AUTO_RESUME_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const INSTANCE_LIFECYCLE_ACTOR = {
  actorType: 'system',
  actorId: 'web-instance-lifecycle',
} as const;
const INSTANCE_DESTROYED_REASON = 'instance_destroyed';

type ActiveInstance = {
  id: string;
  sandbox_id: string;
};

function getAutoResumeBackoffMs(consecutiveAttemptCount: number): number {
  const multiplier = consecutiveAttemptCount <= 0 ? 1 : 2 ** consecutiveAttemptCount;
  return Math.min(AUTO_RESUME_MAX_BACKOFF_MS, AUTO_RESUME_INITIAL_BACKOFF_MS * multiplier);
}

function getResettableAutoResumeEmailTypes() {
  return [
    'claw_suspended_trial',
    'claw_suspended_subscription',
    'claw_suspended_payment',
    'claw_destruction_warning',
    'claw_instance_destroyed',
    'claw_credit_renewal_failed',
  ] as const;
}

function emailLogTypeFilter(
  kiloUserId: string,
  emailTypes: readonly string[],
  instanceId?: string
) {
  return and(
    eq(kiloclaw_email_log.user_id, kiloUserId),
    inArray(kiloclaw_email_log.email_type, [...emailTypes]),
    instanceId
      ? eq(kiloclaw_email_log.instance_id, instanceId)
      : isNull(kiloclaw_email_log.instance_id)
  );
}

function subscriptionFilterForUser(kiloUserId: string, instanceId?: string) {
  return instanceId
    ? and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.instance_id, instanceId),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
      )
    : and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
      );
}

export async function clearSubscriptionLifecycleAfterInstanceDestroy(params: {
  actorUserId: string;
  kiloUserId: string;
  instanceId: string;
}): Promise<void> {
  await db.transaction(async tx => {
    const [subscription] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(subscriptionFilterForUser(params.kiloUserId, params.instanceId))
      .limit(1);

    if (!subscription) {
      return;
    }

    const clearFields: { destruction_deadline: null; suspended_at?: null } = {
      destruction_deadline: null,
    };

    if (subscription.status !== 'past_due') {
      clearFields.suspended_at = null;
    }

    const [updatedSubscription] = await tx
      .update(kiloclaw_subscriptions)
      .set(clearFields)
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .returning();

    const clearedSuspension =
      subscription.destruction_deadline !== null ||
      (subscription.status !== 'past_due' && subscription.suspended_at !== null);

    if (!updatedSubscription || !clearedSuspension) {
      return;
    }

    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: subscription.id,
      actor: {
        actorType: 'user',
        actorId: params.actorUserId,
      },
      action: 'status_changed',
      reason: INSTANCE_DESTROYED_REASON,
      before: subscription,
      after: updatedSubscription,
    });
  });
}

async function clearAutoResumeState(
  kiloUserId: string,
  options: {
    instanceId?: string;
    sandboxId?: string;
    logMessage: string;
    changeLogReason: string;
    logFields?: Record<string, unknown>;
    /**
     * When set, the transactional clear is gated on the subscription still
     * being in `status='active'` at lock time. Used by the genuine
     * auto-resume completion path to close a TOCTOU window: the
     * subscription status read in `completeAutoResumeIfReady` happens
     * outside this transaction, and a concurrent transition (credit-renewal
     * sweep flipping back to past_due, user cancellation, subscription
     * expiry) between the precondition and this transaction would
     * otherwise still wipe the email-log dedupe state and suspension
     * fields. Skipping the entire mutation when no active row is locked
     * keeps the once-per-lifecycle email-notification guarantee
     * (.specs/kiloclaw-billing.md §1118.1).
     */
    requireActiveSubscription?: boolean;
  }
): Promise<{ skippedNoActiveSubscription: boolean }> {
  const subscriptionFilter = subscriptionFilterForUser(kiloUserId, options.instanceId);
  const activeSubscriptionFilter = and(
    subscriptionFilter,
    eq(kiloclaw_subscriptions.status, 'active')
  );
  let skippedNoActiveSubscription = false;

  await db.transaction(async tx => {
    // FOR UPDATE row-locks the candidate subscriptions for the duration of
    // the transaction. When `requireActiveSubscription` is set, any
    // concurrent writer that flips status away from 'active' has either
    // already committed (we won't see/lock the row) or will block on our
    // lock until we commit. Either way the subsequent email-log delete and
    // subscription update operate on a snapshot we know was 'active' at
    // lock time.
    const subscriptions = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(options.requireActiveSubscription ? activeSubscriptionFilter : subscriptionFilter)
      .for('update');

    if (options.requireActiveSubscription && subscriptions.length === 0) {
      // The precondition saw status='active' but a concurrent transition
      // committed before our lock acquired. Bail without touching any
      // dedupe state. The next ready callback (or sweep) will re-evaluate.
      skippedNoActiveSubscription = true;
      return;
    }

    await tx
      .delete(kiloclaw_email_log)
      .where(
        emailLogTypeFilter(kiloUserId, getResettableAutoResumeEmailTypes(), options.instanceId)
      );

    await tx
      .update(kiloclaw_subscriptions)
      .set({
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_requested_at: null,
        auto_resume_retry_after: null,
        auto_resume_attempt_count: 0,
      })
      .where(options.requireActiveSubscription ? activeSubscriptionFilter : subscriptionFilter);

    for (const subscription of subscriptions) {
      const clearedSuspension =
        subscription.suspended_at !== null || subscription.destruction_deadline !== null;
      if (!clearedSuspension) {
        continue;
      }

      await insertKiloClawSubscriptionChangeLog(tx, {
        subscriptionId: subscription.id,
        actor: INSTANCE_LIFECYCLE_ACTOR,
        action: 'reactivated',
        reason: options.changeLogReason,
        before: subscription,
        after: {
          ...subscription,
          suspended_at: null,
          destruction_deadline: null,
          auto_resume_requested_at: null,
          auto_resume_retry_after: null,
          auto_resume_attempt_count: 0,
        },
      });
    }
  });

  if (skippedNoActiveSubscription) {
    logInfo('Auto-resume completion skipped: subscription not active at lock time', {
      user_id: kiloUserId,
      instance_id: options.instanceId ?? null,
      ...(options.sandboxId ? { sandbox_id: options.sandboxId } : {}),
      ...(options.logFields ?? {}),
    });
    return { skippedNoActiveSubscription: true };
  }

  logInfo(options.logMessage, {
    user_id: kiloUserId,
    instance_id: options.instanceId ?? null,
    ...(options.sandboxId ? { sandbox_id: options.sandboxId } : {}),
    ...(options.logFields ?? {}),
  });
  return { skippedNoActiveSubscription: false };
}

async function resolveActiveInstance(
  kiloUserId: string,
  options: { allowOrganization?: boolean; instanceId?: string; sandboxId?: string }
): Promise<ActiveInstance | null> {
  const organizationFilter = options.allowOrganization
    ? undefined
    : isNull(kiloclaw_instances.organization_id);
  const instanceFilter = options.instanceId
    ? and(
        eq(kiloclaw_instances.id, options.instanceId),
        eq(kiloclaw_instances.user_id, kiloUserId),
        organizationFilter,
        isNull(kiloclaw_instances.destroyed_at)
      )
    : options.sandboxId
      ? and(
          eq(kiloclaw_instances.user_id, kiloUserId),
          eq(kiloclaw_instances.sandbox_id, options.sandboxId),
          organizationFilter,
          isNull(kiloclaw_instances.destroyed_at)
        )
      : and(
          eq(kiloclaw_instances.user_id, kiloUserId),
          organizationFilter,
          isNull(kiloclaw_instances.destroyed_at)
        );

  const [targetInstance] = await db
    .select({ id: kiloclaw_instances.id, sandbox_id: kiloclaw_instances.sandbox_id })
    .from(kiloclaw_instances)
    .where(instanceFilter)
    .limit(1);

  return targetInstance ?? null;
}

/**
 * If the subscription was suspended, request an async instance start and record
 * retry metadata. Suspension is only cleared later, once instance-ready fires.
 *
 * Extracted into its own module to avoid a circular dependency between
 * stripe-handlers.ts and credit-billing.ts — both need this function.
 */
export async function autoResumeIfSuspended(
  kiloUserId: string,
  instanceId?: string,
  options: { recordRetryState?: boolean } = {}
): Promise<void> {
  const recordRetryState = options.recordRetryState ?? true;
  const targetInstance = await resolveActiveInstance(kiloUserId, { instanceId });
  if (!targetInstance) {
    await clearAutoResumeState(kiloUserId, {
      instanceId,
      logMessage: 'Cleared auto-resume state because no active instance remains',
      changeLogReason: 'auto_resume_aborted_no_active_instance',
      logFields: { recovery_reason: 'no_active_instance' },
    });
    return;
  }

  const [subscription] = await db
    .select({ auto_resume_attempt_count: kiloclaw_subscriptions.auto_resume_attempt_count })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.instance_id, targetInstance.id),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
      )
    )
    .limit(1);

  const nextAttemptCount = (subscription?.auto_resume_attempt_count ?? 0) + 1;
  const requestedAtIso = new Date().toISOString();
  const retryAfterIso = new Date(
    Date.now() + getAutoResumeBackoffMs(subscription?.auto_resume_attempt_count ?? 0)
  ).toISOString();

  try {
    const client = new KiloClawInternalClient();
    await client.startAsync(kiloUserId, workerInstanceId(targetInstance), {
      reason: 'interrupted_auto_resume',
    });
  } catch (startError) {
    if (recordRetryState) {
      await db
        .update(kiloclaw_subscriptions)
        .set({
          auto_resume_requested_at: requestedAtIso,
          auto_resume_retry_after: retryAfterIso,
          auto_resume_attempt_count: nextAttemptCount,
        })
        .where(
          and(
            eq(kiloclaw_subscriptions.user_id, kiloUserId),
            eq(kiloclaw_subscriptions.instance_id, targetInstance.id),
            isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
          )
        );
    }
    logError('Failed to request async auto-resume', {
      user_id: kiloUserId,
      instance_id: targetInstance.id,
      retry_after: retryAfterIso,
      auto_resume_attempt_count: nextAttemptCount,
      error: startError instanceof Error ? startError.message : String(startError),
    });
    return;
  }

  if (recordRetryState) {
    await db
      .update(kiloclaw_subscriptions)
      .set({
        auto_resume_requested_at: requestedAtIso,
        auto_resume_retry_after: retryAfterIso,
        auto_resume_attempt_count: nextAttemptCount,
      })
      .where(
        and(
          eq(kiloclaw_subscriptions.user_id, kiloUserId),
          eq(kiloclaw_subscriptions.instance_id, targetInstance.id),
          isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
        )
      );
  }

  logInfo('Async auto-resume requested', {
    user_id: kiloUserId,
    instance_id: targetInstance.id,
    retry_after: retryAfterIso,
    auto_resume_attempt_count: nextAttemptCount,
  });
}

export async function completeAutoResumeIfReady(
  kiloUserId: string,
  sandboxId: string,
  instanceId?: string
): Promise<{ instanceId: string | null; resumeCompleted: boolean }> {
  const targetInstance = await resolveActiveInstance(kiloUserId, {
    allowOrganization: true,
    instanceId,
    sandboxId,
  });
  if (!targetInstance) {
    await clearAutoResumeState(kiloUserId, {
      instanceId,
      sandboxId,
      logMessage: 'Cleared auto-resume state because readiness callback found no active instance',
      changeLogReason: 'auto_resume_ready_without_active_instance',
      logFields: { recovery_reason: 'ready_without_active_instance' },
    });
    return { instanceId: instanceId ?? null, resumeCompleted: true };
  }

  const [subscription] = await db
    .select({
      status: kiloclaw_subscriptions.status,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      auto_resume_requested_at: kiloclaw_subscriptions.auto_resume_requested_at,
      auto_resume_retry_after: kiloclaw_subscriptions.auto_resume_retry_after,
      auto_resume_attempt_count: kiloclaw_subscriptions.auto_resume_attempt_count,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.instance_id, targetInstance.id),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
      )
    )
    .limit(1);

  // Per .specs/kiloclaw-billing.md §1132 (Auto-Resume on Payment Recovery),
  // auto-resume completion fires when a subscription "transitions to active
  // while the subscription's instance is suspended". A canceled or past_due
  // subscription has not transitioned to active and MUST NOT have its
  // suspension state cleared by a stale instance-ready callback — otherwise
  // a Fly-Proxy-driven wakeup of a stopped machine would silently delete
  // the once-per-lifecycle email-log entries (§1118.1) and re-enable the
  // hourly subscription-expiry sweep to send another suspension email.
  const hasPendingResumeState = !!(
    subscription?.suspended_at ||
    subscription?.auto_resume_requested_at ||
    subscription?.auto_resume_retry_after ||
    (subscription?.auto_resume_attempt_count ?? 0) > 0
  );
  const isPendingResume = subscription?.status === 'active' && hasPendingResumeState;

  if (!isPendingResume) {
    logInfo('Instance ready without pending async auto-resume state', {
      user_id: kiloUserId,
      instance_id: targetInstance.id,
      sandbox_id: sandboxId,
      subscription_status: subscription?.status ?? null,
      has_suspended_at: subscription?.suspended_at != null,
    });
    return { instanceId: targetInstance.id, resumeCompleted: false };
  }

  const { skippedNoActiveSubscription } = await clearAutoResumeState(kiloUserId, {
    instanceId: targetInstance.id,
    sandboxId,
    logMessage: 'Async auto-resume completed',
    changeLogReason: 'auto_resume_completed',
    // Gate the transactional clear on the subscription still being active
    // at lock time. The precondition above is racy by itself: a concurrent
    // transition to past_due/canceled between the read and the transaction
    // would otherwise still wipe the email-log dedupe row and reopen the
    // duplicate-suspension-email loop.
    requireActiveSubscription: true,
  });
  // When the in-transaction lock found no active subscription, no clear
  // happened. Surface that to the caller so the instance-ready endpoint's
  // "Completed async auto-resume" log line doesn't claim a non-completion
  // and operators get accurate signal on race frequency.
  return {
    instanceId: targetInstance.id,
    resumeCompleted: !skippedNoActiveSubscription,
  };
}

async function clearInactiveTrialStopMarkerForPersonalInstance(params: {
  kiloUserId: string;
  instanceId: string;
  logMessage: string;
}): Promise<boolean> {
  const [updatedInstance] = await db
    .update(kiloclaw_instances)
    .set({ inactive_trial_stopped_at: null })
    .where(
      and(
        eq(kiloclaw_instances.id, params.instanceId),
        eq(kiloclaw_instances.user_id, params.kiloUserId),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .returning({ id: kiloclaw_instances.id });

  if (!updatedInstance) {
    return false;
  }

  logInfo(params.logMessage, {
    user_id: params.kiloUserId,
    instance_id: params.instanceId,
  });
  return true;
}

export async function clearTrialInactivityStopAfterStart(params: {
  kiloUserId: string;
  instanceId: string;
}): Promise<boolean> {
  const currentSubscriptionRow = await resolveCurrentPersonalSubscriptionRow({
    userId: params.kiloUserId,
    instanceId: params.instanceId,
  });

  if (!currentSubscriptionRow?.instance || currentSubscriptionRow.instance.destroyedAt !== null) {
    return false;
  }

  if (
    currentSubscriptionRow.subscription.plan !== 'trial' ||
    currentSubscriptionRow.subscription.status !== 'trialing'
  ) {
    return false;
  }

  return await clearInactiveTrialStopMarkerForPersonalInstance({
    ...params,
    logMessage: 'Cleared trial inactivity stop marker after explicit start',
  });
}

export async function clearTrialInactivityStopAfterTrialTransition(params: {
  kiloUserId: string;
  instanceId: string;
}): Promise<boolean> {
  return await clearInactiveTrialStopMarkerForPersonalInstance({
    ...params,
    logMessage: 'Cleared trial inactivity stop marker after trial transition',
  });
}
