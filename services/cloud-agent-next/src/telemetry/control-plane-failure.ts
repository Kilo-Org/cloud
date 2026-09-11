import type {
  CloudAgentFailureCode,
  CloudAgentFailureStage,
} from '@kilocode/worker-utils/cloud-agent-failure';

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
  status: 'failed' | 'interrupted'
): ControlPlaneFailureClassification {
  if (status === 'interrupted') {
    // An interrupted lifecycle is a cancellation, never a platform failure,
    // even when a wrapper supplied arbitrary text as the reason.
    return reason === 'queued_message_cancelled' || reason === 'interruption_unconfirmed'
      ? INTERRUPTION_USER
      : INTERRUPTION_SYSTEM;
  }
  switch (reason) {
    case 'missing_metadata':
      return { stage: 'pre_dispatch', code: 'session_metadata_missing' };
    case 'preparation_timeout':
    case 'attach_exhausted':
      return PRE_DISPATCH;
    case 'prompt_exhausted':
      return dispatchState === 'accepted'
        ? POST_DISPATCH_WRAPPER_DISCONNECTED
        : { stage: 'pre_dispatch', code: 'invalid_delivery_request' };
    case 'environment_failed':
      return dispatchState === 'accepted'
        ? POST_DISPATCH_WRAPPER_DISCONNECTED
        : PRE_DISPATCH_SANDBOX_CONNECT;
    case 'provider_unknown':
      return PRE_DISPATCH_SANDBOX_CONNECT;
    case 'runtime_unhealthy':
      return dispatchState === 'accepted'
        ? POST_DISPATCH_WRAPPER_DISCONNECTED
        : PRE_DISPATCH;
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
