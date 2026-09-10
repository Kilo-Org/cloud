import {
  CLOUD_AGENT_FAILURE_REASONS,
  type CloudAgentFailureReason,
} from '@kilocode/worker-utils/cloud-agent-failure';

type OperationalHealthSummary = {
  completedRuns: number;
  failedRuns: number;
  setupFailures: number;
  interruptedRuns: number;
  sessionsObserved: number;
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
  source_control_clone_timeout: 'Repository clone timed out',
  source_control_checkout_timeout: 'Repository checkout timed out',
  source_control_repository_corrupt: 'Repository data is corrupt',
  sandbox_capacity: 'Sandbox capacity',
  sandbox_connectivity: 'Sandbox connectivity',
  runtime_startup: 'Runtime startup',
  wrapper_liveness: 'Wrapper liveness',
  delivery: 'Delivery',
  managed_provider_unavailable: 'Managed provider unavailable',
  managed_provider_authentication: 'Managed provider authentication',
  managed_model_configuration: 'Managed model configuration',
  provider_unavailable: 'Provider unavailable',
  request_timeout: 'Request timed out',
  assistant_invalid_request: 'Assistant invalid request',
  assistant_context_limit: 'Assistant context limit',
  assistant_output_limit: 'Assistant output limit',
  assistant_content_filter: 'Assistant content filter',
  assistant_structured_output: 'Assistant structured output',
  provider_ownership_unknown: 'Unknown provider ownership',
  invalid_request: 'Model request rejected',
  context_limit: 'Context limit',
  output_limit: 'Output limit',
  content_filter: 'Content filter',
  structured_output: 'Invalid structured output',
  source_control_network: 'Source control network',
  wrapper_disconnected: 'Wrapper disconnected',
  wrapper_startup: 'Wrapper startup failure',
  wrapper_crash: 'Wrapper crash after activity',
  assistant_no_reply: 'Assistant no reply',
  user_interrupt: 'User interrupt',
  container_shutdown: 'Container shutdown',
  system_interrupt: 'System interrupt',
  assistant_unknown: 'Unknown assistant failure',
  workspace_unknown: 'Unknown workspace failure',
  session_import_timeout: 'Session import timed out',
  session_import_failed: 'Session import failed',
  setup_command_timeout: 'Setup command timed out',
  admission_capacity: 'Admission queue full',
  admission_not_found: 'Session not found at admission',
  admission_internal: 'Internal admission error',
  admission_compute_stopping: 'Compute stopping at admission',
  admission_billing_unavailable: 'Billing unavailable at admission',
  admission_forbidden: 'Admission forbidden',
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
  const runOutcomes = summary.failedRuns + summary.completedRuns;
  return {
    runOutcomes,
    runFailureRatePercent: runOutcomes === 0 ? null : (summary.failedRuns / runOutcomes) * 100,
    sessionsObserved: summary.sessionsObserved,
    setupFailureRatePercent:
      summary.sessionsObserved === 0
        ? null
        : (summary.setupFailures / summary.sessionsObserved) * 100,
  };
}
