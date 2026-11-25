import { z } from 'zod';
import { readO11ySecret } from '../secrets';

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

export async function resolveQueueId(
  env: QueryEnv,
  fetchFn: FetchFn,
  queueName: string
): Promise<string> {
  const token = await readO11ySecret(env, 'O11Y_CF_CONTAINERS_API_TOKEN');

  const ids: string[] = [];
  for (let page = 1; page <= MAX_LOOKUP_PAGES; page++) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.O11Y_CF_ACCOUNT_ID}/queues?name=${encodeURIComponent(queueName)}&page=${page}`;
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
      ...parsed.result.filter(queue => queue.queue_name === queueName).map(queue => queue.queue_id)
    );
    const totalPages = parsed.result_info.total_pages;
    if (!Number.isInteger(totalPages) || totalPages > MAX_LOOKUP_PAGES)
      throw new Error('Queue lookup returned incomplete pagination');
    if (page >= totalPages) break;
  }

  if (ids.length !== 1)
    throw new Error(`Expected one queue named ${queueName}, found ${ids.length}`);
  if (!/^[a-f0-9]{32}$/.test(ids[0])) throw new Error(`Queue ${queueName} has an unexpected id`);
  return ids[0];
}
