import { type QueueBacklogMetrics, QUEUE_BACKLOG_THRESHOLDS } from './queue-backlog';
import { evaluateAndUpdateQueueBacklogState } from './queue-backlog-state';
import { queryQueueBacklog } from './queue-backlog-query';
import { sendAlertNotification, type AlertPayload } from './notify';

type QueueBacklogEnv = {
  O11Y_ALERT_STATE: KVNamespace;
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_CONTAINERS_API_TOKEN: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_PAGE: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_TICKET: SecretsStoreSecret;
};

type QueryFn = (
  env: Pick<QueueBacklogEnv, 'O11Y_CF_ACCOUNT_ID' | 'O11Y_CF_CONTAINERS_API_TOKEN'>
) => Promise<QueueBacklogMetrics>;

type NotifyFn = (alert: AlertPayload, env: QueueBacklogEnv) => Promise<void>;

export async function evaluateQueueBacklogAlert(
  env: QueueBacklogEnv,
  queryFn: QueryFn = queryQueueBacklog,
  notifyFn: NotifyFn = sendAlertNotification
): Promise<void> {
  const metrics = await queryFn(env);

  const severity = await evaluateAndUpdateQueueBacklogState(
    env.O11Y_ALERT_STATE,
    metrics.backlogCount
  );

  if (severity === null) return;

  const thresholdCount =
    severity === 'page' ? QUEUE_BACKLOG_THRESHOLDS.page : QUEUE_BACKLOG_THRESHOLDS.ticket;

  await notifyFn(
    {
      alertType: 'queue_backlog',
      severity,
      provider: 'cloudflare',
      model: metrics.queueId,
      clientName: 'queues',
      backlogCount: metrics.backlogCount,
      backlogBytes: metrics.backlogBytes,
      thresholdCount,
      oldestMessageTimestamp: metrics.oldestMessageTimestamp,
    },
    env
  );
}
