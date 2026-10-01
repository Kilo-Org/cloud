import {
  classifyCloudAgentFailure,
  type CloudAgentAssistantFailureReason,
  type CloudAgentFailureCode,
  type CloudAgentFailureReason,
  type CloudAgentFailureResponsibility,
  type CloudAgentFailureStage,
  type CloudAgentProviderOwnership,
  type WorkspaceFailureSubtype,
} from '@kilocode/worker-utils/cloud-agent-failure';
import {
  assistantTerminalCode,
  resolveAssistantProviderOwnership,
} from '../shared/assistant-failure.js';

/**
 * The accepted-vs-pre-dispatch fact is captured at the committing transition.
 * A wrapper outcome `reason` is arbitrary text, so anything unrecognized falls
 * through to `unknown`/`unclassified` rather than being forced into
 * `pre_dispatch`.
 */
export type ControlPlaneDispatchState = 'pre_dispatch' | 'accepted';

export type ControlPlaneFailureClassification = {
  stage: CloudAgentFailureStage;
  code: CloudAgentFailureCode;
};

const PRE_DISPATCH: ControlPlaneFailureClassification = {
  stage: 'pre_dispatch',
  code: 'wrapper_start_failed',
};
const POST_DISPATCH_WRAPPER_DISCONNECTED: ControlPlaneFailureClassification = {
  stage: 'post_dispatch_no_activity',
  code: 'wrapper_disconnected',
};
const PRE_DISPATCH_SANDBOX_CONNECT: ControlPlaneFailureClassification = {
  stage: 'pre_dispatch',
  code: 'sandbox_connect_failed',
};
const PRE_DISPATCH_KILO_SERVER: ControlPlaneFailureClassification = {
  stage: 'pre_dispatch',
  code: 'kilo_server_failed',
};
const POST_DISPATCH_WRAPPER_NO_OUTPUT: ControlPlaneFailureClassification = {
  stage: 'post_dispatch_no_activity',
  code: 'wrapper_no_output',
};
const POST_DISPATCH_WRAPPER_ERROR_BEFORE_ACTIVITY: ControlPlaneFailureClassification = {
  stage: 'post_dispatch_no_activity',
  code: 'wrapper_error_before_activity',
};
const POST_DISPATCH_WRAPPER_PING_TIMEOUT: ControlPlaneFailureClassification = {
  stage: 'post_dispatch_no_activity',
  code: 'wrapper_ping_timeout',
};
const INTERRUPTION_USER: ControlPlaneFailureClassification = {
  stage: 'interruption',
  code: 'user_interrupt',
};
const INTERRUPTION_SYSTEM: ControlPlaneFailureClassification = {
  stage: 'interruption',
  code: 'system_interrupt',
};
const UNKNOWN: ControlPlaneFailureClassification = {
  stage: 'unknown',
  code: 'unclassified',
};

export function classifyControlPlaneFailure(
  reason: string | undefined,
  dispatchState: ControlPlaneDispatchState,
  status: 'failed' | 'interrupted',
  workspaceSubtype?: WorkspaceFailureSubtype
): ControlPlaneFailureClassification {
  if (status === 'interrupted') {
    // An interrupted lifecycle is a cancellation, never a platform failure,
    // even when a wrapper supplied arbitrary text as the reason.
    return reason === 'queued_message_cancelled' ||
      reason === 'interruption_unconfirmed' ||
      reason === 'interrupted'
      ? INTERRUPTION_USER
      : INTERRUPTION_SYSTEM;
  }
  if (workspaceSubtype !== undefined) {
    // The runtime started; a clone/checkout failure is workspace setup, not a
    // wrapper that failed to start.
    return { stage: 'pre_dispatch', code: 'workspace_setup_failed' };
  }
  switch (reason) {
    case 'missing_metadata':
      return { stage: 'pre_dispatch', code: 'session_metadata_missing' };
    case 'preparation_timeout':
    case 'attach_exhausted':
      return PRE_DISPATCH;
    // Spec §10 reasons for the new plane (the mapping's one owner).
    case 'workspace_setup_failed':
      return { stage: 'pre_dispatch', code: 'workspace_setup_failed' };
    case 'billing_blocked':
      return { stage: 'pre_dispatch', code: 'payment_required' };
    case 'billing_unavailable':
      return { stage: 'pre_dispatch', code: 'admission_billing_unavailable' };
    case 'invalid_configuration':
      return PRE_DISPATCH_SANDBOX_CONNECT;
    case 'agent_unavailable':
      return dispatchState === 'accepted'
        ? POST_DISPATCH_WRAPPER_DISCONNECTED
        : PRE_DISPATCH_KILO_SERVER;
    case 'connection_lost':
    case 'sandbox_lost':
    case 'agent_restarted':
      return POST_DISPATCH_WRAPPER_DISCONNECTED;
    case 'no_progress':
    case 'no_outcome':
      return POST_DISPATCH_WRAPPER_NO_OUTPUT;
    case 'prompt_failed':
      return POST_DISPATCH_WRAPPER_ERROR_BEFORE_ACTIVITY;
    case 'sandbox_stopped':
    case 'execution_limit':
      // Spec §10 maps both to interruption/system_interrupt. The report schema
      // permits an interruption classification only on an interrupted run, so
      // the report writer reports a run carrying this classification as
      // interrupted rather than dropping the report.
      return INTERRUPTION_SYSTEM;
    case 'prompt_exhausted':
      return dispatchState === 'accepted'
        ? POST_DISPATCH_WRAPPER_DISCONNECTED
        : { stage: 'pre_dispatch', code: 'invalid_delivery_request' };
    case 'environment_failed':
    case 'environment_stopped':
    case 'credential_containment_unavailable':
    case 'launch_failed':
      return dispatchState === 'accepted'
        ? POST_DISPATCH_WRAPPER_DISCONNECTED
        : PRE_DISPATCH_SANDBOX_CONNECT;
    case 'provider_unknown':
      return dispatchState === 'accepted'
        ? POST_DISPATCH_WRAPPER_DISCONNECTED
        : PRE_DISPATCH_SANDBOX_CONNECT;
    case 'runtime_unhealthy':
    case 'health_unhealthy_absent':
    case 'health_unhealthy_unresponsive':
    case 'kilo_unhealthy':
    case 'control_replaced':
    case 'control_disconnected':
    case 'idle':
      return dispatchState === 'accepted' ? POST_DISPATCH_WRAPPER_DISCONNECTED : PRE_DISPATCH;
    case 'heartbeat_expired':
      return dispatchState === 'accepted' ? POST_DISPATCH_WRAPPER_PING_TIMEOUT : PRE_DISPATCH;
    case 'accepted_overdue':
      return { stage: 'post_dispatch_no_activity', code: 'wrapper_no_output' };
    case 'invalid_model':
      return { stage: 'pre_dispatch', code: 'model_missing' };
    case 'queued_message_cancelled':
    case 'interruption_unconfirmed':
    case undefined:
      return UNKNOWN;
    default:
      return UNKNOWN;
  }
}

export type ControlPlaneRunFailure = {
  stage: CloudAgentFailureStage;
  code: CloudAgentFailureCode;
  /**
   * The report `run.status` this classification belongs to. It lives here, the
   * one mapping owner, so the report writer never re-derives it: an interruption
   * classification is only representable on an interrupted run (spec §10, report
   * schema), so a `failed` run classified as an interruption reports as
   * `interrupted` rather than being dropped.
   */
  reportStatus: 'failed' | 'interrupted';
  responsibility?: CloudAgentFailureResponsibility;
  failureReason?: CloudAgentFailureReason;
};

function reportStatusFor(
  classification: ControlPlaneFailureClassification
): 'failed' | 'interrupted' {
  return classification.stage === 'interruption' ? 'interrupted' : 'failed';
}

/**
 * The control-plane counterpart of the legacy `emitRunStateReport` mapping.
 * Bounded assistant facts, when present, raise the run to `agent_activity` so
 * the frozen classifier can attribute the assistant failure; otherwise the
 * coordinator mapping is passed through unchanged. Responsibility and reason
 * are reported only for a `failed` run.
 */
export function classifyControlPlaneRunFailure(input: {
  reason: string | undefined;
  dispatchState: ControlPlaneDispatchState;
  status: 'failed' | 'interrupted';
  assistantReason?: CloudAgentAssistantFailureReason;
  providerOwnership?: CloudAgentProviderOwnership;
  admittedModel?: string;
  workspaceSubtype?: WorkspaceFailureSubtype;
}): ControlPlaneRunFailure {
  const base = classifyControlPlaneFailure(
    input.reason,
    input.dispatchState,
    input.status,
    input.workspaceSubtype
  );
  if (input.status !== 'failed') return { ...base, reportStatus: reportStatusFor(base) };
  if (input.assistantReason === undefined) {
    const mapped = classifyCloudAgentFailure({
      source: 'run',
      stage: base.stage,
      code: base.code,
      ...(input.workspaceSubtype === undefined ? {} : { workspaceSubtype: input.workspaceSubtype }),
    });
    return {
      ...base,
      reportStatus: reportStatusFor(base),
      responsibility: mapped.responsibility,
      failureReason: mapped.reason,
    };
  }
  const stage: CloudAgentFailureStage = 'agent_activity';
  const code = assistantTerminalCode(input.assistantReason) ?? 'assistant_error';
  const providerOwnership = resolveAssistantProviderOwnership(
    input.providerOwnership,
    input.assistantReason,
    input.admittedModel
  );
  const mapped = classifyCloudAgentFailure({
    source: 'run',
    stage,
    code,
    assistantReason: input.assistantReason,
    ...(providerOwnership === undefined ? {} : { providerOwnership }),
  });
  return {
    stage,
    code,
    reportStatus: 'failed',
    responsibility: mapped.responsibility,
    failureReason: mapped.reason,
  };
}
