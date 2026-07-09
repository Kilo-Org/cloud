import type { GastownEventData } from '../../util/analytics.util';

export const CONTAINER_HEALTH_FAILURE_THRESHOLD = 3;
export const CONTAINER_HEALTH_COLD_START_GRACE_MS = 60_000;
export const CONTAINER_HEALTH_AUTO_RESTART_THROTTLE_MS = 60_000;
export const CONTAINER_HEALTH_AUTO_RESTART_WINDOW_MS = 30 * 60_000;
export const CONTAINER_HEALTH_MAX_AUTO_RESTARTS_PER_WINDOW = 3;

export const CONTAINER_HEALTH_STORAGE_KEYS = {
  consecutiveHealthFailures: 'container:consecutiveHealthFailures',
  firstHealthFailureAt: 'container:firstHealthFailureAt',
  lastAutoRestartAt: 'container:lastAutoRestartAt',
  autoRestartWindowStart: 'container:autoRestartWindowStart',
  autoRestartsInWindow: 'container:autoRestartsInWindow',
  autoRestartExhaustedWindowStart: 'container:autoRestartExhaustedWindowStart',
  // Whole-episode marker. Unlike firstHealthFailureAt (cleared on every restart),
  // this is set once at the first failure of an unhealthy episode and only cleared
  // on the first success — so it can measure end-to-end downtime across restarts.
  unhealthyEpisodeStartedAt: 'container:unhealthyEpisodeStartedAt',
  // Strongest recovery action taken during the current episode, used to attribute
  // container.health_recovered. Cleared on the recovering success after the emit.
  recoveryPathHint: 'container:recoveryPathHint',
} as const;

// How the container recovered from an unhealthy episode. `auto_restart` takes
// priority over `cold_start_grace` (a restart is the strongest signal); `self`
// means the container recovered without the watchdog restarting or waiting out
// cold-start grace (e.g. sub-threshold flapping that cleared on its own).
export type ContainerRecoveryPathHint = 'auto_restart' | 'cold_start_grace';
export type ContainerRecoveredAfter = ContainerRecoveryPathHint | 'self';

export type ContainerHealthPingOutcome =
  | {
      ok: true;
      durationMs: number;
      statusCode: number;
    }
  | {
      ok: false;
      reason: string;
      durationMs: number;
      statusCode?: number;
      error?: string;
    };

export type ContainerHealthLogData = {
  event: string;
  townId: string;
  containerId?: string;
  reason?: string;
  consecutiveFailures?: number;
  statusCode?: number;
  error?: string;
  durationMs?: number;
};

export type ContainerHealthWatchdogDeps = {
  townId: string;
  // Cloudflare container identity (TownContainerDO Durable Object id), stamped
  // onto every emitted event/log to aid Cloudflare-support debugging.
  containerDoId: string;
  outcome: ContainerHealthPingOutcome;
  isDraining: () => boolean;
  getConsecutiveHealthFailures: () => Promise<number | undefined>;
  setConsecutiveHealthFailures: (value: number) => Promise<void>;
  getFirstHealthFailureAt: () => Promise<number | undefined>;
  setFirstHealthFailureAt: (value: number) => Promise<void>;
  deleteFirstHealthFailureAt: () => Promise<unknown>;
  getLastAutoRestartAt: () => Promise<number | undefined>;
  setLastAutoRestartAt: (value: number) => Promise<void>;
  getAutoRestartWindowStart: () => Promise<number | undefined>;
  setAutoRestartWindowStart: (value: number) => Promise<void>;
  getAutoRestartsInWindow: () => Promise<number | undefined>;
  setAutoRestartsInWindow: (value: number) => Promise<void>;
  getAutoRestartExhaustedWindowStart: () => Promise<number | undefined>;
  setAutoRestartExhaustedWindowStart: (value: number) => Promise<void>;
  deleteAutoRestartExhaustedWindowStart: () => Promise<unknown>;
  getUnhealthyEpisodeStartedAt: () => Promise<number | undefined>;
  setUnhealthyEpisodeStartedAt: (value: number) => Promise<void>;
  deleteUnhealthyEpisodeStartedAt: () => Promise<unknown>;
  getRecoveryPathHint: () => Promise<ContainerRecoveryPathHint | undefined>;
  setRecoveryPathHint: (value: ContainerRecoveryPathHint) => Promise<void>;
  deleteRecoveryPathHint: () => Promise<unknown>;
  getContainerStub: (townId: string) => {
    destroy: () => Promise<void>;
  };
  writeEventFn: (data: GastownEventData) => void;
  logWarnFn: (data: ContainerHealthLogData) => void;
  now: () => number;
};

export async function recoverContainerIfWedged(deps: ContainerHealthWatchdogDeps): Promise<void> {
  try {
    await recoverContainerIfWedgedInner(deps);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Dual-write: Logpush for on-call visibility, AE so Workstream B's o11y
    // monitor can fingerprint deploy churn ("…code was updated.") cross-town.
    safeWriteEvent(deps, {
      event: 'container.health_watchdog_error',
      townId: deps.townId,
      error,
    });
    safeLog(deps, {
      event: 'container.health_watchdog_error',
      townId: deps.townId,
      error,
    });
  }
}

async function recoverContainerIfWedgedInner(deps: ContainerHealthWatchdogDeps): Promise<void> {
  if (deps.outcome.ok) {
    await emitRecoveryIfEpisodeEnded(deps);
    await deps.setConsecutiveHealthFailures(0);
    await deps.deleteFirstHealthFailureAt();
    return;
  }

  const now = deps.now();
  const previousFailures = (await deps.getConsecutiveHealthFailures()) ?? 0;
  const consecutiveFailures = previousFailures + 1;
  const storedFirstFailureAt = await deps.getFirstHealthFailureAt();
  const firstFailureAt = storedFirstFailureAt ?? now;

  await deps.setConsecutiveHealthFailures(consecutiveFailures);
  if (storedFirstFailureAt == null) {
    await deps.setFirstHealthFailureAt(firstFailureAt);
  }

  // Mark the start of the unhealthy episode on its first failure. This marker
  // survives auto-restarts (which clear firstHealthFailureAt) so the recovery
  // event can report whole-episode downtime.
  if ((await deps.getUnhealthyEpisodeStartedAt()) == null) {
    await deps.setUnhealthyEpisodeStartedAt(now);
  }

  if (consecutiveFailures === CONTAINER_HEALTH_FAILURE_THRESHOLD) {
    safeLog(deps, {
      event: 'container.health_ping',
      townId: deps.townId,
      reason: deps.outcome.reason,
      consecutiveFailures,
      statusCode: deps.outcome.statusCode,
      error: deps.outcome.error,
      durationMs: deps.outcome.durationMs,
    });
  }

  if (consecutiveFailures < CONTAINER_HEALTH_FAILURE_THRESHOLD) return;

  if (deps.isDraining()) {
    safeLog(deps, {
      event: 'container.auto_restart_skipped',
      townId: deps.townId,
      reason: 'draining',
      consecutiveFailures,
      statusCode: deps.outcome.statusCode,
      durationMs: deps.outcome.durationMs,
    });
    return;
  }

  if (now - firstFailureAt <= CONTAINER_HEALTH_COLD_START_GRACE_MS) {
    // Attribute a later recovery to cold-start grace, but never downgrade an
    // episode that already performed an auto_restart (a restart is stronger).
    if ((await deps.getRecoveryPathHint()) !== 'auto_restart') {
      await deps.setRecoveryPathHint('cold_start_grace');
    }
    safeLog(deps, {
      event: 'container.auto_restart_skipped',
      townId: deps.townId,
      reason: 'cold_start_grace',
      consecutiveFailures,
      statusCode: deps.outcome.statusCode,
      durationMs: deps.outcome.durationMs,
    });
    return;
  }

  const lastAutoRestartAt = await deps.getLastAutoRestartAt();
  if (
    lastAutoRestartAt != null &&
    now - lastAutoRestartAt < CONTAINER_HEALTH_AUTO_RESTART_THROTTLE_MS
  ) {
    safeLog(deps, {
      event: 'container.auto_restart_skipped',
      townId: deps.townId,
      reason: 'throttled',
      consecutiveFailures,
      statusCode: deps.outcome.statusCode,
      durationMs: deps.outcome.durationMs,
    });
    return;
  }

  const windowState = await getRestartWindowState(deps, now);
  if (windowState.restartsInWindow >= CONTAINER_HEALTH_MAX_AUTO_RESTARTS_PER_WINDOW) {
    const exhaustedWindowStart = await deps.getAutoRestartExhaustedWindowStart();
    if (exhaustedWindowStart !== windowState.windowStart) {
      await deps.setAutoRestartExhaustedWindowStart(windowState.windowStart);
      const event = {
        event: 'container.auto_restart_exhausted',
        townId: deps.townId,
        reason: deps.outcome.reason,
        value: consecutiveFailures,
        durationMs: deps.outcome.durationMs,
        statusCode: deps.outcome.statusCode,
      } satisfies GastownEventData;
      safeWriteEvent(deps, event);
      safeLog(deps, {
        event: 'container.auto_restart_exhausted',
        townId: deps.townId,
        reason: deps.outcome.reason,
        consecutiveFailures,
        statusCode: deps.outcome.statusCode,
        durationMs: deps.outcome.durationMs,
      });
    }
    return;
  }

  const reason = `health_ping_${deps.outcome.reason}`;
  try {
    safeLog(deps, {
      event: 'container.auto_restart',
      townId: deps.townId,
      reason,
      consecutiveFailures,
      statusCode: deps.outcome.statusCode,
      durationMs: deps.outcome.durationMs,
    });
    await deps.getContainerStub(deps.townId).destroy();
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    safeWriteEvent(deps, {
      event: 'container.auto_restart',
      townId: deps.townId,
      reason,
      value: consecutiveFailures,
      durationMs: deps.outcome.durationMs,
      statusCode: deps.outcome.statusCode,
      error,
    });
    safeLog(deps, {
      event: 'container.auto_restart',
      townId: deps.townId,
      reason,
      consecutiveFailures,
      statusCode: deps.outcome.statusCode,
      durationMs: deps.outcome.durationMs,
      error,
    });
    return;
  }

  await deps.setLastAutoRestartAt(now);
  await deps.setAutoRestartWindowStart(windowState.windowStart);
  await deps.setAutoRestartsInWindow(windowState.restartsInWindow + 1);
  await deps.setConsecutiveHealthFailures(0);
  await deps.deleteFirstHealthFailureAt();
  await deps.setRecoveryPathHint('auto_restart');

  safeWriteEvent(deps, {
    event: 'container.auto_restart',
    townId: deps.townId,
    reason,
    value: consecutiveFailures,
    durationMs: deps.outcome.durationMs,
    statusCode: deps.outcome.statusCode,
  });
}

/**
 * On the first successful ping after an unhealthy episode, emit
 * `container.health_recovered` (to AE + Logpush) then clear the episode markers.
 *
 * `consecutiveFailures` reports the failing streak that just ended. Note it is
 * the POST-last-restart streak — an auto_restart resets the counter, so a clean
 * recovery right after a restart reports 0. `downtimeMs` spans the WHOLE episode
 * from the persistent marker, independent of restarts.
 */
async function emitRecoveryIfEpisodeEnded(deps: ContainerHealthWatchdogDeps): Promise<void> {
  const episodeStartedAt = await deps.getUnhealthyEpisodeStartedAt();
  if (episodeStartedAt == null) return;

  const now = deps.now();
  const consecutiveFailures = (await deps.getConsecutiveHealthFailures()) ?? 0;
  const recoveredAfter: ContainerRecoveredAfter = (await deps.getRecoveryPathHint()) ?? 'self';
  const downtimeMs = now - episodeStartedAt;

  safeWriteEvent(deps, {
    event: 'container.health_recovered',
    townId: deps.townId,
    reason: recoveredAfter,
    value: consecutiveFailures,
    durationMs: downtimeMs,
  });
  safeLog(deps, {
    event: 'container.health_recovered',
    townId: deps.townId,
    reason: recoveredAfter,
    consecutiveFailures,
    durationMs: downtimeMs,
  });

  await deps.deleteUnhealthyEpisodeStartedAt();
  await deps.deleteRecoveryPathHint();
}

async function getRestartWindowState(
  deps: ContainerHealthWatchdogDeps,
  now: number
): Promise<{ windowStart: number; restartsInWindow: number }> {
  const storedWindowStart = await deps.getAutoRestartWindowStart();
  if (
    storedWindowStart == null ||
    now - storedWindowStart >= CONTAINER_HEALTH_AUTO_RESTART_WINDOW_MS
  ) {
    await deps.deleteAutoRestartExhaustedWindowStart();
    return { windowStart: now, restartsInWindow: 0 };
  }

  return {
    windowStart: storedWindowStart,
    restartsInWindow: (await deps.getAutoRestartsInWindow()) ?? 0,
  };
}

function safeWriteEvent(deps: ContainerHealthWatchdogDeps, data: GastownEventData): void {
  try {
    deps.writeEventFn({ containerId: deps.containerDoId, ...data });
  } catch {
    // Best-effort — never throw from watchdog observability.
  }
}

function safeLog(deps: ContainerHealthWatchdogDeps, data: ContainerHealthLogData): void {
  try {
    deps.logWarnFn({ containerId: deps.containerDoId, ...data });
  } catch {
    // Best-effort — never throw from watchdog observability.
  }
}
