import {
  DISPATCH_HEALTH_COHORT_WINDOW_MINUTES,
  DISPATCH_HEALTH_GRACE_MINUTES,
  DISPATCH_HEALTH_MINIMUM_AFFECTED_SESSIONS,
  DISPATCH_HEALTH_STUCK_RATE_THRESHOLD,
  type DispatchHealthAlertDetails,
} from './detector';

export const CLOUD_AGENT_DISPATCH_RUNBOOK_URL =
  'https://github.com/Kilo-Org/on-call/blob/main/runbooks/cloud-agent-dispatch-health.md';

export type DispatchHealthAlert = DispatchHealthAlertDetails & {
  kind: 'stuck_dispatch_rate';
  label: 'Stuck Dispatch Rate';
  severity: 'ticket';
  runbookUrl: string;
};

export type DispatchHealthResponse = {
  healthy: boolean;
  alerts: DispatchHealthAlert[];
  metadata: {
    timestamp: string;
    runbookUrl: string;
    evaluationStatus: 'completed' | 'failed_open';
    detector: {
      cohortWindowMinutes: number;
      dispatchGraceMinutes: number;
      stuckRateThreshold: number;
      minimumAffectedSessions: number;
    };
  };
};

function metadata(
  evaluationStatus: DispatchHealthResponse['metadata']['evaluationStatus'],
  timestamp: Date
): DispatchHealthResponse['metadata'] {
  return {
    timestamp: timestamp.toISOString(),
    runbookUrl: CLOUD_AGENT_DISPATCH_RUNBOOK_URL,
    evaluationStatus,
    detector: {
      cohortWindowMinutes: DISPATCH_HEALTH_COHORT_WINDOW_MINUTES,
      dispatchGraceMinutes: DISPATCH_HEALTH_GRACE_MINUTES,
      stuckRateThreshold: DISPATCH_HEALTH_STUCK_RATE_THRESHOLD,
      minimumAffectedSessions: DISPATCH_HEALTH_MINIMUM_AFFECTED_SESSIONS,
    },
  };
}

export function buildCompletedHealthyResponse(
  timestamp: Date = new Date()
): DispatchHealthResponse {
  return {
    healthy: true,
    alerts: [],
    metadata: metadata('completed', timestamp),
  };
}

export function buildCompletedUnhealthyResponse(
  details: DispatchHealthAlertDetails,
  timestamp: Date = new Date()
): DispatchHealthResponse {
  return {
    healthy: false,
    alerts: [
      {
        ...details,
        kind: 'stuck_dispatch_rate',
        label: 'Stuck Dispatch Rate',
        severity: 'ticket',
        runbookUrl: CLOUD_AGENT_DISPATCH_RUNBOOK_URL,
      },
    ],
    metadata: metadata('completed', timestamp),
  };
}

export function buildFailedOpenHealthyResponse(
  timestamp: Date = new Date()
): DispatchHealthResponse {
  return {
    healthy: true,
    alerts: [],
    metadata: metadata('failed_open', timestamp),
  };
}
