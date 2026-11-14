import { parseQueuedUsage } from './queued-usage';

/** `max_retries` of the consumer in every wrangler.jsonc environment. */
const QUEUE_MAX_RETRIES = 20;

function usageIdentity(body: unknown) {
  const parsed = parseQueuedUsage(body);
  if (parsed.kind === 'llm') return { usage_kind: 'llm', usage_id: parsed.usage.core.id };
  if (parsed.kind === 'enkrypt_usage')
    return { usage_kind: 'enkrypt_usage', usage_id: parsed.record.id };
  return { usage_kind: parsed.usageKind };
}

/**
 * Cloudflare moves a message to the dead-letter queue when its delivery after the last allowed
 * retry fails, so this is the consumer's last record of it and the place its usage ID is known.
 * It is not proof the DLQ stored it; the o11y DLQ backlog alert is authoritative.
 */
export function logFinalAttemptFailure(
  message: Message<unknown>,
  queue: string,
  reason: string
): void {
  if (!(message.attempts > QUEUE_MAX_RETRIES)) return;
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'usage_ingest_final_attempt_failed',
      queue,
      ...usageIdentity(message.body),
      queue_message_id: message.id,
      delivery_attempts: message.attempts,
      reason,
    })
  );
}
