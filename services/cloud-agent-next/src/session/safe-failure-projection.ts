import {
  CLOUD_AGENT_SAFE_FAILURE_MESSAGE_MAX_LENGTH,
  CloudAgentSafeFailureSchema,
  type CloudAgentFailureCode,
  type CloudAgentAssistantFailureReason,
  type CloudAgentProviderOwnership,
  type CloudAgentSafeFailure,
  type WorkspaceFailureSubtype,
} from '@kilocode/worker-utils/cloud-agent-failure';
import type {
  SessionMessageFailureCode,
  SessionMessageFailureStage,
} from './session-message-state.js';

export {
  assistantFailureMessage,
  classifyAssistantFailure,
  classifyAssistantFailureMessage,
  isAssistantInterrupt,
  projectSafeAssistantError,
  type AssistantFailureClassification,
} from '../shared/assistant-failure.js';

export const SAFE_FAILURE_MESSAGE_MAX_LENGTH = CLOUD_AGENT_SAFE_FAILURE_MESSAGE_MAX_LENGTH;
export const SafeFailureProjectionSchema = CloudAgentSafeFailureSchema;
export type SafeFailureProjection = CloudAgentSafeFailure;

export type SafeFailureProjectionSource = {
  failureStage?: SessionMessageFailureStage;
  failureCode?: SessionMessageFailureCode;
  failureSubtype?: WorkspaceFailureSubtype;
  attempts?: number;
  safeFailureMessage?: string;
  /**
   * Both are already resolved by classifyAssistantFailure and persisted on the
   * session message state (providerOwnership via resolveTerminalProviderOwnership,
   * which upgrades 'unknown' to 'managed' when the session used an admitted
   * model). Forwarding them lets receivers classify assistant failures from
   * structured values rather than matching the safe message text.
   */
  assistantFailureReason?: CloudAgentAssistantFailureReason;
  providerOwnership?: CloudAgentProviderOwnership;
};

const GENERIC_FAILURE_MESSAGES = {
  sandbox_connect_failed: 'Could not connect to the sandbox',
  workspace_setup_failed: 'Workspace setup failed',
  kilo_server_failed: 'Kilo server failed to start',
  wrapper_start_failed: 'Agent wrapper failed to start',
  invalid_delivery_request: 'The message could not be delivered',
  session_metadata_missing: 'Session metadata is unavailable',
  model_missing: 'No model was selected',
  delivery_failure_unknown: 'The message could not be delivered',
  wrapper_disconnected: 'Agent wrapper disconnected',
  wrapper_no_output: 'Agent wrapper made no execution progress during the watchdog window',
  wrapper_ping_timeout: 'Agent wrapper stopped responding',
  wrapper_error_before_activity: 'Agent wrapper failed before processing the message',
  assistant_error: 'Assistant request failed',
  wrapper_error_after_activity: 'Agent wrapper failed while processing the message',
  missing_assistant_reply: 'No assistant reply was produced',
  payment_required: 'Assistant request failed: insufficient credits',
  user_interrupt: 'The message was interrupted by the user',
  container_shutdown: 'The agent container shut down',
  system_interrupt: 'The message was interrupted',
  unclassified: 'The message failed',
} as const satisfies Record<CloudAgentFailureCode, string>;

const WORKSPACE_FAILURE_MESSAGES = {
  git_clone_timeout: 'Repository clone timed out',
  git_checkout_timeout: 'Repository checkout timed out',
  git_authentication_failed: 'Repository authentication failed',
  git_rate_limited: 'Repository request was rate limited',
  git_network_failed: 'Repository network request failed',
  git_pack_corrupt: 'Repository data is corrupt',
  git_checkout_conflict: 'Repository checkout conflict',
  git_branch_missing: 'Requested repository branch was not found',
  sandbox_storage_full: 'Workspace setup failed: sandbox storage full',
  kilo_import_timeout: 'Session import timed out',
  kilo_import_failed: 'Session import failed',
  setup_command_timeout: 'Setup command timed out',
  setup_command_failed: 'Setup command failed',
  workspace_setup_unknown: 'Workspace setup failed',
} as const satisfies Record<WorkspaceFailureSubtype, string>;

export function genericFailureMessage(code: CloudAgentFailureCode): string {
  return GENERIC_FAILURE_MESSAGES[code];
}

export function workspaceFailureMessage(subtype: WorkspaceFailureSubtype): string {
  return WORKSPACE_FAILURE_MESSAGES[subtype];
}

function boundedWorkspaceMessage(subtype: WorkspaceFailureSubtype, safeDetail?: string): string {
  const genericMessage = workspaceFailureMessage(subtype);
  const detail = safeDetail?.trim();
  if (!detail) return genericMessage;
  if (detail.toLocaleLowerCase().includes(genericMessage.toLocaleLowerCase())) {
    return detail.slice(0, SAFE_FAILURE_MESSAGE_MAX_LENGTH);
  }
  const prefix = `${genericMessage}: `;
  return `${prefix}${detail.slice(0, SAFE_FAILURE_MESSAGE_MAX_LENGTH - prefix.length)}`;
}

export function projectSafeFailure(
  source: SafeFailureProjectionSource
): SafeFailureProjection | undefined {
  const subtype =
    source.failureCode === 'workspace_setup_failed' ? source.failureSubtype : undefined;
  const suppliedMessage = source.safeFailureMessage
    ?.trim()
    .slice(0, SAFE_FAILURE_MESSAGE_MAX_LENGTH);
  const message = subtype
    ? boundedWorkspaceMessage(subtype, suppliedMessage)
    : suppliedMessage ||
      (source.failureCode === undefined ? undefined : genericFailureMessage(source.failureCode));

  if (
    source.failureStage === undefined &&
    source.failureCode === undefined &&
    subtype === undefined &&
    source.attempts === undefined &&
    message === undefined &&
    source.assistantFailureReason === undefined &&
    source.providerOwnership === undefined
  ) {
    return undefined;
  }

  return {
    ...(source.failureStage === undefined ? {} : { stage: source.failureStage }),
    ...(source.failureCode === undefined ? {} : { code: source.failureCode }),
    ...(subtype === undefined ? {} : { subtype }),
    ...(source.attempts === undefined ? {} : { attempts: source.attempts }),
    ...(message === undefined ? {} : { message }),
    ...(source.assistantFailureReason === undefined
      ? {}
      : { assistantReason: source.assistantFailureReason }),
    ...(source.providerOwnership === undefined
      ? {}
      : { providerOwnership: source.providerOwnership }),
  };
}
