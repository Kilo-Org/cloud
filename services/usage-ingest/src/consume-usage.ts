import { UsageRecordRequestSchema } from '@kilocode/usage-contracts';
import { recordUsage } from '@kilocode/worker-utils/usage-writer-client';
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
    const parsed = UsageRecordRequestSchema.safeParse(message.body);
    const outcome =
      env.USAGE_INGEST_MODE !== 'processing'
        ? { kind: 'unavailable', reason: 'invalid_mode' }
        : !parsed.success
          ? { kind: 'unavailable', reason: 'invalid_event' }
          : await recordUsage(parsed.data, {
              url: env.USAGE_WRITER_URL,
              secret: env.USAGE_WRITER_SECRET,
              protectionBypass: env.USAGE_WRITER_PROTECTION_BYPASS,
            });

    console.log(
      JSON.stringify({
        event: 'usage_ingest_processing',
        outcome: outcome.kind,
        ...('reason' in outcome ? { reason: outcome.reason } : {}),
        queue_message_id: message.id,
        delivery_attempts: message.attempts,
        ...(parsed.success ? { usage_id: parsed.data.core.id } : {}),
      })
    );
    if (outcome.kind === 'recorded' || outcome.kind === 'duplicate') message.ack();
    else message.retry();
  }
}
