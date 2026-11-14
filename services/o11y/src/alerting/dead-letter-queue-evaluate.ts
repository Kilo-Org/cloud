import { DEAD_LETTER_QUEUE_NAME, DEAD_LETTER_QUEUE_SEVERITY } from './dead-letter-queue';
import { queryDeadLetterQueue } from './dead-letter-queue-query';
import { recordAlertFired, shouldSuppress } from './dedup';
import { sendAlertNotification, type AlertPayload } from './notify';
import type { QueueBacklogMetrics } from './queue-backlog';

type DeadLetterQueueEnv = {
  O11Y_ALERT_STATE: KVNamespace;
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_CONTAINERS_API_TOKEN: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_PAGE: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_TICKET: SecretsStoreSecret;
};

type QueryFn = (
  env: Pick<DeadLetterQueueEnv, 'O11Y_CF_ACCOUNT_ID' | 'O11Y_CF_CONTAINERS_API_TOKEN'>
) => Promise<QueueBacklogMetrics>;

type NotifyFn = (alert: AlertPayload, env: DeadLetterQueueEnv) => Promise<void>;

const MARK_KEY = `o11y:dead_letter_queue:${DEAD_LETTER_QUEUE_NAME}`;
const DIMENSION = [
  DEAD_LETTER_QUEUE_SEVERITY,
  'dead_letter_queue',
  'cloudflare',
  DEAD_LETTER_QUEUE_NAME,
  'queues',
] as const;

async function readMark(kv: KVNamespace): Promise<number> {
  const mark = Number(await kv.get(MARK_KEY));
  return Number.isSafeInteger(mark) && mark >= 0 ? mark : 0;
}

/**
 * The DLQ has no consumer, so its backlog only grows when messages dead-letter. The stored mark is
 * the lowest backlog seen since the last alert; a backlog above it means new arrivals, which page
 * at most once per page cooldown.
 */
export async function evaluateDeadLetterQueueAlert(
  env: DeadLetterQueueEnv,
  queryFn: QueryFn = queryDeadLetterQueue,
  notifyFn: NotifyFn = sendAlertNotification
): Promise<void> {
  const metrics = await queryFn(env);
  const mark = await readMark(env.O11Y_ALERT_STATE);
  let nextMark = Math.min(mark, metrics.backlogCount);

  if (metrics.backlogCount > mark && !(await shouldSuppress(env.O11Y_ALERT_STATE, ...DIMENSION))) {
    await notifyFn(
      {
        alertType: 'dead_letter_queue',
        severity: DEAD_LETTER_QUEUE_SEVERITY,
        provider: 'cloudflare',
        model: DEAD_LETTER_QUEUE_NAME,
        clientName: 'queues',
        queueId: metrics.queueId,
        backlogCount: metrics.backlogCount,
        newMessages: metrics.backlogCount - mark,
        backlogBytes: metrics.backlogBytes,
        oldestMessageTimestamp: metrics.oldestMessageTimestamp,
      },
      env
    );
    await recordAlertFired(env.O11Y_ALERT_STATE, ...DIMENSION);
    nextMark = metrics.backlogCount;
  }

  if (nextMark !== mark) await env.O11Y_ALERT_STATE.put(MARK_KEY, String(nextMark));
}
