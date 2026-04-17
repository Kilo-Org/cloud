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

const logInfo = sentryLogger('kiloclaw-instance-lifecycle', 'info');
const logError = sentryLogger('kiloclaw-instance-lifecycle', 'error');
const AUTO_RESUME_INITIAL_BACKOFF_MS = 2 * 60 * 60 * 1000;
const AUTO_RESUME_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const INSTANCE_LIFECYCLE_ACTOR = {
  actorType: 'system',
  actorId: 'web-instance-lifecycle',
} as const;

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

async function clearAutoResumeState(
  kiloUserId: string,
  options: {
    instanceId?: string;
    sandboxId?: string;
    logMessage: string;
    changeLogReason: string;
    logFields?: Record<string, unknown>;
  }
): Promise<void> {
  const subscriptionFilter = subscriptionFilterForUser(kiloUserId, options.instanceId);

  await db.transaction(async tx => {
    const subscriptions = await tx.select().from(kiloclaw_subscriptions).where(subscriptionFilter);

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
      .where(subscriptionFilter);

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

  logInfo(options.logMessage, {
    user_id: kiloUserId,
    instance_id: options.instanceId ?? null,
    ...(options.sandboxId ? { sandbox_id: options.sandboxId } : {}),
    ...(options.logFields ?? {}),
  });
}

async function resolveActiveInstance(
  kiloUserId: string,
  options: { instanceId?: string; sandboxId?: string }
): Promise<ActiveInstance | null> {
  const instanceFilter = options.instanceId
    ? and(
        eq(kiloclaw_instances.id, options.instanceId),
        eq(kiloclaw_instances.user_id, kiloUserId),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      )
    : options.sandboxId
      ? and(
          eq(kiloclaw_instances.user_id, kiloUserId),
          eq(kiloclaw_instances.sandbox_id, options.sandboxId),
          isNull(kiloclaw_instances.organization_id),
          isNull(kiloclaw_instances.destroyed_at)
        )
      : and(
          eq(kiloclaw_instances.user_id, kiloUserId),
          isNull(kiloclaw_instances.organization_id),
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
  instanceId?: string
): Promise<void> {
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
    await client.startAsync(kiloUserId, workerInstanceId(targetInstance));
  } catch (startError) {
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
    logError('Failed to request async auto-resume', {
      user_id: kiloUserId,
      instance_id: targetInstance.id,
      retry_after: retryAfterIso,
      auto_resume_attempt_count: nextAttemptCount,
      error: startError instanceof Error ? startError.message : String(startError),
    });
    return;
  }

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
  const targetInstance = await resolveActiveInstance(kiloUserId, { instanceId, sandboxId });
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

  const hadPendingResume = !!(
    subscription?.suspended_at ||
    subscription?.auto_resume_requested_at ||
    subscription?.auto_resume_retry_after ||
    (subscription?.auto_resume_attempt_count ?? 0) > 0
  );

  if (!hadPendingResume) {
    logInfo('Instance ready without pending async auto-resume state', {
      user_id: kiloUserId,
      instance_id: targetInstance.id,
      sandbox_id: sandboxId,
    });
    return { instanceId: targetInstance.id, resumeCompleted: false };
  }

  await clearAutoResumeState(kiloUserId, {
    instanceId: targetInstance.id,
    sandboxId,
    logMessage: 'Async auto-resume completed',
    changeLogReason: 'auto_resume_completed',
  });
  return { instanceId: targetInstance.id, resumeCompleted: true };
}
