import { z } from 'zod';
import {
  recordCloudAgentSessionHarnessSchema,
  type RecordCloudAgentSessionHarnessParams,
} from '@kilocode/session-ingest-contracts';
import { withTimeout } from '@kilocode/worker-utils';
import { logger } from '../../logger.js';

const RECORD_TIMEOUT_MS = 5_000;
const RECORD_KEY = 'session_runtime_harness';
export const RUNTIME_HARNESS_RETRY_MS = 30_000;
export const RUNTIME_HARNESS_MAX_ATTEMPTS = 10;

const storedRecordSchema = z.object({
  update: recordCloudAgentSessionHarnessSchema,
  attempts: z.number().int().min(0).max(RUNTIME_HARNESS_MAX_ATTEMPTS),
  dueAt: z.number().finite().nullable(),
});

export function createRuntimeHarnessRecorder(input: {
  storage: Pick<DurableObjectStorage, 'kv'>;
  record: (params: RecordCloudAgentSessionHarnessParams) => Promise<boolean>;
}) {
  let inFlight: Promise<void> | undefined;
  const current = () => {
    const raw = input.storage.kv.get<unknown>(RECORD_KEY);
    if (raw === undefined) return undefined;
    const parsed = storedRecordSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    input.storage.kv.delete(RECORD_KEY);
    logger.warn('Discarded invalid session runtime record');
    return undefined;
  };

  function record(update: RecordCloudAgentSessionHarnessParams, now = Date.now()): void {
    const snapshot = storedRecordSchema.safeParse({ update, attempts: 0, dueAt: now });
    if (!snapshot.success) {
      logger
        .withFields({ sessionId: update.cloudAgentSessionId })
        .warn('Skipped invalid session runtime record; the turn is unaffected');
      return;
    }
    const previous = current();
    if (
      previous?.update.runtimeHarness === update.runtimeHarness &&
      (previous.dueAt === null || previous.attempts < RUNTIME_HARNESS_MAX_ATTEMPTS)
    )
      return;
    input.storage.kv.put(RECORD_KEY, snapshot.data);
  }

  async function deliver(now: number): Promise<void> {
    const pending = current();
    if (pending === undefined || pending.dueAt === null || pending.dueAt > now) return;
    const log = logger.withFields({ sessionId: pending.update.cloudAgentSessionId });
    if (pending.attempts >= RUNTIME_HARNESS_MAX_ATTEMPTS) {
      input.storage.kv.delete(RECORD_KEY);
      log.warn('Session runtime record retry limit reached; a later delivery can retry');
      return;
    }
    // Reserve the retry before external I/O so eviction cannot lose the obligation.
    input.storage.kv.put(RECORD_KEY, {
      ...pending,
      attempts: pending.attempts + 1,
      dueAt: now + RUNTIME_HARNESS_RETRY_MS,
    });
    try {
      const applied = await withTimeout(
        input.record(pending.update),
        RECORD_TIMEOUT_MS,
        'Session runtime record timed out'
      );
      if (applied === true) {
        if (current()?.update.runtimeHarness === pending.update.runtimeHarness) {
          input.storage.kv.put(RECORD_KEY, { ...pending, dueAt: null });
        }
      } else if (pending.attempts === 0) {
        log.warn('Session runtime record matched no row; retry scheduled');
      }
    } catch {
      if (pending.attempts === 0) log.warn('Session runtime record failed; retry scheduled');
    }
  }

  function repair(now = Date.now()): Promise<void> {
    if (inFlight !== undefined) return inFlight;
    inFlight = deliver(now).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return { record, repair, nextDueAt: () => current()?.dueAt ?? null };
}
