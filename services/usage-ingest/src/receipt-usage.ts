import { UsageRecordRequestSchema } from '@kilocode/usage-contracts';

export function handleQueue(batch: MessageBatch<unknown>): void {
  for (const message of batch.messages) {
    const result = UsageRecordRequestSchema.safeParse(message.body);
    console.log(
      JSON.stringify({
        event: 'usage_ingest_receipt',
        outcome: result.success ? 'received' : 'invalid',
        queue_message_id: message.id,
        delivery_attempts: message.attempts,
        ...(result.success
          ? {
              usage_id: result.data.core.id,
              event_age_ms: Math.max(0, Date.now() - Date.parse(result.data.core.created_at)),
            }
          : {}),
      })
    );
    // Shadow receipts are discarded, including malformed bodies; logging must succeed first.
    message.ack();
  }
}
