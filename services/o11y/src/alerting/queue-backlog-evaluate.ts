import { evaluateQueueBacklog, type QueueBacklogMetrics } from './queue-backlog';
import { queryQueueBacklog } from './queue-backlog-query';
import { shouldSuppress, recordAlertFired } from './dedup';
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
  const alert = evaluateQueueBacklog(await queryFn(env));
  if (alert === null) return;

  const provider = 'cloudflare';
  const clientName = 'queues';
  const suppressed = await shouldSuppress(
    env.O11Y_ALERT_STATE,
    alert.severity,
    'queue_backlog',
    provider,
    alert.queueId,
    clientName
  );
  if (suppressed) return;

  await notifyFn(
    {
      alertType: 'queue_backlog',
      severity: alert.severity,
      provider,
      model: alert.queueId,
      clientName,
      backlogCount: alert.backlogCount,
      backlogBytes: alert.backlogBytes,
      thresholdCount: alert.thresholdCount,
      oldestMessageTimestamp: alert.oldestMessageTimestamp,
    },
    env
  );

  await recordAlertFired(
    env.O11Y_ALERT_STATE,
    alert.severity,
    'queue_backlog',
    provider,
    alert.queueId,
    clientName
  );
}
