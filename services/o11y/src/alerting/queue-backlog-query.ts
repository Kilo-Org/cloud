import { z } from 'zod';
import { MONITORED_QUEUE_ID, type QueueBacklogMetrics } from './queue-backlog';

type QueryEnv = {
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_CONTAINERS_API_TOKEN: SecretsStoreSecret;
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const QueueMetricsResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    result: z.object({
      backlog_count: z.number().nonnegative(),
      backlog_bytes: z.number().nonnegative(),
      oldest_message_timestamp_ms: z.number().nonnegative(),
    }),
  }),
  z.object({
    success: z.literal(false),
    errors: z.array(z.object({ message: z.string() })).optional(),
  }),
]);

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export async function queryQueueBacklog(
  env: QueryEnv,
  fetchFn: FetchFn = fetch
): Promise<QueueBacklogMetrics> {
  const token = await env.O11Y_CF_CONTAINERS_API_TOKEN.get();
  if (!token) {
    throw new Error('O11Y_CF_CONTAINERS_API_TOKEN secret is not configured');
  }

  const response = await fetchFn(
    `${CF_API_BASE}/accounts/${env.O11Y_CF_ACCOUNT_ID}/queues/${MONITORED_QUEUE_ID}/metrics`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    }
  );

  if (!response.ok) {
    throw new Error(`Queue metrics request failed (${response.status})`);
  }

  const parsed = QueueMetricsResponseSchema.parse(await response.json());
  if (!parsed.success) {
    const details = parsed.errors?.map(error => error.message).join('; ') || 'unknown error';
    throw new Error(`Queue metrics request failed: ${details}`);
  }

  const oldestMessageTimestamp =
    parsed.result.oldest_message_timestamp_ms > 0
      ? new Date(parsed.result.oldest_message_timestamp_ms)
      : undefined;

  return {
    queueId: MONITORED_QUEUE_ID,
    backlogCount: parsed.result.backlog_count,
    backlogBytes: parsed.result.backlog_bytes,
    oldestMessageTimestamp,
  };
}
