/**
 * Container capacity alert evaluator — invoked once per cron tick.
 *
 * Fetches container application data, evaluates utilization thresholds,
 * and fires Slack notifications with KV-based dedup (same cooldown
 * scheme as SLO alerts).
 */

import { evaluateCapacityThresholds, type ContainerApplication } from './container-capacity';
import { queryContainerApplications } from './container-capacity-query';
import { shouldSuppress, recordAlertFired } from './dedup';
import { sendAlertNotification, type AlertPayload } from './notify';

type ContainerCapacityEnv = {
  O11Y_ALERT_STATE: KVNamespace;
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_CONTAINERS_API_TOKEN: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_PAGE: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_TICKET: SecretsStoreSecret;
};

type QueryFn = (
  env: Pick<ContainerCapacityEnv, 'O11Y_CF_ACCOUNT_ID' | 'O11Y_CF_CONTAINERS_API_TOKEN'>
) => Promise<ContainerApplication[]>;

type NotifyFn = (alert: AlertPayload, env: ContainerCapacityEnv) => Promise<void>;

/**
 * Evaluates container capacity alerts for the current cron tick.
 *
 * @param env - Worker environment bindings
 * @param queryFn - Injectable query function (defaults to real API client); used for testing
 * @param notifyFn - Injectable notification function (defaults to real Slack sender); used for testing
 */
export async function evaluateContainerCapacity(
  env: ContainerCapacityEnv,
  queryFn: QueryFn = queryContainerApplications,
  notifyFn: NotifyFn = sendAlertNotification
): Promise<void> {
  const apps = await queryFn(env);

  const alerts = evaluateCapacityThresholds(apps);

  // Sort: page alerts first so a page marker for one app can suppress
  // a ticket alert for another app within the same cron tick.
  const sorted = [...alerts].sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'page' ? -1 : 1;
  });

  for (const alert of sorted) {
    const suppressed = await shouldSuppress(
      env.O11Y_ALERT_STATE,
      alert.severity,
      'container_capacity',
      'cloudflare',
      alert.applicationName,
      'containers'
    );
    if (suppressed) continue;

    await notifyFn(
      {
        alertType: 'container_capacity',
        severity: alert.severity,
        provider: 'cloudflare',
        model: alert.applicationName,
        clientName: 'containers',
        usedInstances: alert.usedInstances,
        maxInstances: alert.maxInstances,
        utilizationFraction: alert.utilizationFraction,
        thresholdFraction: alert.thresholdFraction,
        health: alert.health,
      },
      env
    );

    await recordAlertFired(
      env.O11Y_ALERT_STATE,
      alert.severity,
      'container_capacity',
      'cloudflare',
      alert.applicationName,
      'containers'
    );
  }
}
