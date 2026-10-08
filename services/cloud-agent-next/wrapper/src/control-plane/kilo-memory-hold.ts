import type { ControlDiagnosticReporter } from '../../../src/shared/control-diagnostics.js';
import { readWorkloadStats, type ControlWorkload } from '../control/workload-cgroup.js';

/** Usage this close to the cap counts as pinned at it while the `max` counter rises. */
export const MEMORY_PRESSURE_MARGIN_BYTES = 256 * 1024 * 1024;
/**
 * Quiet samples in a row that end a hold. Kilo is still paging its working set back in right
 * after an OOM kill frees memory, so one quiet sample with a slow probe is not a hang.
 */
const QUIET_SAMPLES_TO_CLEAR = 2;

export type KiloMemorySample = {
  currentBytes: number;
  limitBytes: number;
  /** `memory.events` `max`: charges that hit the cap and had to reclaim. */
  maxEvents: number;
};

export type KiloMemoryHoldOutcome = 'recovered' | 'cleared' | 'expired' | 'restarted' | 'stopped';

/**
 * Reclaiming at the cap between two samples. A cap filled by idle page cache does not raise
 * the `max` counter, so a genuine hang after a large build is not mistaken for pressure.
 */
export function isUnderMemoryPressure(previous: KiloMemorySample, next: KiloMemorySample): boolean {
  return (
    next.maxEvents > previous.maxEvents &&
    next.currentBytes >= next.limitBytes - MEMORY_PRESSURE_MARGIN_BYTES
  );
}

/** Samples the shared workload parent, whose `memory.max` is the cap Kilo shares with tools. */
export function workloadMemorySampler(
  workload: ControlWorkload | undefined
): () => KiloMemorySample | undefined {
  const placement = workload?.placement;
  if (!placement) return () => undefined;
  return () => {
    const stats = readWorkloadStats(placement.parentReference);
    if (stats.currentBytes === undefined || stats.memoryMaxEvents === undefined) return undefined;
    return {
      currentBytes: stats.currentBytes,
      limitBytes: placement.aggregateMaxBytes,
      maxEvents: stats.memoryMaxEvents,
    };
  };
}

export type KiloMemoryHold = {
  /**
   * One sample per watchdog check, the hold's only sampling cadence. `healthy` (Kilo delivers
   * events and its activity is observable) ends a hold as recovered; a hold past `holdMs` ends
   * as expired, and the episode cannot hold again until Kilo is healthy or replaced.
   */
  sample(now: number, healthy: boolean): void;
  /**
   * A hang restart is due. True keeps Kilo running while the workload reclaims at its cap, for
   * at most `holdMs` per episode, and until reclaim has stopped for two samples in a row; false
   * ends any hold, and the caller restarts as before. Callers in the same check get one answer.
   */
  holds(now: number): boolean;
  /** Ends a running hold because Kilo was replaced or stopped. */
  release(now: number, outcome: 'restarted' | 'stopped'): void;
};

export function createKiloMemoryHold(deps: {
  directory: string;
  holdMs: number;
  sample: () => KiloMemorySample | undefined;
  log: (message: string) => void;
  report?: ControlDiagnosticReporter;
  onHeld?: (held: boolean) => void;
}): KiloMemoryHold {
  let latest: KiloMemorySample | undefined;
  let pressured = false;
  let heldSince: number | undefined;
  let quietSamples = 0;
  /** An expired hold spends the episode; a healthy Kilo or a restart starts a new one. */
  let spent = false;

  function sampleFields(sample: KiloMemorySample | undefined) {
    return sample === undefined
      ? {}
      : {
          currentBytes: sample.currentBytes,
          aggregateMaxBytes: sample.limitBytes,
          memoryMaxEvents: sample.maxEvents,
        };
  }

  function start(now: number): void {
    heldSince = now;
    quietSamples = 0;
    deps.log(
      `control-plane kilo memory hold started directory=${deps.directory} currentBytes=${latest?.currentBytes} limitBytes=${latest?.limitBytes}`
    );
    deps.report?.('wrapper.lifecycle', {
      phase: 'kilo_memory_hold_started',
      ...sampleFields(latest),
    });
    deps.onHeld?.(true);
  }

  function end(now: number, outcome: KiloMemoryHoldOutcome): void {
    if (heldSince === undefined) return;
    const heldMs = Math.max(0, now - heldSince);
    heldSince = undefined;
    quietSamples = 0;
    if (outcome === 'expired') spent = true;
    deps.log(
      `control-plane kilo memory hold ended directory=${deps.directory} outcome=${outcome} heldMs=${heldMs}`
    );
    deps.report?.('wrapper.lifecycle', {
      phase: 'kilo_memory_hold_ended',
      memoryHoldOutcome: outcome,
      elapsedMs: heldMs,
      ...sampleFields(latest),
    });
    deps.onHeld?.(false);
  }

  return {
    sample(now, healthy) {
      const previous = latest;
      latest = deps.sample();
      pressured =
        previous !== undefined && latest !== undefined && isUnderMemoryPressure(previous, latest);
      if (healthy) {
        end(now, 'recovered');
        spent = false;
        return;
      }
      if (heldSince === undefined) return;
      if (now - heldSince >= deps.holdMs) {
        end(now, 'expired');
        return;
      }
      quietSamples = pressured ? 0 : quietSamples + 1;
    },
    holds(now) {
      if (heldSince !== undefined) {
        if (now - heldSince >= deps.holdMs) {
          end(now, 'expired');
          return false;
        }
        if (quietSamples < QUIET_SAMPLES_TO_CLEAR) return true;
        end(now, 'cleared');
        return false;
      }
      if (spent || !pressured) return false;
      start(now);
      return true;
    },
    release(now, outcome) {
      end(now, outcome);
      spent = false;
    },
  };
}
