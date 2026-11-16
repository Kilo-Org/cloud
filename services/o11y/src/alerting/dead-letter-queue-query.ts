import { z } from 'zod';
import { DEAD_LETTER_QUEUE_NAME } from './dead-letter-queue';
import type { QueueBacklogMetrics } from './queue-backlog';
import { queryQueueBacklog } from './queue-backlog-query';

type QueryEnv = {
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_CONTAINERS_API_TOKEN: SecretsStoreSecret;
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_LOOKUP_PAGES = 20;

const QueueListResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    result: z.array(z.object({ queue_name: z.string(), queue_id: z.string() })),
    result_info: z.object({ total_pages: z.number() }),
  }),
  z.object({
    success: z.literal(false),
    errors: z.array(z.object({ message: z.string() })).optional(),
  }),
]);

async function resolveQueueId(env: QueryEnv, fetchFn: FetchFn): Promise<string> {
  const token = await env.O11Y_CF_CONTAINERS_API_TOKEN.get();
  if (!token) throw new Error('O11Y_CF_CONTAINERS_API_TOKEN secret is not configured');

  const ids: string[] = [];
  for (let page = 1; page <= MAX_LOOKUP_PAGES; page++) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.O11Y_CF_ACCOUNT_ID}/queues?name=${encodeURIComponent(DEAD_LETTER_QUEUE_NAME)}&page=${page}`;
    const response = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Queue lookup request failed (${response.status})`);
    const parsed = QueueListResponseSchema.parse(await response.json());
    if (!parsed.success) {
      const details = parsed.errors?.map(error => error.message).join('; ') || 'unknown error';
      throw new Error(`Queue lookup request failed: ${details}`);
    }
    ids.push(
      ...parsed.result
        .filter(queue => queue.queue_name === DEAD_LETTER_QUEUE_NAME)
        .map(queue => queue.queue_id)
    );
    const totalPages = parsed.result_info.total_pages;
    if (!Number.isInteger(totalPages) || totalPages > MAX_LOOKUP_PAGES)
      throw new Error('Queue lookup returned incomplete pagination');
    if (page >= totalPages) break;
  }

  if (ids.length !== 1)
    throw new Error(`Expected one queue named ${DEAD_LETTER_QUEUE_NAME}, found ${ids.length}`);
  if (!/^[a-f0-9]{32}$/.test(ids[0]))
    throw new Error(`Queue ${DEAD_LETTER_QUEUE_NAME} has an unexpected id`);
  return ids[0];
}

/** Resolves the DLQ by name on every run, so a recreated queue needs no config change. */
export async function queryDeadLetterQueue(
  env: QueryEnv,
  fetchFn: FetchFn = fetch
): Promise<QueueBacklogMetrics> {
  return queryQueueBacklog(env, fetchFn, await resolveQueueId(env, fetchFn));
}
