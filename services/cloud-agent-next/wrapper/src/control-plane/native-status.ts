import type {
  ControlDiagnosticFields,
  ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import type { ControlPlaneConnectionPhase } from './connection.js';

/**
 * Production cadence for the native `wrapper.status` line. It is deliberately
 * not in `resolveControlPlaneTimers` and is not scaled by
 * `CONTROL_PLANE_TIMER_DIVISOR`: the status line must not disappear when the
 * transport it reports on is the thing that is broken.
 */
export const NATIVE_STATUS_INTERVAL_MS = 60_000;

/** The live fields the status assembler reads from the wrapper owners. */
export type NativeStatusSnapshot = ControlDiagnosticFields & {
  nativeConnectionPhase: ControlPlaneConnectionPhase;
  attempt: number;
  outboxBytes: number;
  sessionCount: number;
  preparingCount: number;
  activeTurnCount: number;
  recentTerminalCount: number;
  runtimeCount: number;
  suspectedCount: number;
  restartingCount: number;
  unavailableCount: number;
};

export type NativeStatusScheduler = {
  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
};

export type NativeStatusReporterOptions = {
  enabled: boolean;
  project: ControlDiagnosticReporter;
  snapshot: () => NativeStatusSnapshot | Promise<NativeStatusSnapshot>;
  scheduler?: NativeStatusScheduler;
};

export type NativeStatusReporter = {
  start(): void;
  stop(): void;
};

/**
 * The native status timer. It is not a logger: it calls the existing native
 * projector directly. The tick is single-flight, so an overlapping interval
 * neither starts a second snapshot nor queues one, and `stop()` is terminal so a
 * snapshot that resolves after it does not write.
 */
export function createNativeStatusReporter(
  options: NativeStatusReporterOptions
): NativeStatusReporter {
  const scheduler = options.scheduler ?? { setInterval, clearInterval };
  let handle: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const snapshot = await options.snapshot();
      if (stopped) return;
      // The envelope is applied after the owner read, so an owner field named
      // `phase` or `elapsedMs` cannot overwrite it.
      options.project('wrapper.status', {
        ...snapshot,
        phase: 'status',
        elapsedMs: Math.round(process.uptime() * 1000),
      });
    } catch {
      // The status line must never disturb the wrapper.
    } finally {
      inFlight = false;
    }
  }

  return {
    start(): void {
      if (!options.enabled || stopped || handle !== undefined) return;
      handle = scheduler.setInterval(() => {
        void tick();
      }, NATIVE_STATUS_INTERVAL_MS);
      handle.unref?.();
    },
    stop(): void {
      stopped = true;
      if (handle !== undefined) scheduler.clearInterval(handle);
      handle = undefined;
    },
  };
}
