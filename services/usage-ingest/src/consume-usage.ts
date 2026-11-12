import {
  ENKRYPT_USAGE_WRITE_PATH,
  EXA_USAGE_WRITE_PATH,
  type LlmUsageQueueMessage,
} from '@kilocode/usage-contracts';
import {
  recordLlmUsage,
  recordEnkryptUsage,
  recordExaUsage,
  type EnkryptUsageWriteOutcome,
  type ExaUsageWriteOutcome,
  type LlmUsageWriteOutcome,
} from '@kilocode/worker-utils/usage-writer-client';
import type { Env } from './publish-usage';
import { logSafely, queueMetrics } from './diagnostics';
import { parseQueuedUsage, type QueuedUsage } from './queued-usage';
import { usageRetryDelaySeconds } from './retry-policy';

const INVOCATION_BUDGET_MS = 840_000;
const MIN_LAUNCH_REMAINING_MS = 180_000;

// Select a stable baseline without consuming the randomness used by retry policy.
function sampleDelivery(messageId: string, attempts: number): boolean {
  let hash = 0;
  for (const char of `${messageId}:${attempts}`) {
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  }
  return hash % 100 === 0;
}

type Diagnostics = { batch_size: number; handler_entry_at_ms: number };

function diagnosticFields(entryAtMs: number, batch: MessageBatch<unknown>): Diagnostics {
  return { batch_size: batch.messages.length, handler_entry_at_ms: entryAtMs };
}

export function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  return processQueue(batch, env, Date.now(), performance.now());
}

async function processQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  entryAtMs: number,
  startedAtMs: number
): Promise<void> {
  const lastLaunchAtMs = startedAtMs + INVOCATION_BUDGET_MS - MIN_LAUNCH_REMAINING_MS;
  const diagnostics = diagnosticFields(entryAtMs, batch);
  const batchId = crypto.randomUUID();
  const parallelism = env.USAGE_INGEST_PARALLELISM === '2' ? 2 : 1;
  let nextIndex = 0;
  let writerOverloaded = false;
  const unexpectedErrors: unknown[] = [];
  async function runSlot(): Promise<void> {
    while (nextIndex < batch.messages.length) {
      const message = batch.messages[nextIndex++];
      let acknowledged = false;
      let retryDelaySeconds: number | undefined;
      try {
        const result = await processMessage(
          message,
          env,
          batch,
          diagnostics,
          batchId,
          lastLaunchAtMs,
          entryAtMs,
          startedAtMs
        );
        acknowledged = result.acknowledged;
        retryDelaySeconds = result.retryDelaySeconds;
        writerOverloaded ||= result.overloaded;
      } catch (error) {
        unexpectedErrors.push(error);
      }
      // Keep disposition calls outside the processing catch: never retry an ACKed message.
      try {
        if (acknowledged) message.ack();
        else if (retryDelaySeconds !== undefined)
          message.retry({ delaySeconds: retryDelaySeconds });
        else message.retry();
      } catch (error) {
        unexpectedErrors.push(error);
      }
    }
  }
  // Only the fixed number of slots runs concurrently, even for a larger delivered batch.
  await Promise.allSettled(
    Array.from({ length: Math.min(parallelism, batch.messages.length) }, () => runSlot())
  );
  // Explicit ACKs/retries survive rejection; wait for every slot before failing the invocation.
  if (writerOverloaded)
    throw new Error(
      'Usage writer overloaded (HTTP 429/503)' +
        (unexpectedErrors.length > 0 ? `; unexpected errors: ${unexpectedErrors.length}` : ''),
      unexpectedErrors.length > 0 ? { cause: unexpectedErrors[0] } : undefined
    );
  if (unexpectedErrors.length > 0) throw unexpectedErrors[0];
}

const LLM_WRITER_PATH = '/api/internal/usage/record';

/**
 * Non-LLM writers live next to the LLM writer, so their URL replaces the documented path suffix
 * of `USAGE_WRITER_URL`. Any other shape is treated as missing config.
 */
function writerUrlFor(path: string, llmWriterUrl: string | undefined): string | undefined {
  if (!llmWriterUrl?.endsWith(LLM_WRITER_PATH)) return undefined;
  return llmWriterUrl.slice(0, -LLM_WRITER_PATH.length) + path;
}

function recordQueuedUsage(
  usage: Exclude<QueuedUsage, { kind: 'invalid' }>,
  env: Env
): Promise<LlmUsageWriteOutcome | EnkryptUsageWriteOutcome | ExaUsageWriteOutcome> {
  const config = {
    secret: env.USAGE_WRITER_SECRET,
    protectionBypass: env.USAGE_WRITER_PROTECTION_BYPASS,
    source: 'queue',
  } as const;
  if (usage.kind === 'llm') {
    return recordLlmUsage(usage.usage, { url: env.USAGE_WRITER_URL, ...config });
  }
  if (usage.kind === 'exa_usage') {
    return recordExaUsage(usage.record, {
      url: writerUrlFor(EXA_USAGE_WRITE_PATH, env.USAGE_WRITER_URL),
      ...config,
    });
  }
  return recordEnkryptUsage(usage.record, {
    url: writerUrlFor(ENKRYPT_USAGE_WRITE_PATH, env.USAGE_WRITER_URL),
    ...config,
  });
}

/** LLM logs keep their existing fields; only tagged messages add `usage_kind`. */
function usageIdentity(parsed: QueuedUsage, llmFields: (usage: LlmUsageQueueMessage) => object) {
  if (parsed.kind === 'llm') return llmFields(parsed.usage);
  if (parsed.kind === 'enkrypt_usage' || parsed.kind === 'exa_usage') {
    return { usage_id: parsed.record.id, usage_kind: parsed.kind };
  }
  return parsed.usageKind === 'llm' ? {} : { usage_kind: parsed.usageKind };
}

async function processMessage(
  message: Message<unknown>,
  env: Env,
  batch: MessageBatch<unknown>,
  diagnostics: Diagnostics,
  batchId: string,
  lastLaunchAtMs: number,
  entryAtMs: number,
  startedAtMs: number
) {
  const slotWaitMs = Math.max(0, Math.round(performance.now() - startedAtMs));
  const timestampMs = message.timestamp.getTime();
  const queueWaitMs = Math.max(0, Date.now() - timestampMs);
  const handlerEntryQueueAgeMs = Math.max(0, entryAtMs - timestampMs);
  const parsed = parseQueuedUsage(message.body);
  logSafely('info', () => ({
    event: 'usage_ingest_handler_entry',
    queue: batch.queue,
    batch_id: batchId,
    ...diagnostics,
    message_start_at_ms: Date.now(),
    queue_message_id: message.id,
    message_timestamp_ms: message.timestamp.getTime(),
    delivery_attempts: message.attempts,
    ...usageIdentity(parsed, usage => ({
      usage_id: usage.core.id,
      event_created_at_ms: Date.parse(usage.core.created_at),
    })),
    ...queueMetrics(batch),
  }));
  let outcome:
    | LlmUsageWriteOutcome
    | EnkryptUsageWriteOutcome
    | ExaUsageWriteOutcome
    | { kind: 'unavailable'; reason: 'invalid_event' | 'unsupported_kind' | 'invocation_budget' };
  let writerDurationMs: number | undefined;
  if (parsed.kind === 'invalid') {
    outcome = { kind: 'unavailable', reason: parsed.reason };
  } else if (performance.now() > lastLaunchAtMs) {
    // Leave room for the full existing HTTP timeout; never abandon an in-flight write.
    outcome = { kind: 'unavailable', reason: 'invocation_budget' };
  } else {
    const writerStartedAt = performance.now();
    outcome = await recordQueuedUsage(parsed, env);
    if (outcome.kind !== 'unavailable' || outcome.reason !== 'missing_config') {
      writerDurationMs = Math.round(performance.now() - writerStartedAt);
    }
  }

  const writerStatus =
    outcome.kind === 'unavailable' && outcome.reason === 'http_error' ? outcome.status : undefined;
  const overloaded = writerStatus === 429 || writerStatus === 503;
  const acknowledged = outcome.kind === 'recorded' || outcome.kind === 'duplicate';
  const admissionReason =
    outcome.kind === 'unavailable' && outcome.reason === 'http_error' && outcome.status === 429
      ? outcome.admissionReason
      : undefined;
  const retryDelaySeconds = acknowledged
    ? undefined
    : usageRetryDelaySeconds(message.attempts, admissionReason !== undefined);
  const level = acknowledged ? 'info' : 'warn';
  logSafely(level, () => ({
    event: 'usage_ingest_processing',
    queue: batch.queue,
    batch_id: batchId,
    ...diagnostics,
    outcome: outcome.kind,
    ...('reason' in outcome ? { reason: outcome.reason } : {}),
    queue_action: acknowledged ? 'ack' : 'retry',
    ...(retryDelaySeconds === undefined
      ? {}
      : {
          retry_class: admissionReason === undefined ? 'conservative' : 'admission',
          retry_delay_seconds: retryDelaySeconds,
          ...(admissionReason === undefined ? {} : { admission_reason: admissionReason }),
        }),
    ...(overloaded ? { writer_status: writerStatus, invocation_failure: 'writer_overloaded' } : {}),
    queue_message_id: message.id,
    delivery_attempts: message.attempts,
    queue_wait_ms: queueWaitMs,
    ...(Math.max(handlerEntryQueueAgeMs, queueWaitMs, slotWaitMs, writerDurationMs ?? 0) >= 1000 ||
    sampleDelivery(message.id, message.attempts)
      ? { handler_entry_queue_age_ms: handlerEntryQueueAgeMs, slot_wait_ms: slotWaitMs }
      : {}),
    ...usageIdentity(parsed, usage => ({
      usage_id: usage.core.id,
      event_age_ms: Math.max(0, Date.now() - Date.parse(usage.core.created_at)),
    })),
    ...(writerDurationMs === undefined ? {} : { writer_duration_ms: writerDurationMs }),
  }));
  return { acknowledged, overloaded, retryDelaySeconds };
}
