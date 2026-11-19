import {
  CONTROL_PLANE_FAILURE_REASON_VALUES,
  type ControlPlaneFailureReason,
} from '../../shared/control-plane-protocol.js';
import { SESSION_CREDENTIAL_UPGRADE_REQUIRED_MESSAGE } from '../../shared/credential-upgrade.js';

const CONTROL_REASON_MESSAGES: Record<ControlPlaneFailureReason, string> = {
  runtime_artifact_unauthorized: 'Runtime download was not authorized',
  runtime_artifact_invalid: 'Runtime artifact verification failed',
  runtime_cli_probe_failed: 'Runtime CLI validation failed',
  runtime_supervisor_missing: 'Runtime supervisor is missing',
  environment_restore_failed:
    'Prepared environment restoration failed. Rebuild the environment and try again.',
  environment_restore_unavailable:
    'Prepared environment restoration was interrupted. Send a new message to retry. If the failure continues, contact Kilo.',
  preparation_timeout: 'Environment preparation timed out',
  preparation_cancelled: 'Environment preparation was stopped',
  workspace_setup_failed: 'Workspace setup failed',
  credential_upgrade_required: SESSION_CREDENTIAL_UPGRADE_REQUIRED_MESSAGE,
  repository_access_failed:
    'A repository of this environment could not be accessed. Check that the integration covers every repository of the environment.',
  agent_unavailable: 'The agent became unavailable',
  billing_blocked: 'Sandbox billing requires additional credits',
  billing_unavailable:
    'Sandbox billing or capacity verification is unavailable. Try again shortly.',
  container_limit_reached:
    'Container limit reached. Stop an existing container before starting another.',
  account_blocked: 'This account is blocked.',
  invalid_configuration: 'Sandbox configuration is invalid or unsupported',
  sandbox_create_failed: 'The sandbox could not be created',
  connection_lost: 'The sandbox connection was lost',
  sandbox_lost: 'The sandbox was lost',
  agent_restarted: 'The agent restarted',
  sandbox_out_of_memory: 'The sandbox ran out of memory',
  agent_unresponsive: 'Kilo was not responding and was restarted',
  no_progress: 'The turn made no progress',
  no_outcome: 'The turn did not complete',
  completion_unconfirmed:
    'The assistant finished its reply, but session completion could not be confirmed. Send a new message to continue.',
  completion_quiet_drain:
    'The assistant finished its reply, but background work did not finish in time. Send a new message to continue.',
  prompt_failed: 'Prompt delivery failed',
  sandbox_stopped: 'The sandbox stopped while waiting for an answer',
  execution_limit: 'The turn exceeded its time limit',
  provider_lifetime_exhausted:
    'The sandbox reached its provider lifetime limit. Send a new message to start another sandbox.',
  provider_cleanup_required:
    'Sandbox launch status could not be recovered. Contact support to reconcile the allocation before starting another sandbox.',
  byoc_credential_missing: 'The compute connection is no longer available',
  byoc_aws_not_ready: 'AWS compute setup is not ready',
  byoc_aws_forbidden:
    'AWS rejected access to your compute account. Check the customer role and ExternalId.',
  byoc_aws_stack_outdated: 'The AWS stack needs an update. Open Compute settings to update it.',
  byoc_aws_proxy_unavailable:
    'AWS security proxy is unavailable. Try again, or check Compute settings.',
  byoc_aws_proxy_expired:
    'The AWS proxy certificate needs replacement. Open Compute settings to update the stack.',
  byoc_aws_scm_host_unsupported: 'AWS compute supports managed SCM on standard public hosts only.',
  byoc_aws_connection_changed:
    'AWS proxy configuration changed. Open Compute settings to verify the connection.',
  byoc_vercel_not_ready: 'Vercel compute setup is not ready',
  byoc_vercel_forbidden: 'Vercel rejected access to your compute account',
  byoc_vercel_capacity: 'Vercel compute capacity is unavailable',
  byoc_vercel_snapshot_missing: 'The Vercel runtime snapshot is missing. Run setup again.',
  provider_identity_mismatch: 'Sandbox credential containment could not verify provider identity.',
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
