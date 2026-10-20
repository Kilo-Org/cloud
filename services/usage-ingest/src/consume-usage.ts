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
  for (const message of batch.messages) {
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
      outcome = await recordUsage(parsed.data, {
        url: env.USAGE_WRITER_URL,
        secret: env.USAGE_WRITER_SECRET,
        protectionBypass: env.USAGE_WRITER_PROTECTION_BYPASS,
        source: 'queue',
      });
      if (outcome.kind !== 'unavailable' || outcome.reason !== 'missing_config') {
        writerDurationMs = Math.round(performance.now() - writerStartedAt);
      }
    }

    const acknowledged = outcome.kind === 'recorded' || outcome.kind === 'duplicate';
    const level = acknowledged ? 'info' : 'warn';
    console[level](
      JSON.stringify({
        level,
        event: 'usage_ingest_processing',
        outcome: outcome.kind,
        ...('reason' in outcome ? { reason: outcome.reason } : {}),
        queue_action: acknowledged ? 'ack' : 'retry',
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
    if (acknowledged) message.ack();
    else message.retry();
  }
}
