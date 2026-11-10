import {
  ENVIRONMENT_BUILD_LOG_BATCH_MAX_BYTES,
  ENVIRONMENT_BUILD_LOG_BATCH_MAX_LINES,
  ENVIRONMENT_BUILD_LOG_LINE_MAX_CHARS,
  type EnvironmentBuildRunnerStep,
} from '../../../src/shared/environment-build-protocol.js';
import type { BuilderClient } from './client.js';

/**
 * Batches redacted build output and reports liveness. One flush per interval
 * sends the current step, the buffered lines and an implicit heartbeat. A failed
 * flush keeps its lines for the next one; the buffer is bounded and drops the
 * oldest lines with one marker, so a slow endpoint cannot grow the builder's
 * memory. A `cancel` reply aborts the build.
 */

/** Unsent output retained while the endpoint is unreachable. */
const MAX_PENDING_BYTES = 1024 * 1024;
const DROPPED_MARKER = '[earlier output dropped while the build endpoint was unreachable]';

export type BuildReporter = {
  setStep(step: EnvironmentBuildRunnerStep): void;
  line(text: string): void;
  /** Send everything buffered now; resolves after the call settles. */
  flush(): Promise<void>;
  start(): void;
  stop(): void;
};

export function createBuildReporter(deps: {
  client: Pick<BuilderClient, 'events'>;
  intervalMs: number;
  onCancel: () => void;
  log: (message: string) => void;
}): BuildReporter {
  let sequence = 0;
  let step: EnvironmentBuildRunnerStep | undefined;
  let stepSent = true;
  let pending: string[] = [];
  let pendingBytes = 0;
  let dropped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  function take(): string[] {
    const batch: string[] = [];
    let bytes = 0;
    if (dropped) {
      batch.push(DROPPED_MARKER);
      dropped = false;
      bytes = Buffer.byteLength(DROPPED_MARKER, 'utf8');
    }
    while (pending.length > 0 && batch.length < ENVIRONMENT_BUILD_LOG_BATCH_MAX_LINES) {
      const next = pending[0];
      const size = Buffer.byteLength(next, 'utf8');
      if (batch.length > 0 && bytes + size > ENVIRONMENT_BUILD_LOG_BATCH_MAX_BYTES) break;
      batch.push(next);
      bytes += size;
      pending.shift();
      pendingBytes -= size;
    }
    return batch;
  }

  async function send(): Promise<void> {
    const logs = take();
    const batchStep = stepSent ? undefined : step;
    stepSent = true;
    try {
      const reply = await deps.client.events({
        sequence: sequence++,
        ...(batchStep === undefined ? {} : { step: batchStep }),
        ...(logs.length === 0 ? {} : { logs }),
      });
      if (reply.action === 'cancel') deps.onCancel();
    } catch (error) {
      // Retain what was not delivered; the next flush sends it again under a new
      // sequence, which the coordinator applies once.
      pending = [...logs.filter(line => line !== DROPPED_MARKER), ...pending];
      pendingBytes = pending.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0);
      if (batchStep !== undefined) stepSent = false;
      deps.log(
        `environment builder events failed: ${error instanceof Error ? error.message : 'unknown'}`
      );
    }
  }

  function flush(): Promise<void> {
    const previous = inFlight ?? Promise.resolve();
    const next = previous.then(send);
    inFlight = next.finally(() => {
      if (inFlight === next) inFlight = undefined;
    });
    return next;
  }

  return {
    setStep(next) {
      step = next;
      stepSent = false;
    },
    line(text) {
      const bounded =
        text.length > ENVIRONMENT_BUILD_LOG_LINE_MAX_CHARS
          ? `${text.slice(0, ENVIRONMENT_BUILD_LOG_LINE_MAX_CHARS - 1)}…`
          : text;
      pending.push(bounded);
      pendingBytes += Buffer.byteLength(bounded, 'utf8');
      while (pendingBytes > MAX_PENDING_BYTES && pending.length > 1) {
        const removed = pending.shift() as string;
        pendingBytes -= Buffer.byteLength(removed, 'utf8');
        dropped = true;
      }
    },
    flush,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void flush(), deps.intervalMs);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
