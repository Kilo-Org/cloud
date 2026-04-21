import type { KiloClawEnv } from '../../types';
import type { FlyClientConfig } from '../../fly/client';
import type { FlyMachineConfig } from '../../fly/types';
import type { PersistedState } from '../../schemas/instance-config';
import * as fly from '../../fly/client';
import {
  SELF_HEAL_THRESHOLD,
  STARTUP_TIMEOUT_SECONDS,
  STARTING_TIMEOUT_MS,
  RESTARTING_TIMEOUT_MS,
  RESTARTING_MAX_TIMEOUT_MS,
  RECOVERING_TIMEOUT_MS,
  getProactiveRefreshThresholdMs,
} from '../../config';
import { ENCRYPTED_ENV_PREFIX, encryptEnvValue } from '../../utils/env-encryption';
import {
  METADATA_RECOVERY_COOLDOWN_MS,
  BOUND_MACHINE_RECOVERY_COOLDOWN_MS,
  TERMINAL_STOPPED_STATES,
  selectRecoveryCandidate,
  volumeIdFromMachine,
} from '../machine-recovery';
import { METADATA_KEY_USER_ID, METADATA_KEY_SANDBOX_ID } from '../machine-config';
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
import { mintFreshApiKey } from './config';
import * as gateway from './gateway';
import { writeEvent, eventContextFromState } from '../../utils/analytics';

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

function emitStartFailedEvent(
  env: { KILOCLAW_AE?: AnalyticsEngineDataset },
  state: InstanceMutableState,
  label: string,
  error?: string
): void {
  writeEvent(env, {
    event: 'instance.provisioning_failed',
    delivery: 'do',
    status: 'stopped',
    label,
    error,
    ...eventContextFromState(state),
  });
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
  markDestroyedInPostgres?: (userId: string, sandboxId: string) => Promise<boolean>
): Promise<ReconcileWithFlyResult> {
  const rctx = createReconcileContext(state, env, reason);

  if (state.status === 'destroying') {
    await retryPendingDestroy(flyConfig, ctx, state, rctx, markDestroyedInPostgres);
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
      emitStartFailedEvent(
        env,
        state,
        'starting_timeout',
        state.lastStartErrorMessage ?? undefined
      );
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
      emitStartFailedEvent(
        env,
        state,
        'starting_timeout_with_machine',
        state.lastStartErrorMessage ?? undefined
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
      emitStartFailedEvent(env, state, 'starting_machine_gone', 'machine gone during start');
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
      emitStartFailedEvent(
        env,
        state,
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
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<{ reconciled: boolean; result: ReconcileWithFlyResult }> {
  if (!state.flyMachineId) {
    return { reconciled: await attemptMetadataRecovery(flyConfig, ctx, state, rctx), result: {} };
  }

  try {
    const machine = await fly.getMachine(flyConfig, state.flyMachineId);
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
    await ctx.storage.put(
      storageUpdate({
        status: 'running',
        startingAt: null,
        healthCheckFailCount: 0,
        lastStartedAt: state.lastStartedAt,
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
      emitStartFailedEvent(rctx.env, state, 'fly_failed_state', 'fly machine entered failed state');
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

    // Backfill machineSize from live Fly machine config for legacy instances
    if (state.machineSize === null && machine.config?.guest) {
      const { cpus, memory_mb, cpu_kind } = machine.config.guest;
      state.machineSize = { cpus, memory_mb, cpu_kind };
      await ctx.storage.put(storageUpdate({ machineSize: state.machineSize }));
    }

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
  markDestroyedInPostgres?: (userId: string, sandboxId: string) => Promise<boolean>
): Promise<void> {
  await recoverBoundMachineForDestroy(flyConfig, ctx, state, rctx);
  await tryDeleteMachine(flyConfig, ctx, state, rctx);
  await tryDeleteVolume(flyConfig, ctx, state, rctx);
  await finalizeDestroyIfComplete(ctx, state, rctx, markDestroyedInPostgres);
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
  await clearDestroyError(ctx, state);
}

export async function tryDeleteVolume(
  flyConfig: FlyClientConfig,
  ctx: DurableObjectState,
  state: InstanceMutableState,
  rctx: ReconcileContext
): Promise<void> {
  if (!state.pendingDestroyVolumeId) return;

  try {
    await fly.deleteVolume(flyConfig, state.pendingDestroyVolumeId);
    rctx.log('destroy_volume_ok', {
      volume_id: state.pendingDestroyVolumeId,
    });
  } catch (err) {
    if (fly.isFlyNotFound(err)) {
      rctx.log('destroy_volume_already_gone', {
        volume_id: state.pendingDestroyVolumeId,
      });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof fly.FlyApiError ? err.status : null;
      rctx.log('destroy_volume_failed', {
        volume_id: state.pendingDestroyVolumeId,
        error: message,
      });
      await persistDestroyError(ctx, state, 'volume', status, message);
      return;
    }
  }

  state.pendingDestroyVolumeId = null;
  state.flyVolumeId = null;
  await ctx.storage.put(
    storageUpdate(
      syncProviderStateForStorage(state, { pendingDestroyVolumeId: null, flyVolumeId: null })
    )
  );
  await clearDestroyError(ctx, state);
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
  markDestroyedInPostgres?: (userId: string, sandboxId: string) => Promise<boolean>
): Promise<DestroyResult> {
  if (state.pendingDestroyMachineId || state.pendingDestroyVolumeId) {
    return {
      finalized: false,
      destroyedUserId: null,
      destroyedSandboxId: null,
    };
  }

  if (!state.userId || !state.sandboxId) {
    return {
      finalized: false,
      destroyedUserId: null,
      destroyedSandboxId: null,
    };
  }

  const destroyedUserId = state.userId;
  const destroyedSandboxId = state.sandboxId;

  if (state.pendingPostgresMarkOnFinalize && markDestroyedInPostgres) {
    const marked = await markDestroyedInPostgres(destroyedUserId, destroyedSandboxId);
    if (!marked) {
      return { finalized: false, destroyedUserId, destroyedSandboxId };
    }
  }

  // Emit before state is wiped — rctx.log reads from state
  rctx.log('destroy_complete', {
    user_id: destroyedUserId,
    sandbox_id: destroyedSandboxId,
  });

  await ctx.storage.deleteAlarm();
  await ctx.storage.deleteAll();
  resetMutableState(state);

  return { finalized: true, destroyedUserId, destroyedSandboxId };
}
