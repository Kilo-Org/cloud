import type { AlertSeverity } from './slo-config';

/**
 * Production usage-ingest DLQ. It has no consumer, so any backlog is unrecorded usage waiting for
 * replay. Must match `dead_letter_queue` in services/usage-ingest/wrangler.jsonc.
 */
export const DEAD_LETTER_QUEUE_NAME = 'usage-ingest-processing-dlq-eu';

/** Production DLQ of the dedicated Enkrypt and Exa fallback queue, watched the same way. */
export const ENKRYPT_DEAD_LETTER_QUEUE_NAME = 'usage-ingest-enkrypt-dlq-eu';

export const DEAD_LETTER_QUEUE_SEVERITY: AlertSeverity = 'ticket';
