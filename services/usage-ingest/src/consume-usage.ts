import { UsageRecordRequestSchema } from '@kilocode/usage-contracts';
import { recordUsage, type UsageWriteOutcome } from '@kilocode/worker-utils/usage-writer-client';
import type { Env } from './publish-usage';
import { handleQueue as handleReceiptQueue } from './receipt-usage';

export function handleQueue(batch: MessageBatch<unknown>, env: Env): void | Promise<void> {
  if (env.USAGE_INGEST_MODE === undefined || env.USAGE_INGEST_MODE === 'receipt') {
    return handleReceiptQueue(batch);
  }
  return processQueue(batch, env);
}

async function processQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const parallelism = env.USAGE_INGEST_PARALLELISM === '2' ? 2 : 1;
  let nextIndex = 0;
  let writerOverloaded = false;
  const unexpectedErrors: unknown[] = [];
  async function runSlot(): Promise<void> {
    while (nextIndex < batch.messages.length) {
      const message = batch.messages[nextIndex++];
      let acknowledged = false;
      try {
        const result = await processMessage(message, env);
        acknowledged = result.acknowledged;
        writerOverloaded ||= result.overloaded;
      } catch (error) {
        unexpectedErrors.push(error);
      }
      // Keep disposition calls outside the processing catch: never retry an ACKed message.
      try {
        if (acknowledged) message.ack();
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
  if (writerOverloaded) throw new Error('Usage writer overloaded (HTTP 429/503)');
  if (unexpectedErrors.length > 0) throw unexpectedErrors[0];
}

async function processMessage(message: Message<unknown>, env: Env) {
  const queueWaitMs = Math.max(0, Date.now() - message.timestamp.getTime());
  const parsed = UsageRecordRequestSchema.safeParse(message.body);
  let outcome:
    | UsageWriteOutcome
    | { kind: 'unavailable'; reason: 'invalid_mode' | 'invalid_event' };
  let writerDurationMs: number | undefined;
  if (env.USAGE_INGEST_MODE !== 'processing') {
    outcome = { kind: 'unavailable', reason: 'invalid_mode' };
  } else if (!parsed.success) {
    outcome = { kind: 'unavailable', reason: 'invalid_event' };
  } else {
    const writerStartedAt = performance.now();
    const relay = env.USAGE_WRITER_RELAY;
    outcome = await recordUsage(
      parsed.data,
      {
        url: env.USAGE_WRITER_URL,
        secret: env.USAGE_WRITER_SECRET,
        protectionBypass: env.USAGE_WRITER_PROTECTION_BYPASS,
        source: 'queue',
      },
      relay ? relay.fetch.bind(relay) : undefined
    );
    if (outcome.kind !== 'unavailable' || outcome.reason !== 'missing_config') {
      writerDurationMs = Math.round(performance.now() - writerStartedAt);
    }
  }

  const writerStatus =
    outcome.kind === 'unavailable' && outcome.reason === 'http_error' ? outcome.status : undefined;
  const overloaded = writerStatus === 429 || writerStatus === 503;
  const acknowledged = outcome.kind === 'recorded' || outcome.kind === 'duplicate';
  const level = acknowledged ? 'info' : 'warn';
  console[level](
    JSON.stringify({
      level,
      event: 'usage_ingest_processing',
      outcome: outcome.kind,
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      queue_action: acknowledged ? 'ack' : 'retry',
      ...(overloaded
        ? { writer_status: writerStatus, invocation_failure: 'writer_overloaded' }
        : {}),
      queue_message_id: message.id,
      delivery_attempts: message.attempts,
      queue_wait_ms: queueWaitMs,
      ...(parsed.success
        ? {
            usage_id: parsed.data.core.id,
            event_age_ms: Math.max(0, Date.now() - Date.parse(parsed.data.core.created_at)),
          }
        : {}),
      ...(writerDurationMs === undefined ? {} : { writer_duration_ms: writerDurationMs }),
    })
  );
  return { acknowledged, overloaded };
}
