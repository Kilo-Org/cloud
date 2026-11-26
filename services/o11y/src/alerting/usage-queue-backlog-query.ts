import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { queryQueueBacklog } from './queue-backlog-query';
import { resolveQueueId } from './queue-lookup';

export const USAGE_QUEUE_NAME = 'usage-ingest-processing-eu';
export const USAGE_QUEUE_RUNBOOK =
  'https://github.com/Kilo-Org/cloud/blob/main/services/usage-ingest/README.md#main-queue-backlog-alert';

export async function queryUsageQueueBacklog(
  env: Parameters<typeof queryQueueBacklog>[0],
  ctx?: SecretsExecutionContext
) {
  const queueId = await resolveQueueId(env, fetch, USAGE_QUEUE_NAME, ctx);
  return {
    ...(await queryQueueBacklog(env, fetch, queueId, ctx)),
    queueName: USAGE_QUEUE_NAME,
    runbookUrl: USAGE_QUEUE_RUNBOOK,
  };
}
