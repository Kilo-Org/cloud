/**
 * Helpers for dispatching mobile lifecycle push notifications from the
 * KiloClawInstance DO via the NOTIFICATIONS service binding.
 *
 * Two events are supported:
 *  - `ready`         — OpenClaw gateway is accepting requests
 *  - `start_failed`  — a starting attempt timed out or the machine failed
 *
 * Each dispatch is gated by a DO-persisted flag so the network call only
 * fires once per provision lifecycle (ready) or per start attempt (failure).
 */

import { getWorkerDb } from '@kilocode/db/client';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

import { READY_PUSH_PROBE_WINDOW_MS } from '../config';
import type { KiloClawEnv } from '../types';
import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';
import { storageUpdate } from '../durable-objects/kiloclaw-instance/state';
import { doWarn, toLoggable } from '../durable-objects/kiloclaw-instance/log';
import * as gateway from '../durable-objects/kiloclaw-instance/gateway';

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

/**
 * Map a reconcile failure label to a short user-facing sentence. Unknown
 * labels fall back to a generic sentence so new failure reasons added in
 * reconcile.ts don't regress the push.
 */
export function formatStartFailureReason(label: string): string {
  return START_FAILURE_BODIES[label as StartFailureLabel] ?? GENERIC_START_FAILURE_BODY;
}

/** True while the DO should keep polling `getGatewayReady` for the ready-push dispatch. */
export function readyPushProbeActive(state: InstanceMutableState, now = Date.now()): boolean {
  if (state.instanceReadyPushSent) return false;
  if (state.status !== 'starting' && state.status !== 'running') return false;
  const windowStart = state.lastStartedAt ?? state.startingAt;
  if (windowStart === null) return false;
  return now - windowStart < READY_PUSH_PROBE_WINDOW_MS;
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
 * Dispatch a one-shot "instance ready" push when `getGatewayReady` first
 * reports the gateway is serving. Flips the DO flag before the outbound
 * RPC so a crash mid-dispatch cannot cause a duplicate on the next alarm.
 */
export async function maybeDispatchReadyPush(
  env: KiloClawEnv,
  state: InstanceMutableState,
  ctx: DurableObjectState
): Promise<void> {
  if (!readyPushProbeActive(state)) return;

  let result: Record<string, unknown> | null;
  try {
    result = await gateway.getGatewayReady(state, env);
  } catch (err) {
    doWarn(state, 'ready push probe failed (non-fatal)', {
      error: toLoggable(err),
    });
    return;
  }
  if (!result || result.ready !== true) return;

  // Check dispatch preconditions before burning the one-shot flag. If the
  // NOTIFICATIONS binding is briefly unavailable (e.g., mid-deploy) or the
  // instance somehow lacks a userId/sandboxId, leave the flag unset so a
  // later alarm can retry once conditions are met.
  if (!state.userId || !state.sandboxId || !env.NOTIFICATIONS) return;

  state.instanceReadyPushSent = true;
  await ctx.storage.put(storageUpdate({ instanceReadyPushSent: true }));

  const instanceName = await lookupInstanceName(env, state);

  try {
    await env.NOTIFICATIONS.sendInstanceLifecycleNotification({
      userId: state.userId,
      instanceId: state.sandboxId,
      sandboxId: state.sandboxId,
      event: 'ready',
      instanceName,
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
    await env.NOTIFICATIONS.sendInstanceLifecycleNotification({
      userId: state.userId,
      instanceId: state.sandboxId,
      sandboxId: state.sandboxId,
      event: 'start_failed',
      instanceName,
      errorMessage: errorText,
    });
  } catch (err) {
    doWarn(state, 'start failure push dispatch failed (non-fatal)', {
      error: toLoggable(err),
      label,
      upstreamError: errorMessage ?? null,
    });
  }
}
