import type { RecordCloudAgentSessionHarnessParams } from '@kilocode/session-ingest-contracts';
import { withTimeout } from '@kilocode/worker-utils';
import { logger } from '../../logger.js';

const RECORD_TIMEOUT_MS = 5_000;

/**
 * Records the session's Kilo runtime in the session list at most once per
 * Durable Object instance. The write is idempotent, so a failed record is
 * retried by the next delivery and a new instance records once more.
 */
export function createRuntimeHarnessRecorder(
  record: (params: RecordCloudAgentSessionHarnessParams) => Promise<void>
) {
  let recorded: RecordCloudAgentSessionHarnessParams['runtimeHarness'] | undefined;
  let inFlight: Promise<void> | undefined;

  return function recordRuntimeHarness(
    params: RecordCloudAgentSessionHarnessParams
  ): Promise<void> {
    if (recorded === params.runtimeHarness) return Promise.resolve();
    if (inFlight !== undefined) return inFlight;
    inFlight = withTimeout(
      Promise.resolve().then(() => record(params)),
      RECORD_TIMEOUT_MS,
      'Session runtime record timed out'
    )
      .then(() => {
        recorded = params.runtimeHarness;
      })
      .catch(() => {
        logger
          .withFields({ sessionId: params.cloudAgentSessionId })
          .warn('Session runtime record failed; the next delivery retries');
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
