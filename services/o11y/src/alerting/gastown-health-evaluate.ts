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
import { sendAlertNotification, type AlertPayload, type GastownHealthAlertPayload } from './notify';

// A town failing continuously for this long with no recovery and no successful
// ping is a confirmed wedge that needs a human — roughly 2.5x the watchdog's
// ~4-minute recovery budget (60s cold-start grace + 3x >=60s restart throttle).
// Also catches a dead alarm loop that stops emitting watchdog events entirely.
export const SUSTAINED_FAILURE_MINUTES = 10;

// A "code was updated" watchdog error spanning at least this many towns in the
// window looks like deploy churn (a rollout resetting Town DOs) rather than an
// incident, so those towns' failures are treated as deploy-caused, not paged.
export const DEPLOY_CHURN_WATCHDOG_ERROR_TOWNS = 3;

export { GASTOWN_HEALTH_WINDOW_MINUTES };

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

export type GastownHealthClassification = {
  // Watchdog gave up restarting — a confirmed wedge. Pages even during deploy
  // churn (a genuine wedge), but the ticket carries the churn annotation.
  exhaustedTownIds: string[];
  // Continuous failure >= SUSTAINED_FAILURE_MINUTES with no recovery/success.
  sustainedTownIds: string[];
  // Towns whose window carries the "code was updated" deploy-churn fingerprint.
  deployChurnTownIds: string[];
  deployChurnSuspected: boolean;
  // Union of exhausted + sustained — the towns that justify paging a human.
  wedgeTownIds: string[];
  // Info-trend aggregate (never pages on its own).
  affectedTownCount: number;
  aggregateWeightedFailedChecks: number;
  aggregateWeightedSuccessfulChecks: number;
  totalWeightedRecovered: number;
};

export function classifyGastownHealth(metrics: GastownHealthMetrics): GastownHealthClassification {
  const sustainedFailureMs = SUSTAINED_FAILURE_MINUTES * 60_000;

  const deployChurnTownIds = metrics.townSignals
    .filter(town => town.weightedWatchdogCodeUpdated > 0)
    .map(town => town.townId);
  const deployChurnSuspected = deployChurnTownIds.length >= DEPLOY_CHURN_WATCHDOG_ERROR_TOWNS;
  const churnTowns = new Set(deployChurnTownIds);

  const exhaustedTownIds = metrics.townSignals
    .filter(town => town.weightedExhausted > 0)
    .map(town => town.townId);

  const sustainedTownIds = metrics.townSignals
    .filter(town => {
      if (town.weightedFailedChecks <= 0) return false;
      if (town.weightedSuccessfulChecks > 0) return false;
      if (town.weightedRecovered > 0) return false;
      if (town.firstEventAt === null || town.lastEventAt === null) return false;
      const spanMs = town.lastEventAt.getTime() - town.firstEventAt.getTime();
      if (spanMs < sustainedFailureMs) return false;
      // During broad deploy churn, treat a churn town's failures as deploy-caused.
      if (deployChurnSuspected && churnTowns.has(town.townId)) return false;
      return true;
    })
    .map(town => town.townId);

  const wedgeTownIds = [...new Set([...exhaustedTownIds, ...sustainedTownIds])].sort();

  return {
    exhaustedTownIds: [...exhaustedTownIds].sort(),
    sustainedTownIds: [...sustainedTownIds].sort(),
    deployChurnTownIds: [...deployChurnTownIds].sort(),
    deployChurnSuspected,
    wedgeTownIds,
    affectedTownCount: metrics.townSignals.filter(town => town.weightedFailedChecks > 0).length,
    aggregateWeightedFailedChecks: metrics.aggregateWeightedFailedChecks,
    aggregateWeightedSuccessfulChecks: metrics.aggregateWeightedSuccessfulChecks,
    totalWeightedRecovered: metrics.townSignals.reduce(
      (sum, town) => sum + town.weightedRecovered,
      0
    ),
  };
}

// Non-paging visibility: the aggregate flapping signal is emitted every tick so
// it stays on the Grafana panel / Logpush trend without paging on self-healed
// flapping. o11y has logpush enabled, so a structured console.info is captured.
function emitGastownHealthTrend(classification: GastownHealthClassification): void {
  console.info(
    JSON.stringify({
      event: 'gastown_container_health_trend',
      windowMinutes: GASTOWN_HEALTH_WINDOW_MINUTES,
      affectedTownCount: classification.affectedTownCount,
      weightedFailedChecks: classification.aggregateWeightedFailedChecks,
      weightedSuccessfulChecks: classification.aggregateWeightedSuccessfulChecks,
      weightedRecovered: classification.totalWeightedRecovered,
      exhaustedTownCount: classification.exhaustedTownIds.length,
      sustainedTownCount: classification.sustainedTownIds.length,
      deployChurnSuspected: classification.deployChurnSuspected,
      deployChurnTownCount: classification.deployChurnTownIds.length,
    })
  );
}

function buildGastownHealthAlertPayload(
  classification: GastownHealthClassification
): GastownHealthAlertPayload {
  return {
    alertType: 'gastown_container_health',
    severity: 'ticket',
    windowMinutes: GASTOWN_HEALTH_WINDOW_MINUTES,
    sustainedFailureMinutes: SUSTAINED_FAILURE_MINUTES,
    exhaustedTownIds: classification.exhaustedTownIds,
    sustainedTownIds: classification.sustainedTownIds,
    deployChurnSuspected: classification.deployChurnSuspected,
    deployChurnTownCount: classification.deployChurnTownIds.length,
    affectedTownCount: classification.affectedTownCount,
    weightedFailedChecks: classification.aggregateWeightedFailedChecks,
  };
}

export async function evaluateGastownHealthAlert(
  env: GastownHealthEnv,
  queryFn: QueryFn = queryGastownHealth,
  notifyFn: NotifyFn = sendAlertNotification
): Promise<void> {
  const metrics = await queryFn(env);
  const classification = classifyGastownHealth(metrics);

  emitGastownHealthTrend(classification);

  const currentState = await readGastownHealthState(env.O11Y_ALERT_STATE);
  const transition = transitionGastownHealthState(currentState, {
    wedgeTownIds: classification.wedgeTownIds,
    // Only a fleet with successful health pings is proof of life; a blackout
    // (zero pings) must not be mistaken for recovery.
    healthObserved: classification.aggregateWeightedSuccessfulChecks > 0,
  });

  if (transition.shouldNotify) {
    await notifyFn(buildGastownHealthAlertPayload(classification), env);
  }

  if (transition.stateChanged) {
    await writeGastownHealthState(env.O11Y_ALERT_STATE, transition.state);
  }
}
