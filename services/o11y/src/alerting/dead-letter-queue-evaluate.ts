import { DEAD_LETTER_QUEUE_NAME, DEAD_LETTER_QUEUE_SEVERITY } from './dead-letter-queue';
import { queryDeadLetterQueue } from './dead-letter-queue-query';
import { recordAlertFired, shouldSuppress } from './dedup';
import { sendAlertNotification, type AlertPayload } from './notify';
import type { QueueBacklogMetrics } from './queue-backlog';
import type { O11ySecretsEnv } from '../secrets';

type DeadLetterQueueEnv = O11ySecretsEnv & {
  O11Y_ALERT_STATE: KVNamespace;
  O11Y_CF_ACCOUNT_ID: string;
};

type QueryFn = (
  env: Pick<DeadLetterQueueEnv, 'O11Y_CF_ACCOUNT_ID' | 'STS'>,
  queueName: string
) => Promise<QueueBacklogMetrics>;

type NotifyFn = (alert: AlertPayload, env: DeadLetterQueueEnv) => Promise<void>;

function markKey(queueName: string): string {
  return `o11y:dead_letter_queue:${queueName}`;
}

function dimension(queueName: string) {
  return [
    DEAD_LETTER_QUEUE_SEVERITY,
    'dead_letter_queue',
    'cloudflare',
    queueName,
    'queues',
  ] as const;
}

async function readMark(kv: KVNamespace, queueName: string): Promise<number> {
  const mark = Number(await kv.get(markKey(queueName)));
  return Number.isSafeInteger(mark) && mark >= 0 ? mark : 0;
}

function queryNamedDeadLetterQueue(
  env: Parameters<QueryFn>[0],
  queueName: string
): Promise<QueueBacklogMetrics> {
  return queryDeadLetterQueue(env, fetch, queueName);
}

/**
 * The DLQ has no consumer, so its backlog only grows when messages dead-letter. The stored mark is
 * the lowest backlog seen since the last alert; a backlog above it means new arrivals, which alert
 * at most once per cooldown of DEAD_LETTER_QUEUE_SEVERITY. Each DLQ keeps its own mark and cooldown.
 */
export async function evaluateDeadLetterQueueAlert(
  env: DeadLetterQueueEnv,
  queueName: string = DEAD_LETTER_QUEUE_NAME,
  queryFn: QueryFn = queryNamedDeadLetterQueue,
  notifyFn: NotifyFn = sendAlertNotification
): Promise<void> {
  const metrics = await queryFn(env, queueName);
  const mark = await readMark(env.O11Y_ALERT_STATE, queueName);
  let nextMark = Math.min(mark, metrics.backlogCount);

  if (
    metrics.backlogCount > mark &&
    !(await shouldSuppress(env.O11Y_ALERT_STATE, ...dimension(queueName)))
  ) {
    await notifyFn(
      {
        alertType: 'dead_letter_queue',
        severity: DEAD_LETTER_QUEUE_SEVERITY,
        provider: 'cloudflare',
        model: queueName,
        clientName: 'queues',
        queueId: metrics.queueId,
        backlogCount: metrics.backlogCount,
        newMessages: metrics.backlogCount - mark,
        backlogBytes: metrics.backlogBytes,
        oldestMessageTimestamp: metrics.oldestMessageTimestamp,
      },
      env
    );
    await recordAlertFired(env.O11Y_ALERT_STATE, ...dimension(queueName));
    nextMark = metrics.backlogCount;
  }

  if (nextMark !== mark) await env.O11Y_ALERT_STATE.put(markKey(queueName), String(nextMark));
}
