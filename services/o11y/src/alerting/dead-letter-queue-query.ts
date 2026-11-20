import { DEAD_LETTER_QUEUE_NAME } from './dead-letter-queue';
import type { QueueBacklogMetrics } from './queue-backlog';
import { queryQueueBacklog } from './queue-backlog-query';
import { resolveQueueId } from './queue-lookup';

type QueryEnv = Parameters<typeof queryQueueBacklog>[0];
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Resolves the DLQ by name on every run, so a recreated queue needs no config change. */
export async function queryDeadLetterQueue(
  env: QueryEnv,
  fetchFn: FetchFn = fetch
): Promise<QueueBacklogMetrics> {
  return queryQueueBacklog(
    env,
    fetchFn,
    await resolveQueueId(env, fetchFn, DEAD_LETTER_QUEUE_NAME)
  );
}
