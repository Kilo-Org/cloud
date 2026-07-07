import { describe, it, expect, vi } from 'vitest';
import {
  CONTAINER_HEALTH_AUTO_RESTART_THROTTLE_MS,
  CONTAINER_HEALTH_AUTO_RESTART_WINDOW_MS,
  CONTAINER_HEALTH_COLD_START_GRACE_MS,
  CONTAINER_HEALTH_FAILURE_THRESHOLD,
  CONTAINER_HEALTH_MAX_AUTO_RESTARTS_PER_WINDOW,
  CONTAINER_HEALTH_STORAGE_KEYS,
  recoverContainerIfWedged,
  type ContainerHealthLogData,
  type ContainerHealthPingOutcome,
  type ContainerHealthWatchdogDeps,
  type ContainerRecoveryPathHint,
} from './container-health-watchdog';
import type { GastownEventData } from '../../util/analytics.util';

type TestDeps = ContainerHealthWatchdogDeps & {
  _destroyFn: ReturnType<typeof vi.fn>;
  _store: Map<string, number>;
  _events: GastownEventData[];
  _logs: ContainerHealthLogData[];
  _setOutcome: (outcome: ContainerHealthPingOutcome) => void;
  _setNow: (value: number) => void;
};

function failedOutcome(
  overrides: Partial<Extract<ContainerHealthPingOutcome, { ok: false }>> = {}
) {
  return {
    ok: false,
    reason: overrides.reason ?? 'timeout',
    durationMs: overrides.durationMs ?? 5_000,
    statusCode: overrides.statusCode,
    error: overrides.error ?? 'timeout',
  } satisfies ContainerHealthPingOutcome;
}

function successOutcome(): ContainerHealthPingOutcome {
  return {
    ok: true,
    durationMs: 25,
    statusCode: 200,
  };
}

function makeDeps(
  overrides: Partial<
    Pick<
      ContainerHealthWatchdogDeps,
      'isDraining' | 'getContainerStub' | 'writeEventFn' | 'logWarnFn'
    >
  > = {}
): TestDeps {
  const store = new Map<string, number>();
  const events: GastownEventData[] = [];
  const logs: ContainerHealthLogData[] = [];
  const destroyFn = vi.fn().mockResolvedValue(undefined);
  let recoveryPathHint: ContainerRecoveryPathHint | undefined;
  let outcome: ContainerHealthPingOutcome = failedOutcome();
  let currentTime = CONTAINER_HEALTH_COLD_START_GRACE_MS + 1;

  return {
    townId: 'town-1',
    containerDoId: 'container-do-abc',
    get outcome() {
      return outcome;
    },
    isDraining: overrides.isDraining ?? (() => false),
    getConsecutiveHealthFailures: () =>
      Promise.resolve(store.get(CONTAINER_HEALTH_STORAGE_KEYS.consecutiveHealthFailures)),
    setConsecutiveHealthFailures: value => {
      store.set(CONTAINER_HEALTH_STORAGE_KEYS.consecutiveHealthFailures, value);
      return Promise.resolve();
    },
    getFirstHealthFailureAt: () =>
      Promise.resolve(store.get(CONTAINER_HEALTH_STORAGE_KEYS.firstHealthFailureAt)),
    setFirstHealthFailureAt: value => {
      store.set(CONTAINER_HEALTH_STORAGE_KEYS.firstHealthFailureAt, value);
      return Promise.resolve();
    },
    deleteFirstHealthFailureAt: () =>
      Promise.resolve(store.delete(CONTAINER_HEALTH_STORAGE_KEYS.firstHealthFailureAt)),
    getLastAutoRestartAt: () =>
      Promise.resolve(store.get(CONTAINER_HEALTH_STORAGE_KEYS.lastAutoRestartAt)),
    setLastAutoRestartAt: value => {
      store.set(CONTAINER_HEALTH_STORAGE_KEYS.lastAutoRestartAt, value);
      return Promise.resolve();
    },
    getAutoRestartWindowStart: () =>
      Promise.resolve(store.get(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartWindowStart)),
    setAutoRestartWindowStart: value => {
      store.set(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartWindowStart, value);
      return Promise.resolve();
    },
    getAutoRestartsInWindow: () =>
      Promise.resolve(store.get(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartsInWindow)),
    setAutoRestartsInWindow: value => {
      store.set(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartsInWindow, value);
      return Promise.resolve();
    },
    getAutoRestartExhaustedWindowStart: () =>
      Promise.resolve(store.get(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartExhaustedWindowStart)),
    setAutoRestartExhaustedWindowStart: value => {
      store.set(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartExhaustedWindowStart, value);
      return Promise.resolve();
    },
    deleteAutoRestartExhaustedWindowStart: () =>
      Promise.resolve(store.delete(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartExhaustedWindowStart)),
    getUnhealthyEpisodeStartedAt: () =>
      Promise.resolve(store.get(CONTAINER_HEALTH_STORAGE_KEYS.unhealthyEpisodeStartedAt)),
    setUnhealthyEpisodeStartedAt: value => {
      store.set(CONTAINER_HEALTH_STORAGE_KEYS.unhealthyEpisodeStartedAt, value);
      return Promise.resolve();
    },
    deleteUnhealthyEpisodeStartedAt: () =>
      Promise.resolve(store.delete(CONTAINER_HEALTH_STORAGE_KEYS.unhealthyEpisodeStartedAt)),
    getRecoveryPathHint: () => Promise.resolve(recoveryPathHint),
    setRecoveryPathHint: value => {
      recoveryPathHint = value;
      return Promise.resolve();
    },
    deleteRecoveryPathHint: () => {
      recoveryPathHint = undefined;
      return Promise.resolve(true);
    },
    getContainerStub:
      overrides.getContainerStub ??
      (() => ({
        destroy: destroyFn,
      })),
    writeEventFn:
      overrides.writeEventFn ??
      (data => {
        events.push(data);
      }),
    logWarnFn:
      overrides.logWarnFn ??
      (data => {
        logs.push(data);
      }),
    now: () => currentTime,
    _destroyFn: destroyFn,
    _store: store,
    _events: events,
    _logs: logs,
    _setOutcome: value => {
      outcome = value;
    },
    _setNow: value => {
      currentTime = value;
    },
  };
}

function seedRestartReadyFailureState(deps: TestDeps, firstFailureAt: number): void {
  deps._store.set(
    CONTAINER_HEALTH_STORAGE_KEYS.consecutiveHealthFailures,
    CONTAINER_HEALTH_FAILURE_THRESHOLD - 1
  );
  deps._store.set(CONTAINER_HEALTH_STORAGE_KEYS.firstHealthFailureAt, firstFailureAt);
}

async function triggerRestartReadyFailure(deps: TestDeps, now: number): Promise<void> {
  deps._setNow(now);
  seedRestartReadyFailureState(deps, now - CONTAINER_HEALTH_COLD_START_GRACE_MS - 1);
  await recoverContainerIfWedged(deps);
}

describe('recoverContainerIfWedged', () => {
  it('does not restart below threshold, then restarts once threshold and grace both pass', async () => {
    const deps = makeDeps();
    deps._setNow(0);
    await recoverContainerIfWedged(deps);
    deps._setNow(5_000);
    await recoverContainerIfWedged(deps);

    expect(deps._destroyFn).not.toHaveBeenCalled();

    deps._setNow(CONTAINER_HEALTH_COLD_START_GRACE_MS + 1);
    await recoverContainerIfWedged(deps);

    expect(deps._destroyFn).toHaveBeenCalledTimes(1);
    expect(deps._events).toHaveLength(1);
    expect(deps._events[0]).toMatchObject({
      event: 'container.auto_restart',
      townId: 'town-1',
      containerId: 'container-do-abc',
      reason: 'health_ping_timeout',
      value: CONTAINER_HEALTH_FAILURE_THRESHOLD,
    });
    // The Cloudflare container id is stamped on both sinks for support debugging.
    expect(deps._logs).toContainEqual(
      expect.objectContaining({ event: 'container.auto_restart', containerId: 'container-do-abc' })
    );
    expect(deps._store.get(CONTAINER_HEALTH_STORAGE_KEYS.consecutiveHealthFailures)).toBe(0);
  });

  it('resets the consecutive counter on success', async () => {
    const deps = makeDeps();
    deps._setNow(0);
    await recoverContainerIfWedged(deps);

    deps._setOutcome(successOutcome());
    await recoverContainerIfWedged(deps);

    deps._setOutcome(failedOutcome());
    deps._setNow(CONTAINER_HEALTH_COLD_START_GRACE_MS + 1);
    await recoverContainerIfWedged(deps);
    await recoverContainerIfWedged(deps);

    expect(deps._destroyFn).not.toHaveBeenCalled();
    expect(deps._store.get(CONTAINER_HEALTH_STORAGE_KEYS.consecutiveHealthFailures)).toBe(2);
    expect(deps._store.has(CONTAINER_HEALTH_STORAGE_KEYS.firstHealthFailureAt)).toBe(true);
  });

  it('does not restart while draining', async () => {
    const deps = makeDeps({ isDraining: () => true });
    await triggerRestartReadyFailure(deps, CONTAINER_HEALTH_COLD_START_GRACE_MS + 1);

    expect(deps._destroyFn).not.toHaveBeenCalled();
    expect(deps._logs).toContainEqual(
      expect.objectContaining({
        event: 'container.auto_restart_skipped',
        reason: 'draining',
      })
    );
  });

  it('does not restart before the cold-start grace span has elapsed', async () => {
    const deps = makeDeps();
    deps._setNow(10_000);
    await recoverContainerIfWedged(deps);
    await recoverContainerIfWedged(deps);
    await recoverContainerIfWedged(deps);

    expect(deps._destroyFn).not.toHaveBeenCalled();
    expect(deps._logs).toContainEqual(
      expect.objectContaining({
        event: 'container.auto_restart_skipped',
        reason: 'cold_start_grace',
      })
    );
  });

  it('throttles repeated restart triggers inside the throttle window', async () => {
    const deps = makeDeps();
    await triggerRestartReadyFailure(deps, CONTAINER_HEALTH_COLD_START_GRACE_MS + 1);

    await triggerRestartReadyFailure(
      deps,
      CONTAINER_HEALTH_COLD_START_GRACE_MS + CONTAINER_HEALTH_AUTO_RESTART_THROTTLE_MS
    );

    expect(deps._destroyFn).toHaveBeenCalledTimes(1);
    expect(deps._logs).toContainEqual(
      expect.objectContaining({
        event: 'container.auto_restart_skipped',
        reason: 'throttled',
      })
    );
  });

  it('stops restarting after the fixed-window cap and emits exhausted once per window', async () => {
    const deps = makeDeps();
    let now = CONTAINER_HEALTH_COLD_START_GRACE_MS + 1;

    for (let i = 0; i < CONTAINER_HEALTH_MAX_AUTO_RESTARTS_PER_WINDOW; i += 1) {
      await triggerRestartReadyFailure(deps, now);
      now += CONTAINER_HEALTH_AUTO_RESTART_THROTTLE_MS + 1;
    }
    await triggerRestartReadyFailure(deps, now);
    await triggerRestartReadyFailure(deps, now + CONTAINER_HEALTH_AUTO_RESTART_THROTTLE_MS + 1);

    expect(deps._destroyFn).toHaveBeenCalledTimes(CONTAINER_HEALTH_MAX_AUTO_RESTARTS_PER_WINDOW);
    expect(
      deps._events.filter(event => event.event === 'container.auto_restart_exhausted')
    ).toHaveLength(1);
  });

  it('allows restarts again after the fixed window resets', async () => {
    const deps = makeDeps();
    const windowStart = CONTAINER_HEALTH_COLD_START_GRACE_MS + 1;
    let now = windowStart;

    for (let i = 0; i < CONTAINER_HEALTH_MAX_AUTO_RESTARTS_PER_WINDOW; i += 1) {
      await triggerRestartReadyFailure(deps, now);
      now += CONTAINER_HEALTH_AUTO_RESTART_THROTTLE_MS + 1;
    }

    await triggerRestartReadyFailure(
      deps,
      windowStart + CONTAINER_HEALTH_AUTO_RESTART_WINDOW_MS + 1
    );

    expect(deps._destroyFn).toHaveBeenCalledTimes(
      CONTAINER_HEALTH_MAX_AUTO_RESTARTS_PER_WINDOW + 1
    );
    expect(deps._store.get(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartsInWindow)).toBe(1);
  });

  it('emits an error event without advancing throttle state when destroy throws', async () => {
    const destroyFn = vi.fn().mockRejectedValue(new Error('destroy failed'));
    const deps = makeDeps({
      getContainerStub: () => ({
        destroy: destroyFn,
      }),
    });

    await triggerRestartReadyFailure(deps, CONTAINER_HEALTH_COLD_START_GRACE_MS + 1);

    expect(destroyFn).toHaveBeenCalledTimes(1);
    expect(deps._events).toHaveLength(1);
    expect(deps._events[0]).toMatchObject({
      event: 'container.auto_restart',
      error: 'destroy failed',
    });
    expect(deps._store.has(CONTAINER_HEALTH_STORAGE_KEYS.lastAutoRestartAt)).toBe(false);
  });

  it('emits health_recovered with recoveredAfter=auto_restart after a restart heals', async () => {
    const deps = makeDeps();
    await triggerRestartReadyFailure(deps, CONTAINER_HEALTH_COLD_START_GRACE_MS + 1);
    expect(deps._destroyFn).toHaveBeenCalledTimes(1);

    deps._setOutcome(successOutcome());
    deps._setNow(CONTAINER_HEALTH_COLD_START_GRACE_MS + 10_000);
    await recoverContainerIfWedged(deps);

    const recovered = deps._events.find(e => e.event === 'container.health_recovered');
    // consecutiveFailures is 0 here: the auto_restart reset the streak counter,
    // and the very next ping succeeded — the post-last-restart streak semantic.
    expect(recovered).toMatchObject({
      event: 'container.health_recovered',
      townId: 'town-1',
      reason: 'auto_restart',
      value: 0,
    });
    expect(recovered?.durationMs ?? 0).toBeGreaterThan(0);
    expect(deps._logs).toContainEqual(
      expect.objectContaining({ event: 'container.health_recovered', reason: 'auto_restart' })
    );
    // Episode markers cleared so a subsequent success does not re-emit recovery.
    expect(deps._store.has(CONTAINER_HEALTH_STORAGE_KEYS.unhealthyEpisodeStartedAt)).toBe(false);
    await recoverContainerIfWedged(deps);
    expect(deps._events.filter(e => e.event === 'container.health_recovered')).toHaveLength(1);
  });

  it('emits health_recovered with recoveredAfter=self for sub-threshold flapping', async () => {
    const deps = makeDeps();
    deps._setNow(1_000);
    await recoverContainerIfWedged(deps);
    deps._setNow(2_000);
    await recoverContainerIfWedged(deps);

    deps._setOutcome(successOutcome());
    deps._setNow(5_000);
    await recoverContainerIfWedged(deps);

    expect(deps._destroyFn).not.toHaveBeenCalled();
    expect(deps._events).toContainEqual(
      expect.objectContaining({
        event: 'container.health_recovered',
        reason: 'self',
        value: 2,
        durationMs: 4_000,
      })
    );
  });

  it('emits health_recovered with recoveredAfter=cold_start_grace when only a grace-skip occurred', async () => {
    const deps = makeDeps();
    deps._setNow(1_000);
    await recoverContainerIfWedged(deps);
    deps._setNow(2_000);
    await recoverContainerIfWedged(deps);
    deps._setNow(3_000);
    await recoverContainerIfWedged(deps);

    expect(deps._destroyFn).not.toHaveBeenCalled();
    expect(deps._logs).toContainEqual(
      expect.objectContaining({
        event: 'container.auto_restart_skipped',
        reason: 'cold_start_grace',
      })
    );

    deps._setOutcome(successOutcome());
    deps._setNow(10_000);
    await recoverContainerIfWedged(deps);

    expect(deps._events).toContainEqual(
      expect.objectContaining({
        event: 'container.health_recovered',
        reason: 'cold_start_grace',
        value: CONTAINER_HEALTH_FAILURE_THRESHOLD,
        durationMs: 9_000,
      })
    );
  });

  it('does not emit health_recovered on a clean success with no prior episode', async () => {
    const deps = makeDeps();
    deps._setOutcome(successOutcome());
    deps._setNow(1_000);
    await recoverContainerIfWedged(deps);

    expect(deps._events).toHaveLength(0);
    expect(deps._logs).toHaveLength(0);
  });

  it('writes container.health_watchdog_error to AE and Logpush when the watchdog throws', async () => {
    const deps = makeDeps({
      isDraining: () => {
        throw new Error('boom');
      },
    });

    await triggerRestartReadyFailure(deps, CONTAINER_HEALTH_COLD_START_GRACE_MS + 1);

    expect(deps._events).toContainEqual(
      expect.objectContaining({ event: 'container.health_watchdog_error', error: 'boom' })
    );
    expect(deps._logs).toContainEqual(
      expect.objectContaining({ event: 'container.health_watchdog_error', error: 'boom' })
    );
  });
});
