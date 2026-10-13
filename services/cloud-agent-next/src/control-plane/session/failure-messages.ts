import {
  CONTROL_PLANE_FAILURE_REASON_VALUES,
  type ControlPlaneFailureReason,
} from '../../shared/control-plane-protocol.js';

const CONTROL_REASON_MESSAGES: Record<ControlPlaneFailureReason, string> = {
  preparation_timeout: 'Environment preparation timed out',
  workspace_setup_failed: 'Workspace setup failed',
  agent_unavailable: 'The agent became unavailable',
  billing_blocked: 'Sandbox billing requires additional credits',
  billing_unavailable: 'Sandbox billing is unavailable',
  container_limit_reached:
    'Container limit reached (20 per personal account or 50 per organization). Stop an existing container before starting another.',
  invalid_configuration: 'Sandbox configuration is invalid or unsupported',
  connection_lost: 'The sandbox connection was lost',
  sandbox_lost: 'The sandbox was lost',
  agent_restarted: 'The agent restarted',
  sandbox_out_of_memory: 'The sandbox ran out of memory',
  agent_unresponsive: 'Kilo was not responding and was restarted',
  no_progress: 'The turn made no progress',
  no_outcome: 'The turn did not complete',
  prompt_failed: 'Prompt delivery failed',
  sandbox_stopped: 'The sandbox stopped while waiting for an answer',
  execution_limit: 'The turn exceeded its time limit',
};

export function isControlPlaneFailureReason(value: string): value is ControlPlaneFailureReason {
  return (CONTROL_PLANE_FAILURE_REASON_VALUES as readonly string[]).includes(value);
}

/**
 * Readable text for a settled message's reason. A message reason is either a control-plane
 * code or text Kilo or the wrapper already wrote for the user, which passes through unchanged.
 */
export function messageFailureText(reason: string): string {
  return isControlPlaneFailureReason(reason) ? CONTROL_REASON_MESSAGES[reason] : reason;
}
