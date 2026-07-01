import {
  GASTOWN_HEALTH_WINDOW_MINUTES,
  queryGastownHealth,
  type GastownHealthMetrics,
} from './gastown-health-query';
import {
  readGastownHealthState,
  transitionGastownHealthState,
  writeGastownHealthState,
} from './gastown-health-state';
import { sendAlertNotification, type AlertPayload } from './notify';

export const GASTOWN_HEALTH_THRESHOLDS = {
  weightedFailedChecks: 30,
  affectedTowns: 4,
  renotifyFailedChecksStep: 30,
} as const;

type GastownHealthEnv = {
  O11Y_ALERT_STATE: KVNamespace;
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_AE_API_TOKEN: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_PAGE: SecretsStoreSecret;
  O11Y_SLACK_WEBHOOK_TICKET: SecretsStoreSecret;
};

type QueryFn = (
  env: Pick<GastownHealthEnv, 'O11Y_CF_ACCOUNT_ID' | 'O11Y_CF_AE_API_TOKEN'>
) => Promise<GastownHealthMetrics>;

type NotifyFn = (alert: AlertPayload, env: GastownHealthEnv) => Promise<void>;

function getCrossedThresholds(
  metrics: GastownHealthMetrics
): Array<'failed_checks' | 'affected_towns'> {
  const crossedThresholds: Array<'failed_checks' | 'affected_towns'> = [];
  if (metrics.weightedFailedChecks >= GASTOWN_HEALTH_THRESHOLDS.weightedFailedChecks) {
    crossedThresholds.push('failed_checks');
  }
  if (metrics.affectedTownCount >= GASTOWN_HEALTH_THRESHOLDS.affectedTowns) {
    crossedThresholds.push('affected_towns');
  }
  return crossedThresholds;
}

export async function evaluateGastownHealthAlert(
  env: GastownHealthEnv,
  queryFn: QueryFn = queryGastownHealth,
  notifyFn: NotifyFn = sendAlertNotification
): Promise<void> {
  const metrics = await queryFn(env);
  const crossedThresholds = getCrossedThresholds(metrics);
  const currentState = await readGastownHealthState(env.O11Y_ALERT_STATE);
  const transition = transitionGastownHealthState(
    currentState,
    metrics,
    crossedThresholds.length === 2,
    GASTOWN_HEALTH_THRESHOLDS.renotifyFailedChecksStep
  );

  if (transition.shouldNotify) {
    await notifyFn(
      {
        alertType: 'gastown_container_health',
        severity: 'ticket',
        weightedFailedChecks: metrics.weightedFailedChecks,
        affectedTownCount: metrics.affectedTownCount,
        windowMinutes: GASTOWN_HEALTH_WINDOW_MINUTES,
        crossedThresholds,
        failedChecksThreshold: GASTOWN_HEALTH_THRESHOLDS.weightedFailedChecks,
        affectedTownsThreshold: GASTOWN_HEALTH_THRESHOLDS.affectedTowns,
      },
      env
    );
  }

  if (transition.stateChanged) {
    await writeGastownHealthState(env.O11Y_ALERT_STATE, transition.state);
  }
}
