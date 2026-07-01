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
} as const;

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
  reason?: string;
  consecutiveFailures?: number;
  statusCode?: number;
  error?: string;
  durationMs?: number;
};

export type ContainerHealthWatchdogDeps = {
  townId: string;
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
    safeLog(deps, {
      event: 'container.health_watchdog_error',
      townId: deps.townId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function recoverContainerIfWedgedInner(deps: ContainerHealthWatchdogDeps): Promise<void> {
  if (deps.outcome.ok) {
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

  safeWriteEvent(deps, {
    event: 'container.auto_restart',
    townId: deps.townId,
    reason,
    value: consecutiveFailures,
    durationMs: deps.outcome.durationMs,
    statusCode: deps.outcome.statusCode,
  });
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
    deps.writeEventFn(data);
  } catch {
    // Best-effort — never throw from watchdog observability.
  }
}

function safeLog(deps: ContainerHealthWatchdogDeps, data: ContainerHealthLogData): void {
  try {
    deps.logWarnFn(data);
  } catch {
    // Best-effort — never throw from watchdog observability.
  }
}
