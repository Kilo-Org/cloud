import type { KiloClawEnv } from '../../types';
import type { FlyClientConfig } from '../../fly/client';
import type { FlyMachineConfig, FlyVolume } from '../../fly/types';
import type { PersistedState } from '../../schemas/instance-config';
import * as fly from '../../fly/client';
import {
  SELF_HEAL_THRESHOLD,
  STARTUP_TIMEOUT_SECONDS,
  STARTING_TIMEOUT_MS,
  RESTARTING_TIMEOUT_MS,
  RESTARTING_MAX_TIMEOUT_MS,
  RECOVERING_TIMEOUT_MS,
  WORKER_CONTROLLER_CAPABILITIES_VERSION,
  DESTROY_STUCK_THRESHOLD_MS,
  DESTROY_STUCK_TELEMETRY_INTERVAL_MS,
  getProactiveRefreshThresholdMs,
} from '../../config';
import { resolveInstanceTypeLabel } from '@kilocode/kiloclaw-instance-tiers';
import { ENCRYPTED_ENV_PREFIX, encryptEnvValue } from '../../utils/env-encryption';
import {
  METADATA_RECOVERY_COOLDOWN_MS,
  BOUND_MACHINE_RECOVERY_COOLDOWN_MS,
  TERMINAL_STOPPED_STATES,
  selectRecoveryCandidate,
  volumeIdFromMachine,
} from '../machine-recovery';
import {
  METADATA_KEY_USER_ID,
  METADATA_KEY_SANDBOX_ID,
  parseMachineSizeFromFlyGuest,
  volumeNameFromSandboxId,
} from '../machine-config';
import type { InstanceMutableState, DestroyResult } from './types';
import { getAppKey } from './types';
import {
  applyProviderState,
  getFlyProviderState,
  resetMutableState,
  storageUpdate,
  syncProviderStateForStorage,
} from './state';
import { doError, doWarn, toLoggable, createReconcileContext } from './log';
import type { ReconcileContext } from './log';
import { ensureVolume, staleProvisionAgeMs } from './fly-machines';
import { syncInstanceTypeToPostgresHelper } from './postgres';
import { mintFreshApiKey } from './config';
import * as gateway from './gateway';
import { writeEvent, eventContextFromState } from '../../utils/analytics';
import { maybeDispatchStartFailurePush } from './lifecycle-push';

export type FinalizeDestroyRetention = {
  entries: Record<string, unknown>;
  retryAlarmAt: number;
};

export type ReconcileWithFlyResult = {
  beginUnexpectedStopRecovery?: {
    flyState: 'stopped';
    failCount: number;
  };
  completeUnexpectedStopRecovery?: true;
  failedUnexpectedStopRecovery?: {
    errorMessage: string;
    label: string;
  };
  timedOutUnexpectedStopRecovery?: {
    errorMessage: string;
    durationMs?: number;
  };
};

function pendingDestroyLabel(state: InstanceMutableState): string {
  if (state.pendingDestroyMachineId && state.pendingDestroyVolumeId) return 'machine+volume';
  if (state.pendingDestroyMachineId) return 'machine';
  if (state.pendingDestroyVolumeId) return 'volume';
  return 'none';
}

function destroyPendingDetails(
  state: InstanceMutableState,
  now = Date.now()
): Record<string, unknown> {
  const ageMs = state.destroyStartedAt ? now - state.destroyStartedAt : 0;
  return {
    label: pendingDestroyLabel(state),
    value: ageMs,
    pendingMachineId: state.pendingDestroyMachineId,
    pendingVolumeId: state.pendingDestroyVolumeId,
    destroyStartedAt: state.destroyStartedAt,
    lastDestroyErrorOp: state.lastDestroyErrorOp,
    lastDestroyErrorStatus: state.lastDestroyErrorStatus,
    lastDestroyErrorAt: state.lastDestroyErrorAt,
  };
}

export function destroyResultFromState(
  state: InstanceMutableState,
  result: Pick<DestroyResult, 'finalized' | 'destroyedUserId' | 'destroyedSandboxId'>
): DestroyResult {
  return {
    ...result,
    pendingMachineId: state.pendingDestroyMachineId,
    pendingVolumeId: state.pendingDestroyVolumeId,
    lastDestroyErrorOp: state.lastDestroyErrorOp,
    lastDestroyErrorStatus: state.lastDestroyErrorStatus,
    lastDestroyErrorAt: state.lastDestroyErrorAt,
  };
}

export function emitDestroyPendingTelemetry(
  state: InstanceMutableState,
  rctx: ReconcileContext
): void {
  const details = destroyPendingDetails(state);
  rctx.log('destroy_pending', details);
  doWarn(state, 'Destroy incomplete, alarm will retry', details);
}

export async function maybeEmitDestroyStuckTelemetry(
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<void> {
  if (!state.pendingDestroyMachineId && !state.pendingDestroyVolumeId) return;

  const now = Date.now();
  if (!state.destroyStartedAt) {
    state.destroyStartedAt = state.lastDestroyErrorAt ?? now;
    await ctx.storage.put(storageUpdate({ destroyStartedAt: state.destroyStartedAt }));
  }

  const ageMs = now - state.destroyStartedAt;
  if (ageMs < DESTROY_STUCK_THRESHOLD_MS) return;
  if (
    state.lastDestroyPendingEventAt &&
    now - state.lastDestroyPendingEventAt < DESTROY_STUCK_TELEMETRY_INTERVAL_MS
  ) {
    return;
  }

  const details = destroyPendingDetails(state, now);
  rctx.log('destroy_stuck', details);
  doWarn(state, 'Destroy still pending after repeated retries', details);

  state.lastDestroyPendingEventAt = now;
  await ctx.storage.put(storageUpdate({ lastDestroyPendingEventAt: now }));
}

/**
 * Record a start-attempt failure: write the analytics event and dispatch the
 * one-shot mobile push for this attempt. Single entry point so callers can't
 * accidentally emit one without the other.
 */
async function recordStartFailure(
  env: KiloClawEnv,
  state: InstanceMutableState,
  ctx: DurableObjectState,
  label: string,
  error?: string | null
): Promise<void> {
  writeEvent(env, {
    event: 'instance.provisioning_failed',
    delivery: 'do',
    status: 'stopped',
    label,
    error: error ?? undefined,
    ...eventContextFromState(state),
  });
  await maybeDispatchStartFailurePush(env, state, ctx, label, error);
}

/**
 * Check actual Fly state against DO state and fix drift.
 * Destroying instances only retry pending deletes; never recreate resources.
 */
export async function reconcileWithFly(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  env: KiloClawEnv,
  reason: string,
  /** Callback to trigger a full destroy (calls back into the DO). */
  triggerDestroy: () => Promise<void>,
  /** Callback for marking Postgres row destroyed during finalization. */
  markDestroyedInPostgres?: (userId: string, sandboxId: string) => Promise<boolean>,
  finalizeRetention?: FinalizeDestroyRetention
): Promise<ReconcileWithFlyResult> {
  const rctx = createReconcileContext(state, env, reason);

  if (state.status === 'destroying') {
    await retryPendingDestroy(
      flyConfig,
      ctx,
      state,
      rctx,
      markDestroyedInPostgres,
      finalizeRetention
    );
    return {};
  }

  if (state.status === 'starting') {
    await reconcileStarting(flyConfig, ctx, state, env, rctx);
    return {};
  }

  if (state.status === 'restarting') {
    await reconcileRestarting(flyConfig, ctx, state, env, rctx);
    return {};
  }

  if (state.status === 'recovering') {
    return reconcileRecovering(flyConfig, state, rctx);
  }

  const { reconciled: machineReconciled, result } = await reconcileMachine(
    flyConfig,
    ctx,
    env,
    state,
    rctx
  );

  // Auto-destroy stale provisioned instances
  const staleAge = staleProvisionAgeMs(state);
  if (staleAge !== null && machineReconciled) {
    rctx.log('auto_destroy_stale_provision', {
      user_id: state.userId,
      provisioned_at: state.provisionedAt,
      age_hours: Math.round(staleAge / 3600000),
      value: staleAge,
    });
    state.pendingPostgresMarkOnFinalize = true;
    await ctx.storage.put(storageUpdate({ pendingPostgresMarkOnFinalize: true }));
    await triggerDestroy();
    return {};
  }

  await reconcileVolume(flyConfig, ctx, state, env, rctx);
  await reconcileApiKeyExpiry(flyConfig, ctx, state, env, rctx);
  return result;
}

// ---- API key proactive refresh ----

const MINT_TIMEOUT_MS = 15_000;

async function reconcileApiKeyExpiry(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  env: KiloClawEnv,
  rctx: ReconcileContext
): Promise<void> {
  if (state.status !== 'running' || !state.flyMachineId) return;
  if (!state.kilocodeApiKeyExpiresAt || !state.userId) return;

  const machineId = state.flyMachineId;
  const userId = state.userId;

  const expiresAtMs = Date.parse(state.kilocodeApiKeyExpiresAt);
  if (Number.isNaN(expiresAtMs)) return;

  const timeUntilExpiry = expiresAtMs - Date.now();
  const thresholdMs = getProactiveRefreshThresholdMs(env.PROACTIVE_REFRESH_THRESHOLD_HOURS);
  if (timeUntilExpiry > thresholdMs) return;

  const refreshStart = performance.now();

  // Fetch controller version for observability (best-effort, not used for gating).
  let controllerVersion: string | null = null;
  try {
    const info = await gateway.getControllerVersion(state, env);
    controllerVersion = info?.version ?? null;
  } catch (err) {
    doWarn(state, 'controller version check failed', {
      error: toLoggable(err),
    });
  }

  rctx.log('api_key_expiry_approaching', {
    user_id: userId,
    expires_at: state.kilocodeApiKeyExpiresAt,
    hours_remaining: Math.round(timeUntilExpiry / 3600000),
    controller_version: controllerVersion,
  });

  // 1. Mint fresh key.
  let mintTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let freshKey: { token: string; expiresAt: string } | null = null;
  try {
    freshKey = await Promise.race([
      mintFreshApiKey(env, userId),
      new Promise<never>((_, reject) => {
        mintTimeoutId = setTimeout(() => reject(new Error('mint timeout')), MINT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    rctx.log('api_key_mint_error', {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  } finally {
    clearTimeout(mintTimeoutId);
  }
  if (!freshKey) {
    rctx.log('api_key_mint_failed', { user_id: userId });
    return;
  }

  // 2. Update Fly machine config with the fresh encrypted key.
  //    Always skipLaunch — no forced restart. The key is persisted durably
  //    so the next natural restart (user-initiated, crash, deploy) picks it up.
  //    Pass minSecretsVersion from ensureEnvKey() so Fly waits for the env key
  //    secret to propagate before any subsequent launch.
  let flyConfigUpdated = false;
  try {
    const machine = await fly.getMachine(flyConfig, machineId);
    const updatedEnv = { ...machine.config.env };

    const appKey = getAppKey({ userId, sandboxId: state.sandboxId });
    const appStub = env.KILOCLAW_APP.get(env.KILOCLAW_APP.idFromName(appKey));
    const knownFlyAppName =
      (state.providerState?.provider === 'fly' ? state.providerState.appName : null) ??
      state.flyAppName ??
      undefined;
    const { key: envKey, secretsVersion } = await appStub.ensureEnvKey(appKey, knownFlyAppName);
    updatedEnv[`${ENCRYPTED_ENV_PREFIX}KILOCODE_API_KEY`] = encryptEnvValue(envKey, freshKey.token);

    await fly.updateMachine(
      flyConfig,
      machineId,
      { ...machine.config, env: updatedEnv },
      { skipLaunch: true, minSecretsVersion: secretsVersion }
    );

    flyConfigUpdated = true;
  } catch (err) {
    rctx.log('api_key_fly_config_update_failed', {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Try to push the key to the running controller's process.env and
  //    signal the gateway (graceful in-process restart via SIGUSR1).
  //    If the controller doesn't support /_kilo/env/patch (404), the catch
  //    block handles it — the Fly config already has the new key for the
  //    next natural restart.
  let pushed = false;
  try {
    const result = await gateway.patchEnvOnMachine(state, env, {
      KILOCODE_API_KEY: freshKey.token,
    });
    pushed = result?.signaled ?? false;
    if (!pushed) {
      rctx.log('api_key_push_not_signaled', {
        user_id: userId,
        result: result ? `ok=${result.ok} signaled=${result.signaled}` : 'null',
      });
    }
  } catch (err) {
    rctx.log('api_key_push_error', {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
      controller_version: controllerVersion,
    });
  }

  // 4. Persist new expiry to DO state — but only if the fresh key was
  //    actually delivered via at least one path. If both the Fly config
  //    update and push failed, the running gateway still has the old key.
  //    Persisting the new expiry would cause future alarms to skip refresh,
  //    letting the old key expire silently.
  if (!pushed && !flyConfigUpdated) {
    rctx.log('api_key_refresh_failed_all_paths', {
      user_id: userId,
    });
    return;
  }

  state.kilocodeApiKey = freshKey.token;
  state.kilocodeApiKeyExpiresAt = freshKey.expiresAt;
  await ctx.storage.put(
    storageUpdate({
      kilocodeApiKey: freshKey.token,
      kilocodeApiKeyExpiresAt: freshKey.expiresAt,
    })
  );

  rctx.log('api_key_refreshed', {
    user_id: userId,
    new_expires_at: freshKey.expiresAt,
    pushed,
    flyConfigUpdated,
    controller_version: controllerVersion,
    durationMs: performance.now() - refreshStart,
    label: pushed ? 'refreshed+pushed' : flyConfigUpdated ? 'refreshed+fly-config' : 'refreshed',
  });
}

// ---- Starting reconciliation ----

/**
 * Reconcile a 'starting' instance.
 *
 * startAsync() fires start() via waitUntil, so start() may still be in
 * progress when the alarm fires. We check Fly to decide what to do:
 *
 * - Machine started  → transition to 'running' (backfilling lastStartedAt).
 * - Machine in a terminal stopped state → fall back to 'stopped'
 *   (start() failed; the next alarm / user action will retry).
 * - No machine yet (no flyMachineId, or Fly 404) → start() hasn't finished
 *   or didn't create a machine; leave in 'starting' for the next alarm.
 */
async function reconcileStarting(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  env: KiloClawEnv,
  rctx: ReconcileContext
): Promise<void> {
  const startingAt = state.startingAt;
  const isTimedOut = startingAt !== null && Date.now() - startingAt > STARTING_TIMEOUT_MS;

  if (!state.flyMachineId) {
    if (isTimedOut) {
      // No machine after STARTING_TIMEOUT_MS — start() never created one. Give up.
      rctx.log('starting_timeout', {
        user_id: state.userId,
        starting_at: state.startingAt,
        elapsed_ms: Date.now() - startingAt,
        old_state: 'starting',
        new_state: 'stopped',
        last_start_error: state.lastStartErrorMessage,
      });
      state.status = 'stopped';
      state.startingAt = null;
      state.lastStoppedAt = Date.now();
      state.healthCheckFailCount = 0;
      await ctx.storage.put(
        storageUpdate({
          status: 'stopped',
          startingAt: null,
          lastStoppedAt: state.lastStoppedAt,
          healthCheckFailCount: 0,
        })
      );
      await recordStartFailure(env, state, ctx, 'starting_timeout', state.lastStartErrorMessage);
      return;
    }
    // start() hasn't persisted a machine ID yet — still in progress, wait.
    rctx.log('starting_no_machine_yet', { user_id: state.userId });
    return;
  }

  // We have a flyMachineId — always check Fly state, even if timed out.
  // The machine may have started successfully despite the timeout.
  try {
    const machine = await fly.getMachine(flyConfig, state.flyMachineId);
    await syncStatusWithFly(ctx, state, machine.state, rctx);
    // Ensure volume reconciliation doesn't get skipped while starting.
    // Note: reconcileApiKeyExpiry and reconcileMachineMount are intentionally
    // skipped — the machine isn't running yet so there's no endpoint to push
    // a refreshed key to, and mount drift will be caught on the first regular
    // alarm once status transitions to 'running'.
    await reconcileVolume(flyConfig, ctx, state, env, rctx);

    // If syncStatusWithFly transitioned us out of 'starting', we're done.
    // If still 'starting' after the timeout, the machine exists but isn't
    // started yet — fall back to 'stopped' so the user can retry.
    if (isTimedOut && state.status === 'starting') {
      rctx.log('starting_timeout_with_machine', {
        machine_id: state.flyMachineId,
        fly_state: machine.state,
        elapsed_ms: Date.now() - startingAt,
        old_state: 'starting',
        new_state: 'stopped',
        last_start_error: state.lastStartErrorMessage,
      });
      state.status = 'stopped';
      state.startingAt = null;
      state.lastStoppedAt = Date.now();
      state.healthCheckFailCount = 0;
      await ctx.storage.put(
        storageUpdate({
          status: 'stopped',
          startingAt: null,
          lastStoppedAt: state.lastStoppedAt,
          healthCheckFailCount: 0,
        })
      );
      await recordStartFailure(
        env,
        state,
        ctx,
        'starting_timeout_with_machine',
        state.lastStartErrorMessage
      );
    }
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      // Machine was never created or was cleaned up externally.
      rctx.log('starting_machine_gone', {
        machine_id: state.flyMachineId,
        old_state: 'starting',
        new_state: 'stopped',
      });
      state.flyMachineId = null;
      state.status = 'stopped';
      state.startingAt = null;
      state.lastStoppedAt = Date.now();
      state.healthCheckFailCount = 0;
      await ctx.storage.put(
        storageUpdate(
          syncProviderStateForStorage(state, {
            flyMachineId: null,
            status: 'stopped',
            startingAt: null,
            lastStoppedAt: state.lastStoppedAt,
            healthCheckFailCount: 0,
          })
        )
      );
      await recordStartFailure(
        env,
        state,
        ctx,
        'starting_machine_gone',
        'machine gone during start'
      );
    } else if (isTimedOut) {
      // Transient Fly API error but we've exceeded the starting timeout.
      // Fall back to 'stopped' so the user can retry instead of staying
      // stuck in 'starting' indefinitely while the Fly API is unreachable.
      rctx.log('starting_timeout_transient_error', {
        machine_id: state.flyMachineId,
        error: err instanceof Error ? err.message : String(err),
        elapsed_ms: startingAt !== null ? Date.now() - startingAt : undefined,
        old_state: 'starting',
        new_state: 'stopped',
      });
      state.status = 'stopped';
      state.startingAt = null;
      state.lastStoppedAt = Date.now();
      state.healthCheckFailCount = 0;
      await ctx.storage.put(
        storageUpdate({
          status: 'stopped',
          startingAt: null,
          lastStoppedAt: state.lastStoppedAt,
          healthCheckFailCount: 0,
        })
      );
      await recordStartFailure(
        env,
        state,
        ctx,
        'starting_timeout_transient_error',
        err instanceof Error ? err.message : String(err)
      );
    } else {
      // Transient Fly API error — leave in 'starting', alarm will retry.
      rctx.log('starting_transient_error', {
        machine_id: state.flyMachineId,
        error: err instanceof Error ? err.message : String(err),
      });
      doError(state, 'reconcileStarting: transient error checking machine', {
        error: toLoggable(err),
      });
    }
  }
}

async function reconcileRestarting(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  env: KiloClawEnv,
  rctx: ReconcileContext
): Promise<void> {
  if (state.status !== 'restarting') return;
  if (!state.flyMachineId) return;

  const restartingAt = state.restartingAt;
  const isTimedOut = restartingAt !== null && Date.now() - restartingAt > RESTARTING_TIMEOUT_MS;

  try {
    const machine = await fly.getMachine(flyConfig, state.flyMachineId);
    if (machine.state === 'started') {
      if (state.restartUpdateSent) {
        // updateMachine() was sent — started means the new config is live.
        rctx.log('restarting_reconcile_success', {
          machine_id: state.flyMachineId,
          elapsed_ms: restartingAt !== null ? Date.now() - restartingAt : undefined,
        });
        await markRestartSuccessful(ctx, state, rctx);
        await reconcileVolume(flyConfig, ctx, state, env, rctx);
        return;
      }
      // Machine is started but updateMachine() never ran (e.g. stop failed
      // before we got to the update). Don't let syncStatusWithFly() overwrite
      // restarting → running. If timed out, fall back to running so the user
      // can retry — the machine is genuinely serving traffic, just with old config.
      if (isTimedOut) {
        rctx.log('restarting_no_update_timeout_fallback', {
          machine_id: state.flyMachineId,
          last_restart_error: state.lastRestartErrorMessage,
          elapsed_ms: restartingAt !== null ? Date.now() - restartingAt : undefined,
          old_state: 'restarting',
          new_state: 'running',
        });
        state.status = 'running';
        state.restartingAt = null;
        state.restartUpdateSent = false;
        state.healthCheckFailCount = 0;
        await ctx.storage.put(
          storageUpdate({
            status: 'running',
            restartingAt: null,
            restartUpdateSent: false,
            healthCheckFailCount: 0,
          })
        );
      }
      await reconcileVolume(flyConfig, ctx, state, env, rctx);
      return;
    }

    await syncStatusWithFly(ctx, state, machine.state, rctx);
    await reconcileVolume(flyConfig, ctx, state, env, rctx);
    const currentStatus = await ctx.storage.get('status');

    if (currentStatus === 'stopped') {
      state.status = 'stopped';
      state.restartingAt = null;
      await ctx.storage.put(storageUpdate({ restartingAt: null }));
      return;
    }

    // The update was applied but the machine is stopped — kick it.
    // Fly sometimes finishes a 'replacing' cycle in 'stopped' instead of
    // auto-starting. Retry on each alarm cycle until the soft timeout.
    if (machine.state === 'stopped' && state.restartUpdateSent && !isTimedOut) {
      rctx.log('restarting_retry_start', { machine_id: state.flyMachineId });
      try {
        await fly.startMachine(flyConfig, state.flyMachineId);
      } catch (startErr) {
        rctx.log('restarting_retry_start_failed', {
          machine_id: state.flyMachineId,
          error: startErr instanceof Error ? startErr.message : String(startErr),
        });
      }
      return;
    }

    if (!isTimedOut) {
      return;
    }

    const timeoutMessage = `Restart is taking longer than expected; still reconciling while the machine remains ${machine.state}`;
    rctx.log('restarting_timeout_transient', {
      machine_id: state.flyMachineId,
      fly_state: machine.state,
      elapsed_ms: restartingAt !== null ? Date.now() - restartingAt : undefined,
      last_restart_error: state.lastRestartErrorMessage,
    });
    await setRestartError(ctx, state, timeoutMessage);

    if (TERMINAL_STOPPED_STATES.has(machine.state)) {
      state.status = 'stopped';
      state.restartingAt = null;
      state.lastStoppedAt = Date.now();
      state.healthCheckFailCount = 0;
      await ctx.storage.put(
        storageUpdate({
          status: 'stopped',
          restartingAt: null,
          lastStoppedAt: state.lastStoppedAt,
          healthCheckFailCount: 0,
        })
      );
      return;
    }

    // Hard ceiling for transient states (replacing, updating, etc.) that
    // can hang indefinitely on Fly. The soft timeout above handles terminal
    // states; this catches everything else.
    const isMaxTimedOut =
      restartingAt !== null && Date.now() - restartingAt > RESTARTING_MAX_TIMEOUT_MS;
    if (isMaxTimedOut) {
      rctx.log('restarting_max_timeout', {
        machine_id: state.flyMachineId,
        fly_state: machine.state,
        elapsed_ms: Date.now() - restartingAt,
      });
      state.status = 'stopped';
      state.restartingAt = null;
      state.lastStoppedAt = Date.now();
      state.healthCheckFailCount = 0;
      await ctx.storage.put(
        storageUpdate({
          status: 'stopped',
          restartingAt: null,
          lastStoppedAt: state.lastStoppedAt,
          healthCheckFailCount: 0,
        })
      );
    }
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      rctx.log('restarting_machine_gone', {
        machine_id: state.flyMachineId,
        old_state: 'restarting',
        new_state: 'stopped',
      });
      state.flyMachineId = null;
      state.status = 'stopped';
      state.restartingAt = null;
      state.lastStoppedAt = Date.now();
      state.healthCheckFailCount = 0;
      await ctx.storage.put(
        storageUpdate(
          syncProviderStateForStorage(state, {
            flyMachineId: null,
            status: 'stopped',
            restartingAt: null,
            lastStoppedAt: state.lastStoppedAt,
            healthCheckFailCount: 0,
          })
        )
      );
      return;
    }

    if (isTimedOut) {
      const timeoutMessage = err instanceof Error ? err.message : String(err);
      rctx.log('restarting_timeout_error', {
        machine_id: state.flyMachineId,
        error: timeoutMessage,
        elapsed_ms: restartingAt !== null ? Date.now() - restartingAt : undefined,
      });
      await setRestartError(ctx, state, timeoutMessage);
      // Reset restartingAt so the next alarm cycle gets a fresh timeout
      // window. This avoids getting permanently stuck in 'restarting'
      // when Fly is temporarily unreachable — each cycle retries for
      // another RESTARTING_TIMEOUT_MS before re-entering this branch.
      state.restartingAt = Date.now();
      await ctx.storage.put(storageUpdate({ restartingAt: state.restartingAt }));
      return;
    }

    rctx.log('restarting_transient_error', {
      machine_id: state.flyMachineId,
      error: err instanceof Error ? err.message : String(err),
    });
    doError(state, 'reconcileRestarting: transient error checking machine', {
      error: toLoggable(err),
    });
  }
}

// ---- Volume reconciliation ----

async function reconcileVolume(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  env: KiloClawEnv,
  rctx: ReconcileContext
): Promise<void> {
  if (!state.flyVolumeId) {
    const providerState = await ensureVolume(
      flyConfig,
      state,
      getFlyProviderState(state),
      env,
      rctx.reason
    );
    applyProviderState(state, providerState);
    await ctx.storage.put(
      storageUpdate(
        syncProviderStateForStorage(state, {
          provider: providerState.provider,
          providerState,
        })
      )
    );
    return;
  }

  try {
    await fly.getVolume(flyConfig, state.flyVolumeId);
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      const repairStart = performance.now();
      const oldVolumeId = state.flyVolumeId;
      state.flyVolumeId = null;
      await ctx.storage.put(
        storageUpdate(syncProviderStateForStorage(state, { flyVolumeId: null }))
      );
      const providerState = await ensureVolume(
        flyConfig,
        state,
        getFlyProviderState(state),
        env,
        rctx.reason
      );
      applyProviderState(state, providerState);
      await ctx.storage.put(
        storageUpdate(
          syncProviderStateForStorage(state, {
            provider: providerState.provider,
            providerState,
          })
        )
      );
      rctx.log('replace_lost_volume', {
        data_loss: true,
        old_volume_id: oldVolumeId,
        new_volume_id: state.flyVolumeId,
        durationMs: performance.now() - repairStart,
        label: `replaced lost volume ${oldVolumeId} → ${state.flyVolumeId}`,
      });
    } else {
      rctx.log('volume_check_failed', {
        volume_id: state.flyVolumeId,
        error: err instanceof Error ? err.message : String(err),
      });
      doWarn(state, 'getVolume failed (will retry next alarm)', {
        error: toLoggable(err),
      });
    }
  }
}

// ---- Machine reconciliation ----

/**
 * @returns true if machine state was conclusively determined.
 */
async function reconcileMachine(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  env: KiloClawEnv,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<{ reconciled: boolean; result: ReconcileWithFlyResult }> {
  if (!state.flyMachineId) {
    return { reconciled: await attemptMetadataRecovery(flyConfig, ctx, state, rctx), result: {} };
  }

  try {
    const machine = await fly.getMachine(flyConfig, state.flyMachineId);
    await backfillMachineSizeFromFlyConfig(ctx, env, state, machine, 'reconcile-alarm');
    const result = await syncStatusWithFly(ctx, state, machine.state, rctx);
    await reconcileMachineMount(flyConfig, ctx, state, machine, rctx);
    return { reconciled: true, result };
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      await handleMachineGone(ctx, state, rctx);
      return { reconciled: true, result: {} };
    }
    return { reconciled: false, result: {} };
  }
}

/**
 * Backfill machineSize and instanceType from live Fly machine config.
 *
 * No-op when machineSize is already set or the Fly machine has no guest config.
 * Called from any path that already has a fresh `getMachine` response: alarm
 * reconcile, the user-facing live-check, future restart paths. Keeps the
 * "we observed live hardware → write it back" logic in one place so callers
 * don't drift.
 *
 * When the backfill actually writes new state, fires a fire-and-forget
 * Postgres sync via `ctx.waitUntil` so the denormalized
 * `kiloclaw_instances.instance_type` column catches up immediately. The
 * alarm path no longer syncs Postgres unconditionally — sync happens only
 * when DO state actually changes.
 */
async function backfillMachineSizeFromFlyConfig(
  ctx: DurableObjectState,
  env: KiloClawEnv,
  state: InstanceMutableState,
  machine: { config?: { guest?: { cpus: number; memory_mb: number; cpu_kind?: string } } },
  source: string
): Promise<void> {
  if (state.machineSize !== null) return;
  // Skip backfill when an admin override is active. The live Fly guest
  // reflects the override, not the billable tier hardware, so writing it
  // back to `machineSize` would silently re-label the instance.
  if (state.adminMachineSizeOverride !== null) return;
  const guest = machine.config?.guest;
  if (!guest) return;
  const parsedSize = parseMachineSizeFromFlyGuest(guest);
  if (!parsedSize) {
    doWarn(state, 'Skipping machineSize backfill: live Fly guest failed schema validation', {
      source,
      guest,
    });
    return;
  }
  state.machineSize = parsedSize;
  state.instanceType = resolveInstanceTypeLabel(state.machineSize, state.volumeSizeGb);
  await ctx.storage.put(
    storageUpdate({ machineSize: state.machineSize, instanceType: state.instanceType })
  );
  if (state.sandboxId && state.userId) {
    ctx.waitUntil(syncInstanceTypeToPostgresHelper(env, state, state.userId, state.sandboxId));
  }
}

/**
 * Attempt to recover machine (and optionally volume) from Fly metadata.
 */
export async function attemptMetadataRecovery(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext,
  skipCooldown?: boolean
): Promise<boolean> {
  if (!state.userId) return false;

  if (
    !skipCooldown &&
    state.lastMetadataRecoveryAt &&
    Date.now() - state.lastMetadataRecoveryAt < METADATA_RECOVERY_COOLDOWN_MS
  ) {
    return false;
  }

  state.lastMetadataRecoveryAt = Date.now();
  await ctx.storage.put(storageUpdate({ lastMetadataRecoveryAt: state.lastMetadataRecoveryAt }));

  const recoveryStart = performance.now();
  try {
    const machines = await fly.listMachines(flyConfig, {
      [METADATA_KEY_USER_ID]: state.userId,
      ...(state.sandboxId ? { [METADATA_KEY_SANDBOX_ID]: state.sandboxId } : {}),
    });

    if (machines.length > 1) {
      rctx.log('multiple_machines_found', {
        user_id: state.userId,
        count: machines.length,
        machine_ids: machines.map(m => m.id),
      });
    }

    const candidate = selectRecoveryCandidate(machines);
    if (!candidate) return true;

    state.flyMachineId = candidate.id;
    state.flyRegion = candidate.region;

    const updates: Partial<PersistedState> = {
      flyMachineId: candidate.id,
      flyRegion: candidate.region,
    };

    if (candidate.state === 'started') {
      state.status = 'running';
      updates.status = 'running';
    } else if (
      candidate.state === 'stopped' ||
      candidate.state === 'created' ||
      candidate.state === 'failed'
    ) {
      state.status = 'stopped';
      updates.status = 'stopped';
    }

    if (!state.flyVolumeId) {
      const recoveredVolumeId = volumeIdFromMachine(candidate);
      if (recoveredVolumeId) {
        try {
          await fly.getVolume(flyConfig, recoveredVolumeId);
          state.flyVolumeId = recoveredVolumeId;
          updates.flyVolumeId = recoveredVolumeId;
          rctx.log('recover_volume_from_mount', {
            volume_id: recoveredVolumeId,
            machine_id: candidate.id,
          });
        } catch (err) {
          if (fly.isFlyNotFound(err)) {
            rctx.log('recovered_volume_missing', {
              volume_id: recoveredVolumeId,
            });
          }
        }
      }
    }

    await ctx.storage.put(storageUpdate(syncProviderStateForStorage(state, updates)));
    rctx.log('recover_machine_from_metadata', {
      machine_id: candidate.id,
      fly_state: candidate.state,
      region: candidate.region,
      durationMs: performance.now() - recoveryStart,
      label: `recovered machine ${candidate.id} (fly: ${candidate.state})`,
    });
    return true;
  } catch (err) {
    rctx.log('metadata_recovery_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    doError(state, 'metadata recovery failed', { error: toLoggable(err) });
    return false;
  }
}

/**
 * Sync DO status to match Fly machine state.
 */
export async function syncStatusWithFly(
  ctx: DurableObjectState,
  state: InstanceMutableState,
  flyState: string,
  rctx: ReconcileContext
): Promise<ReconcileWithFlyResult> {
  if (flyState === 'started' && state.status !== 'running') {
    rctx.log('sync_status', {
      old_state: state.status,
      new_state: 'running',
      fly_state: flyState,
    });
    state.status = 'running';
    state.startingAt = null;
    state.healthCheckFailCount = 0;
    // Backfill lastStartedAt whenever a transition to 'running' is observed and
    // it hasn't been set yet. This covers both the async-start path (starting →
    // running) and DO-wipe + metadata recovery (stopped → running with null
    // lastStartedAt). Intentionally broader than just the 'starting' case.
    if (state.lastStartedAt === null) {
      state.lastStartedAt = Date.now();
    }
    // Reconcile may be the first path to observe that a machine reached its
    // running state, so keep the capability marker coupled to the observed
    // running transition here as well.
    state.controllerCapabilitiesVersion = WORKER_CONTROLLER_CAPABILITIES_VERSION;
    await ctx.storage.put(
      storageUpdate({
        status: 'running',
        startingAt: null,
        healthCheckFailCount: 0,
        lastStartedAt: state.lastStartedAt,
        controllerCapabilitiesVersion: WORKER_CONTROLLER_CAPABILITIES_VERSION,
      })
    );
    return {};
  }

  if (flyState === 'started' && state.status === 'running') {
    if (state.healthCheckFailCount > 0) {
      state.healthCheckFailCount = 0;
      await ctx.storage.put(storageUpdate({ healthCheckFailCount: 0 }));
    }
    return {};
  }

  // destroyed means the Fly machine is gone — clear the stale ID immediately
  // so the DO doesn't keep referencing a dead machine.
  if (flyState === 'destroyed') {
    rctx.log('sync_status_destroyed', {
      old_state: state.status,
      new_state: 'stopped',
      fly_state: flyState,
      machine_id: state.flyMachineId,
    });
    state.flyMachineId = null;
    state.status = 'stopped';
    state.lastStoppedAt = Date.now();
    state.healthCheckFailCount = 0;
    await ctx.storage.put(
      storageUpdate(
        syncProviderStateForStorage(state, {
          flyMachineId: null,
          status: 'stopped',
          lastStoppedAt: state.lastStoppedAt,
          healthCheckFailCount: 0,
        })
      )
    );
    return {};
  }

  // failed is definitively terminal — transition immediately without waiting for
  // the unexpected-stop recovery confirmation path used for stopped.
  if (flyState === 'failed' && state.status !== 'stopped') {
    const wasStarting = state.status === 'starting';
    rctx.log('sync_status_failed', {
      old_state: state.status,
      new_state: 'stopped',
      fly_state: flyState,
    });
    state.status = 'stopped';
    state.startingAt = null;
    state.lastStoppedAt = Date.now();
    state.healthCheckFailCount = 0;
    await ctx.storage.put(
      storageUpdate({
        status: 'stopped',
        startingAt: null,
        lastStoppedAt: state.lastStoppedAt,
        healthCheckFailCount: 0,
      })
    );
    if (wasStarting) {
      await recordStartFailure(
        rctx.env,
        state,
        ctx,
        'fly_failed_state',
        'fly machine entered failed state'
      );
    }
    return {};
  }

  if (flyState === 'stopped' && state.status === 'running') {
    state.healthCheckFailCount++;
    await ctx.storage.put(storageUpdate({ healthCheckFailCount: state.healthCheckFailCount }));

    if (state.healthCheckFailCount >= SELF_HEAL_THRESHOLD) {
      rctx.log('unexpected_stop_recovery_trigger', {
        old_state: 'running',
        new_state: 'recovering',
        fly_state: flyState,
        fail_count: state.healthCheckFailCount,
        value: SELF_HEAL_THRESHOLD,
      });
      return {
        beginUnexpectedStopRecovery: {
          flyState,
          failCount: state.healthCheckFailCount,
        },
      };
    }
  }

  return {};
}

async function reconcileRecovering(
  flyConfig: FlyClientConfig,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<ReconcileWithFlyResult> {
  const recoveryStartedAt = state.recoveryStartedAt;
  const isTimedOut =
    recoveryStartedAt !== null && Date.now() - recoveryStartedAt > RECOVERING_TIMEOUT_MS;

  if (state.flyMachineId) {
    try {
      const machine = await fly.getMachine(flyConfig, state.flyMachineId);

      if (machine.state === 'started') {
        rctx.log('unexpected_stop_recovery_machine_started', {
          machine_id: state.flyMachineId,
          old_state: 'recovering',
          new_state: 'running',
        });
        return { completeUnexpectedStopRecovery: true };
      }

      if (
        machine.state === 'stopped' ||
        machine.state === 'failed' ||
        machine.state === 'destroyed'
      ) {
        const errorMessage = `unexpected stop recovery replacement machine entered ${machine.state}`;
        rctx.log('unexpected_stop_recovery_terminal_machine_state', {
          machine_id: state.flyMachineId,
          fly_state: machine.state,
          error: errorMessage,
          old_state: 'recovering',
          new_state: 'stopped',
        });
        return {
          failedUnexpectedStopRecovery: {
            errorMessage,
            label: `alarm_${machine.state}`,
          },
        };
      }

      rctx.log('unexpected_stop_recovery_waiting_for_start', {
        machine_id: state.flyMachineId,
        fly_state: machine.state,
      });
    } catch (err) {
      if (fly.isFlyNotFound(err)) {
        const errorMessage = 'unexpected stop recovery replacement machine disappeared';
        rctx.log('unexpected_stop_recovery_machine_gone', {
          machine_id: state.flyMachineId,
          error: errorMessage,
          old_state: 'recovering',
          new_state: 'stopped',
        });
        return {
          failedUnexpectedStopRecovery: {
            errorMessage,
            label: 'alarm_machine_gone',
          },
        };
      }

      doError(state, 'reconcileRecovering: transient error checking replacement machine', {
        error: toLoggable(err),
      });
    }
  }

  if (!isTimedOut) return {};

  const errorMessage = 'unexpected stop recovery timed out';
  const durationMs = recoveryStartedAt ? Date.now() - recoveryStartedAt : undefined;
  rctx.log('unexpected_stop_recovery_timeout', {
    old_state: 'recovering',
    new_state: 'stopped',
    durationMs,
    error: errorMessage,
  });

  return {
    timedOutUnexpectedStopRecovery: {
      errorMessage,
      durationMs,
    },
  };
}

export async function markRestartSuccessful(
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<void> {
  const restartingAt = state.restartingAt;
  rctx.log('restart_self_healed', {
    machine_id: state.flyMachineId,
    previous_error: state.lastRestartErrorMessage,
    had_restart_error: state.lastRestartErrorMessage !== null,
    durationMs: restartingAt ? Date.now() - restartingAt : undefined,
    old_state: 'restarting',
    new_state: 'running',
  });
  state.status = 'running';
  state.startingAt = null;
  state.restartingAt = null;
  state.restartUpdateSent = false;
  if (state.lastStartedAt === null) {
    state.lastStartedAt = Date.now();
  }
  state.healthCheckFailCount = 0;
  state.lastRestartErrorMessage = null;
  state.lastRestartErrorAt = null;
  state.controllerCapabilitiesVersion = WORKER_CONTROLLER_CAPABILITIES_VERSION;
  await ctx.storage.put(
    storageUpdate({
      status: 'running',
      startingAt: null,
      restartingAt: null,
      restartUpdateSent: false,
      lastStartedAt: state.lastStartedAt,
      healthCheckFailCount: 0,
      lastRestartErrorMessage: null,
      lastRestartErrorAt: null,
      controllerCapabilitiesVersion: WORKER_CONTROLLER_CAPABILITIES_VERSION,
    })
  );
}

async function setRestartError(
  ctx: DurableObjectState,
  state: InstanceMutableState,
  message: string
): Promise<void> {
  state.lastRestartErrorMessage = message;
  state.lastRestartErrorAt = Date.now();
  await ctx.storage.put(
    storageUpdate({
      lastRestartErrorMessage: message,
      lastRestartErrorAt: state.lastRestartErrorAt,
    })
  );
}

/**
 * Lightweight live check called from getStatus() via waitUntil (fire-and-forget).
 */
export async function syncStatusFromLiveCheck(
  ctx: DurableObjectState,
  state: InstanceMutableState,
  env: KiloClawEnv
): Promise<void> {
  if (!state.flyMachineId) return;
  if (state.restartingAt !== null) return;

  try {
    const appName = state.flyAppName ?? env.FLY_APP_NAME;
    if (!appName || !env.FLY_API_TOKEN) return;
    const flyConfig = { apiToken: env.FLY_API_TOKEN, appName };

    const machine = await fly.getMachine(flyConfig, state.flyMachineId);
    await backfillMachineSizeFromFlyConfig(ctx, env, state, machine, 'live-check');

    if (machine.state === 'started') {
      state.healthCheckFailCount = 0;
      return;
    }

    if (TERMINAL_STOPPED_STATES.has(machine.state)) {
      console.log('[DO] Live check: Fly state is', machine.state, '— marking stopped in-memory');
      state.status = 'stopped';
    } else {
      state.healthCheckFailCount = 0;
    }
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      console.log('[DO] Live check: machine 404 — marking stopped in-memory');
      state.status = 'stopped';
      return;
    }
    doWarn(state, 'Live check failed, using cached status', {
      error: toLoggable(err),
    });
  }
}

/**
 * Check that a running machine has the correct volume mount.
 */
export async function reconcileMachineMount(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  machine: { state: string; config: FlyMachineConfig },
  rctx: ReconcileContext
): Promise<void> {
  if (machine.state !== 'started' || !state.flyVolumeId) return;

  const mounts = machine.config?.mounts ?? [];
  const hasCorrectMount = mounts.some(m => m.volume === state.flyVolumeId && m.path === '/root');

  if (hasCorrectMount) return;

  if (!state.flyMachineId) return;

  const repairStart = performance.now();

  await fly.stopMachineAndWait(flyConfig, state.flyMachineId);
  await fly.updateMachine(flyConfig, state.flyMachineId, {
    ...machine.config,
    mounts: [{ volume: state.flyVolumeId, path: '/root' }],
  });
  await fly.waitForState(flyConfig, state.flyMachineId, 'started', STARTUP_TIMEOUT_SECONDS);
  rctx.log('repair_mount', {
    machine_id: state.flyMachineId,
    volume_id: state.flyVolumeId,
    durationMs: performance.now() - repairStart,
    label: `repaired mount for volume ${state.flyVolumeId}`,
  });
}

/**
 * Machine confirmed gone from Fly (404).
 */
async function handleMachineGone(
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<void> {
  rctx.log('clear_stale_machine', {
    old_state: state.status,
    new_state: 'stopped',
    machine_id: state.flyMachineId,
  });
  state.flyMachineId = null;
  state.status = 'stopped';
  state.lastStoppedAt = Date.now();
  state.healthCheckFailCount = 0;
  await ctx.storage.put(
    storageUpdate(
      syncProviderStateForStorage(state, {
        flyMachineId: null,
        status: 'stopped',
        lastStoppedAt: state.lastStoppedAt,
        healthCheckFailCount: 0,
      })
    )
  );
}

// ========================================================================
// Two-phase destroy helpers
// ========================================================================

const MACHINE_ID_RE = /^[a-z0-9]+$/;

async function retryPendingDestroy(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext,
  markDestroyedInPostgres?: (userId: string, sandboxId: string) => Promise<boolean>,
  finalizeRetention?: FinalizeDestroyRetention
): Promise<void> {
  await recoverBoundMachineForDestroy(flyConfig, ctx, state, rctx);
  await tryDeleteMachine(flyConfig, ctx, state, rctx);
  await tryDeleteVolume(flyConfig, ctx, state, rctx);
  // Best-effort sweep for any volumes the DO has lost track of (e.g. abandoned
  // recovery clones, originals that were never associated with the current
  // pendingDestroyVolumeId). Runs after the pending-pointer cleanup so the
  // primary destroy path is unaffected. May also promote an attached orphan
  // into the pending pointers, which then defers finalize to the next alarm.
  await tryDeleteOrphanVolumes(flyConfig, ctx, state, rctx);
  const result = await finalizeDestroyIfComplete(
    ctx,
    state,
    rctx,
    markDestroyedInPostgres,
    finalizeRetention
  );
  if (!result.finalized) {
    await maybeEmitDestroyStuckTelemetry(ctx, state, rctx);
  }
}

async function recoverBoundMachineForDestroy(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<void> {
  if (state.pendingDestroyMachineId) return;
  if (!state.pendingDestroyVolumeId) return;

  if (
    state.lastBoundMachineRecoveryAt &&
    Date.now() - state.lastBoundMachineRecoveryAt < BOUND_MACHINE_RECOVERY_COOLDOWN_MS
  ) {
    return;
  }

  const recoveryStart = performance.now();
  try {
    const volume = await fly.getVolume(flyConfig, state.pendingDestroyVolumeId);
    const machineId = volume.attached_machine_id;

    if (!machineId || !MACHINE_ID_RE.test(machineId)) {
      if (machineId) {
        rctx.log('recover_bound_machine_invalid_id', {
          volume_id: state.pendingDestroyVolumeId,
          attached_machine_id: machineId,
        });
      }
      state.lastBoundMachineRecoveryAt = Date.now();
      await ctx.storage.put(
        storageUpdate({
          lastBoundMachineRecoveryAt: state.lastBoundMachineRecoveryAt,
        })
      );
      return;
    }

    state.pendingDestroyMachineId = machineId;
    state.flyMachineId = machineId;
    state.lastBoundMachineRecoveryAt = null;
    await ctx.storage.put(
      storageUpdate(
        syncProviderStateForStorage(state, {
          pendingDestroyMachineId: machineId,
          flyMachineId: machineId,
          lastBoundMachineRecoveryAt: null,
        })
      )
    );
    rctx.log('recover_bound_machine_for_destroy', {
      volume_id: state.pendingDestroyVolumeId,
      machine_id: machineId,
      durationMs: performance.now() - recoveryStart,
      label: `recovered machine ${machineId} from volume ${state.pendingDestroyVolumeId}`,
    });
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof fly.FlyApiError ? err.status : null;
    rctx.log('recover_bound_machine_failed', {
      volume_id: state.pendingDestroyVolumeId,
      error: message,
    });
    await persistDestroyError(ctx, state, 'recover', status, message);
  }
}

export async function tryDeleteMachine(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<void> {
  if (!state.pendingDestroyMachineId) return;

  try {
    await fly.destroyMachine(flyConfig, state.pendingDestroyMachineId);
    rctx.log('destroy_machine_ok', {
      machine_id: state.pendingDestroyMachineId,
    });
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      rctx.log('destroy_machine_already_gone', {
        machine_id: state.pendingDestroyMachineId,
      });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof fly.FlyApiError ? err.status : null;
      rctx.log('destroy_machine_failed', {
        machine_id: state.pendingDestroyMachineId,
        error: message,
      });
      await persistDestroyError(ctx, state, 'machine', status, message);
      return;
    }
  }

  state.pendingDestroyMachineId = null;
  state.flyMachineId = null;
  await ctx.storage.put(
    storageUpdate(
      syncProviderStateForStorage(state, { pendingDestroyMachineId: null, flyMachineId: null })
    )
  );
  if (!state.pendingDestroyVolumeId) {
    await clearDestroyError(ctx, state);
  }
}

/**
 * Cap on retries against a single `pendingDestroyVolumeId` before the DO gives
 * up. At the current ~1 retry/minute alarm cadence, 50 attempts is roughly an
 * hour of wall-clock retries. Past this point the volume is treated as
 * permanently stuck — the DO emits `destroy_volume_abandoned_after_max_retries`
 * (for alerting), clears the pending pointer so the destroy loop can finalize,
 * and the volume will be picked up by the org-wide volume janitor (if any).
 *
 * Before this cap existed, a single stuck volume could retry on every alarm
 * indefinitely — confirmed in production where 8 sandboxes accumulated 12k+
 * retries each over ~14 days.
 *
 * Interaction with the orphan sweep: when this cap is reached, the abandon
 * branch clears `pendingDestroyVolumeId` and falls through into
 * `tryDeleteOrphanVolumes` on the same alarm. If the stuck volume still exists
 * on Fly and matches `volumeNameFromSandboxId(sandboxId)`, the sweep will make
 * exactly one additional best-effort delete attempt against it. That can mean
 * `destroy_volume_abandoned_after_max_retries` fires moments before the volume
 * is actually cleaned up — alerting consumers should treat the event as "this
 * needs human attention" rather than "this volume is leaked," and re-check
 * actual Fly state before acting.
 */
const MAX_DESTROY_VOLUME_ATTEMPTS = 50;

export async function tryDeleteVolume(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<void> {
  if (!state.pendingDestroyVolumeId) return;

  let shouldClearState = false;

  try {
    await fly.deleteVolume(flyConfig, state.pendingDestroyVolumeId);
    rctx.log('destroy_volume_ok', {
      volume_id: state.pendingDestroyVolumeId,
    });
    shouldClearState = true;
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      rctx.log('destroy_volume_already_gone', {
        volume_id: state.pendingDestroyVolumeId,
      });
      shouldClearState = true;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof fly.FlyApiError ? err.status : null;
      rctx.log('destroy_volume_failed', {
        volume_id: state.pendingDestroyVolumeId,
        error: message,
      });
      await persistDestroyError(ctx, state, 'volume', status, message);

      const attempts = state.destroyVolumeAttempts + 1;
      if (attempts >= MAX_DESTROY_VOLUME_ATTEMPTS) {
        rctx.log('destroy_volume_abandoned_after_max_retries', {
          volume_id: state.pendingDestroyVolumeId,
          attempts,
          last_error: message,
          last_status: status,
        });
        shouldClearState = true;
      } else {
        state.destroyVolumeAttempts = attempts;
        await ctx.storage.put(storageUpdate({ destroyVolumeAttempts: attempts }));
        return;
      }
    }
  }

  if (!shouldClearState) return;

  state.pendingDestroyVolumeId = null;
  state.flyVolumeId = null;
  state.destroyVolumeAttempts = 0;
  await ctx.storage.put(
    storageUpdate(
      syncProviderStateForStorage(state, {
        pendingDestroyVolumeId: null,
        flyVolumeId: null,
        destroyVolumeAttempts: 0,
      })
    )
  );
  if (!state.pendingDestroyMachineId) {
    await clearDestroyError(ctx, state);
  }
}

/**
 * Best-effort sweep for volumes the DO has lost track of.
 *
 * `tryDeleteVolume()` only ever targets `state.pendingDestroyVolumeId`. If a
 * volume isn't there because it was an earlier original whose pointer got
 * overwritten by a recovery clone, or a previous recovery clone that never
 * made it into the state, it survives the destroy flow forever.
 *
 * This sweep:
 *  - Runs only when the primary destroy pointers are clear (so it doesn't
 *    fight the main destroy path).
 *  - Calls `listVolumes` for the app.
 *  - Filters by exact name match against `volumeNameFromSandboxId(sandboxId)`.
 *    Critical: see the safety assumption below.
 *  - Destroys unattached matching volumes inline (best-effort).
 *  - For matching volumes that are still attached to a machine: promotes the
 *    first one into `pendingDestroyMachineId` / `pendingDestroyVolumeId` so
 *    the next alarm's machine+volume destroy flow handles it. That promotion
 *    is what keeps `finalizeDestroyIfComplete` from wiping DO state while
 *    attached orphans still exist. Without it, attached orphans would be
 *    skipped, finalize would run, and the DO would forget about them
 *    permanently. Additional attached orphans get picked up on subsequent
 *    alarms (one per alarm, since the pending pointers only hold one at a
 *    time).
 *  - Errors on individual deletes are logged but do not fail the alarm.
 *
 * Safety assumption: one sandbox per Fly app today.
 *  - `ki_*` (instance-keyed) sandboxes route to `inst-{hash(instanceId)}` apps
 *    via `getAppKey()`, which is per-instance by construction.
 *  - Legacy (base64-encoded user UUID) sandboxes route to `acct-{hash(userId)}`
 *    apps with at most one legacy sandbox per user.
 *  In both cases the app contains exactly one DO's sandbox, so any volume
 *  whose name matches `volumeNameFromSandboxId(state.sandboxId)` is ours.
 *
 *  TODO(multi-instance): `volumeNameFromSandboxId()` truncates to 30 chars,
 *  which for `ki_<32 hex>` IDs leaves only the first 18 UUID hex chars in the
 *  name. If a future change ever places multiple instances inside the same
 *  Fly app (e.g. a per-user app hosting many instance-keyed sandboxes), two
 *  instances whose UUIDs share their first 18 hex chars would produce the
 *  same volume name and this filter could match a sibling instance's volume.
 *  Revisit this function (or remove the truncation) before such a migration
 *  ships. Today the routing in `getAppKey()` makes that case unreachable.
 */
async function tryDeleteOrphanVolumes(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<void> {
  if (state.pendingDestroyVolumeId || state.pendingDestroyMachineId) return;
  if (!state.sandboxId) return;

  const expectedName = volumeNameFromSandboxId(state.sandboxId);

  let volumes: FlyVolume[];
  try {
    volumes = await fly.listVolumes(flyConfig);
  } catch (err) {
    rctx.log('destroy_orphan_volumes_list_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // First pass: destroy unattached matching orphans inline, record any
  // attached orphan for promotion at the end. We want the inline deletes to
  // happen regardless so we still make forward progress in this alarm.
  let promoteVolumeId: string | null = null;
  let promoteMachineId: string | null = null;

  for (const vol of volumes) {
    if (vol.name !== expectedName) continue;
    // Fly is already tearing the volume down; let it finish.
    if (
      vol.state === 'pending_destroy' ||
      vol.state === 'destroying' ||
      vol.state === 'destroyed'
    ) {
      continue;
    }
    if (vol.attached_machine_id) {
      // Attached orphan: the pending-destroy path knows how to handle this
      // (destroy machine then volume, with retry+error tracking), so promote
      // it into the primary pointers. Only the first attached orphan gets
      // promoted in this alarm; subsequent ones are picked up after this
      // pair is resolved.
      if (!promoteVolumeId) {
        promoteVolumeId = vol.id;
        promoteMachineId = vol.attached_machine_id;
      }
      continue;
    }
    try {
      await fly.deleteVolume(flyConfig, vol.id);
      rctx.log('destroy_orphan_volume_ok', { volume_id: vol.id });
    } catch (err) {
      if (fly.isFlyNotFound(err)) continue;
      rctx.log('destroy_orphan_volume_failed', {
        volume_id: vol.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (promoteVolumeId && promoteMachineId) {
    state.pendingDestroyMachineId = promoteMachineId;
    state.pendingDestroyVolumeId = promoteVolumeId;
    state.flyMachineId = promoteMachineId;
    state.flyVolumeId = promoteVolumeId;
    state.destroyVolumeAttempts = 0;
    await ctx.storage.put(
      storageUpdate(
        syncProviderStateForStorage(state, {
          pendingDestroyMachineId: promoteMachineId,
          pendingDestroyVolumeId: promoteVolumeId,
          flyMachineId: promoteMachineId,
          flyVolumeId: promoteVolumeId,
          destroyVolumeAttempts: 0,
        })
      )
    );
    rctx.log('destroy_orphan_volume_promoted_to_pending', {
      volume_id: promoteVolumeId,
      attached_machine_id: promoteMachineId,
    });
  }
}

async function persistDestroyError(
  ctx: DurableObjectState,
  state: InstanceMutableState,
  op: 'machine' | 'volume' | 'recover',
  status: number | null,
  message: string
): Promise<void> {
  state.lastDestroyErrorOp = op;
  state.lastDestroyErrorStatus = status;
  state.lastDestroyErrorMessage = message;
  state.lastDestroyErrorAt = Date.now();
  await ctx.storage.put(
    storageUpdate({
      lastDestroyErrorOp: op,
      lastDestroyErrorStatus: status,
      lastDestroyErrorMessage: message,
      lastDestroyErrorAt: state.lastDestroyErrorAt,
    })
  );
}

async function clearDestroyError(
  ctx: DurableObjectState,
  state: InstanceMutableState
): Promise<void> {
  if (!state.lastDestroyErrorOp) return;
  state.lastDestroyErrorOp = null;
  state.lastDestroyErrorStatus = null;
  state.lastDestroyErrorMessage = null;
  state.lastDestroyErrorAt = null;
  await ctx.storage.put(
    storageUpdate({
      lastDestroyErrorOp: null,
      lastDestroyErrorStatus: null,
      lastDestroyErrorMessage: null,
      lastDestroyErrorAt: null,
    })
  );
}

/**
 * If both pending IDs are cleared, finalize destroy.
 */
export async function finalizeDestroyIfComplete(
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext,
  markDestroyedInPostgres?: (userId: string, sandboxId: string) => Promise<boolean>,
  finalizeRetention?: FinalizeDestroyRetention
): Promise<DestroyResult> {
  if (state.pendingDestroyMachineId || state.pendingDestroyVolumeId) {
    return destroyResultFromState(state, {
      finalized: false,
      destroyedUserId: null,
      destroyedSandboxId: null,
    });
  }

  if (!state.userId || !state.sandboxId) {
    return destroyResultFromState(state, {
      finalized: false,
      destroyedUserId: null,
      destroyedSandboxId: null,
    });
  }

  const destroyedUserId = state.userId;
  const destroyedSandboxId = state.sandboxId;

  if (state.pendingPostgresMarkOnFinalize && markDestroyedInPostgres) {
    const marked = await markDestroyedInPostgres(destroyedUserId, destroyedSandboxId);
    if (!marked) {
      return destroyResultFromState(state, {
        finalized: false,
        destroyedUserId,
        destroyedSandboxId,
      });
    }
  }

  // Emit before state is wiped — rctx.log reads from state
  rctx.log('destroy_complete', {
    user_id: destroyedUserId,
    sandbox_id: destroyedSandboxId,
  });

  if (finalizeRetention) {
    const keys = [...(await ctx.storage.list()).keys()];
    await ctx.storage.transaction(async txn => {
      await txn.deleteAlarm();
      if (keys.length > 0) await txn.delete(keys);
      await txn.put(finalizeRetention.entries);
      await txn.setAlarm(finalizeRetention.retryAlarmAt);
    });
  } else {
    await ctx.storage.deleteAlarm();
    await ctx.storage.deleteAll();
  }
  resetMutableState(state);

  return destroyResultFromState(state, { finalized: true, destroyedUserId, destroyedSandboxId });
}
