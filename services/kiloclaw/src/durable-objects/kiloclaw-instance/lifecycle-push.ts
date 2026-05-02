/**
 * Helpers for dispatching mobile lifecycle push notifications from the
 * KiloClawInstance DO via the NOTIFICATIONS service binding.
 *
 * Two events are supported:
 *  - `ready`         — first low-load checkin has reported the instance is up
 *  - `start_failed`  — a starting attempt timed out or the machine failed
 *
 * Each dispatch is gated by a DO-persisted flag so the network call only
 * fires once per provision lifecycle (ready) or per start attempt (failure).
 */

import { getWorkerDb } from '@kilocode/db/client';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

import type { KiloClawEnv } from '../../types';
import type { InstanceMutableState } from './types';
import { storageUpdate } from './state';
import { doLog, doWarn, toLoggable } from './log';
import type {
  SendInstanceLifecycleNotificationParams,
  SendInstanceLifecycleNotificationResult,
} from '../../notifications-binding';

/**
 * Reset shape for the lifecycle notification flags. Spread this into storage
 * updates / mutable-state factories so the flag set never drifts apart across
 * the provision, wipe, and create-from-scratch code paths.
 */
export const LIFECYCLE_NOTIFICATION_RESET = {
  instanceReadyEmailSent: false,
  startFailurePushSentForAttempt: false,
} as const;

export type StartFailureLabel =
  | 'starting_timeout'
  | 'starting_timeout_with_machine'
  | 'starting_machine_gone'
  | 'starting_timeout_transient_error'
  | 'fly_failed_state';

const START_FAILURE_BODIES: Record<StartFailureLabel, string> = {
  starting_timeout: 'Setup is taking longer than expected.',
  starting_timeout_with_machine: "The machine didn't finish booting in time.",
  starting_machine_gone: 'The machine went missing during start.',
  starting_timeout_transient_error: 'Start failed due to a temporary error.',
  fly_failed_state: 'The machine entered a failed state.',
};

const GENERIC_START_FAILURE_BODY = 'Start failed.';

function logLifecyclePushResult(
  state: InstanceMutableState,
  message: string,
  result: SendInstanceLifecycleNotificationResult,
  details: Record<string, unknown>
): void {
  const baseDetails = {
    ...details,
    tokenCount: result.tokenCount,
    sent: result.sent,
    staleTokens: result.staleTokens,
    receiptCount: result.receiptCount,
    ticketErrors: result.ticketErrors.total,
    retryableTicketErrors: result.ticketErrors.retryable,
    terminalTicketErrors: result.ticketErrors.terminal,
  };

  if (result.ticketErrors.total > 0) {
    doWarn(state, `${message} with ticket errors`, baseDetails);
    return;
  }

  doLog(state, message, baseDetails);
}

/**
 * Map a reconcile failure label to a short user-facing sentence. Unknown
 * labels fall back to a generic sentence so new failure reasons added in
 * reconcile.ts don't regress the push.
 */
export function formatStartFailureReason(label: string): string {
  return START_FAILURE_BODIES[label as StartFailureLabel] ?? GENERIC_START_FAILURE_BODY;
}

/**
 * Best-effort Postgres lookup of the instance display name. Returns null on
 * any failure (missing Hyperdrive, row missing, network error) — the caller
 * still dispatches the push, just with a fallback title.
 */
async function lookupInstanceName(
  env: KiloClawEnv,
  state: InstanceMutableState
): Promise<string | null> {
  if (!state.sandboxId) return null;
  if (!env.HYPERDRIVE?.connectionString) return null;

  try {
    const db = getWorkerDb(env.HYPERDRIVE.connectionString);
    const [row] = await db
      .select({ name: kiloclaw_instances.name })
      .from(kiloclaw_instances)
      .where(
        and(
          eq(kiloclaw_instances.sandbox_id, state.sandboxId),
          isNull(kiloclaw_instances.destroyed_at)
        )
      )
      .limit(1);
    return row?.name ?? null;
  } catch (err) {
    doWarn(state, 'lookupInstanceName failed (non-fatal)', {
      error: toLoggable(err),
    });
    return null;
  }
}

/**
 * Dispatch the one-shot "instance ready" push. The caller (tryMarkInstanceReady)
 * is responsible for the flag check-and-set; this helper only performs the
 * outbound dispatch. Safe to invoke via `ctx.waitUntil` so the originating
 * checkin response isn't blocked on the notifications RPC.
 */
export async function dispatchReadyPush(
  env: KiloClawEnv,
  state: InstanceMutableState
): Promise<void> {
  if (!state.userId || !state.sandboxId || !env.NOTIFICATIONS) return;

  const instanceName = await lookupInstanceName(env, state);

  try {
    const payload = {
      userId: state.userId,
      sandboxId: state.sandboxId,
      event: 'ready',
      instanceName,
    } satisfies SendInstanceLifecycleNotificationParams;
    const result = await env.NOTIFICATIONS.sendInstanceLifecycleNotification(payload);
    logLifecyclePushResult(state, 'ready push dispatch completed', result, {
      event: 'ready',
      sandboxId: state.sandboxId,
    });
  } catch (err) {
    doWarn(state, 'ready push dispatch failed (non-fatal)', {
      error: toLoggable(err),
    });
  }
}

/**
 * Dispatch a one-shot "start failed" push for the current start attempt.
 * Called right after `emitStartFailedEvent` in reconcile.ts; re-armed by
 * `startAsync()`.
 */
export async function maybeDispatchStartFailurePush(
  env: KiloClawEnv,
  state: InstanceMutableState,
  ctx: DurableObjectState,
  label: string,
  errorMessage: string | null | undefined
): Promise<void> {
  if (state.startFailurePushSentForAttempt) return;
  if (!state.userId || !state.sandboxId) return;
  if (!env.NOTIFICATIONS) return;

  state.startFailurePushSentForAttempt = true;
  await ctx.storage.put(storageUpdate({ startFailurePushSentForAttempt: true }));

  const instanceName = await lookupInstanceName(env, state);
  const errorText = formatStartFailureReason(label);

  try {
    const payload = {
      userId: state.userId,
      sandboxId: state.sandboxId,
      event: 'start_failed',
      instanceName,
      errorMessage: errorText,
    } satisfies SendInstanceLifecycleNotificationParams;
    const result = await env.NOTIFICATIONS.sendInstanceLifecycleNotification(payload);
    logLifecyclePushResult(state, 'start failure push dispatch completed', result, {
      event: 'start_failed',
      sandboxId: state.sandboxId,
      label,
    });
  } catch (err) {
    doWarn(state, 'start failure push dispatch failed (non-fatal)', {
      error: toLoggable(err),
      label,
      upstreamError: errorMessage ?? null,
    });
  }
}
