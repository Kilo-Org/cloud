import {
  CLOUD_AGENT_FAILURE_REASONS,
  type CloudAgentFailureReason,
} from '@kilocode/worker-utils/cloud-agent-failure';

type OperationalHealthSummary = {
  completedRuns: number;
  failedRuns: number;
  setupFailures: number;
  interruptedRuns: number;
};

type ObservedHealthSummary = OperationalHealthSummary & {
  platformFailures: number;
  userFailures: number;
  unknownFailures: number;
};

export const DEFAULT_FAILURE_RESPONSIBILITY_FILTER = 'platform' as const;

const FAILURE_REASON_LABELS = {
  insufficient_credits: 'Insufficient credits',
  rate_limited: 'Rate limited',
  model_unavailable: 'Model unavailable',
  provider_authentication: 'Provider authentication',
  setup_command: 'Setup command',
  source_control_authentication: 'Source control authentication',
  source_control_configuration: 'Source control configuration',
  sandbox_capacity: 'Sandbox capacity',
  sandbox_connectivity: 'Sandbox connectivity',
  runtime_startup: 'Runtime startup',
  wrapper_liveness: 'Wrapper liveness',
  delivery: 'Delivery',
  managed_provider_unavailable: 'Managed provider unavailable',
  managed_provider_authentication: 'Managed provider authentication',
  managed_model_configuration: 'Managed model configuration',
  provider_unavailable: 'Provider unavailable',
  source_control_network: 'Source control network',
  assistant_unknown: 'Unknown assistant failure',
  workspace_unknown: 'Unknown workspace failure',
  session_coordination: 'Session coordination',
  initial_request_invalid: 'Invalid initial request',
  initial_admission_unknown: 'Unknown initial admission failure',
  unclassified: 'Unclassified',
} satisfies Record<CloudAgentFailureReason, string>;

export function failureReasonLabel(reason: CloudAgentFailureReason): string {
  return FAILURE_REASON_LABELS[reason];
}

export function hasExhaustiveFailureReasonLabels(): boolean {
  return CLOUD_AGENT_FAILURE_REASONS.every(reason => Boolean(FAILURE_REASON_LABELS[reason]));
}

export type ObservedHealthOutcomeKind =
  | 'completed'
  | 'interrupted'
  | 'user'
  | 'platform'
  | 'unknown';

export function getObservedHealthStats(summary: ObservedHealthSummary) {
  const observedRuns = summary.completedRuns + summary.failedRuns + summary.interruptedRuns;
  const outcomes = [
    { kind: 'completed', count: summary.completedRuns },
    { kind: 'interrupted', count: summary.interruptedRuns },
    { kind: 'user', count: summary.userFailures },
    { kind: 'platform', count: summary.platformFailures },
    { kind: 'unknown', count: summary.unknownFailures },
  ] satisfies Array<{ kind: ObservedHealthOutcomeKind; count: number }>;
  const observedOutcomes = outcomes.reduce((total, outcome) => total + outcome.count, 0);
  return {
    observedOutcomes,
    observedRuns,
    setupFailures: summary.setupFailures,
    outcomes: outcomes.map(outcome => ({
      ...outcome,
      sharePercent: observedOutcomes === 0 ? null : (outcome.count / observedOutcomes) * 100,
    })),
  };
}

export function getOperationalFailureStats(summary: OperationalHealthSummary) {
  const failureEvents = summary.failedRuns + summary.setupFailures;
  const assessedOutcomes = summary.completedRuns + failureEvents;
  return {
    failureEvents,
    assessedOutcomes,
    failureRatePercent: assessedOutcomes === 0 ? null : (failureEvents / assessedOutcomes) * 100,
  };
}
