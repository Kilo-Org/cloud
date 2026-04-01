import 'server-only';

import { eq, and, isNull, inArray } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
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

/**
 * If the subscription was suspended, try to start the instance and clear suspension state.
 *
 * When instanceId is provided, the update is scoped to that specific subscription row.
 * When omitted, the function falls back to looking up the user's active instance and
 * clearing suspension state on all rows for the user (legacy single-instance path).
 *
 * Extracted into its own module to avoid a circular dependency between
 * stripe-handlers.ts and credit-billing.ts — both need this function.
 */
export async function autoResumeIfSuspended(
  kiloUserId: string,
  instanceId?: string
): Promise<void> {
  // Resolve the instance to start. When instanceId is given, verify it exists
  // and isn't destroyed. Otherwise fall back to the user's active instance.
  const instanceFilter = instanceId
    ? and(
        eq(kiloclaw_instances.id, instanceId),
        eq(kiloclaw_instances.user_id, kiloUserId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    : and(eq(kiloclaw_instances.user_id, kiloUserId), isNull(kiloclaw_instances.destroyed_at));

  const [targetInstance] = await db
    .select({ id: kiloclaw_instances.id, sandbox_id: kiloclaw_instances.sandbox_id })
    .from(kiloclaw_instances)
    .where(instanceFilter)
    .limit(1);

  if (targetInstance) {
    try {
      const client = new KiloClawInternalClient();
      await client.start(kiloUserId, workerInstanceId(targetInstance));
    } catch (startError) {
      logError('Failed to auto-resume instance', {
        user_id: kiloUserId,
        instance_id: targetInstance.id,
        error: startError instanceof Error ? startError.message : String(startError),
      });
      // Preserve suspension state so the interrupted-auto-resume retry
      // sweep can pick up this row on the next cron run.
      return;
    }
  }

  // Clear suspension/destruction cycle emails so they can fire again in a future cycle.
  // Trial and earlybird warnings are one-time events and must NOT be cleared.
  const resettableEmailTypes = [
    'claw_suspended_trial',
    'claw_suspended_subscription',
    'claw_suspended_payment',
    'claw_destruction_warning',
    'claw_instance_destroyed',
    'claw_credit_renewal_failed',
  ];
  await db
    .delete(kiloclaw_email_log)
    .where(
      and(
        eq(kiloclaw_email_log.user_id, kiloUserId),
        inArray(kiloclaw_email_log.email_type, resettableEmailTypes)
      )
    );

  // Scope the subscription update to the specific instance when known,
  // so resuming one instance doesn't clear suspension on an unrelated row.
  const subscriptionFilter = instanceId
    ? and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.instance_id, instanceId)
      )
    : eq(kiloclaw_subscriptions.user_id, kiloUserId);

  await db
    .update(kiloclaw_subscriptions)
    .set({ suspended_at: null, destruction_deadline: null })
    .where(subscriptionFilter);

  logInfo('Auto-resume completed', {
    user_id: kiloUserId,
    instance_id: instanceId ?? null,
    had_active_instance: !!targetInstance,
  });
}
