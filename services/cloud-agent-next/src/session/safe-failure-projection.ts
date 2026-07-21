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

export const SAFE_FAILURE_MESSAGE_MAX_LENGTH = CLOUD_AGENT_SAFE_FAILURE_MESSAGE_MAX_LENGTH;
export const SafeFailureProjectionSchema = CloudAgentSafeFailureSchema;
export type SafeFailureProjection = CloudAgentSafeFailure;

export type SafeFailureProjectionSource = {
  failureStage?: SessionMessageFailureStage;
  failureCode?: SessionMessageFailureCode;
  failureSubtype?: WorkspaceFailureSubtype;
  attempts?: number;
  safeFailureMessage?: string;
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
  wrapper_no_output: 'Agent wrapper produced no output',
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

export type AssistantFailureClassification = {
  reason: CloudAgentAssistantFailureReason;
  safeMessage: string;
  providerOwnership: CloudAgentProviderOwnership;
  terminalCode?: 'payment_required' | 'model_missing';
};

export function classifyAssistantFailure(
  source: unknown,
  defaultProviderOwnership: CloudAgentProviderOwnership = 'unknown'
): AssistantFailureClassification {
  const message = extractErrorMessage(source).toLocaleLowerCase();
  const providerOwnership = /\[byok\]/i.test(message) ? 'byok' : defaultProviderOwnership;
  if (/\b(payment required|insufficient (?:credits?|balance|funds))\b/.test(message)) {
    return {
      reason: 'insufficient_credits',
      safeMessage: 'Assistant request failed: insufficient credits',
      providerOwnership,
      terminalCode: 'payment_required',
    };
  }
  if (/\b(model (?:was )?not found|unknown model|invalid model)\b/.test(message)) {
    return {
      reason: 'model_unavailable',
      safeMessage: 'Assistant request failed: model not found',
      providerOwnership,
      terminalCode: 'model_missing',
    };
  }
  if (
    /\b(rate limit|rate_limit|usage[_ -]?limit[_ -]?exceeded|too many requests|429)\b/.test(message)
  ) {
    return {
      reason: 'rate_limited',
      safeMessage: 'Assistant request was rate limited',
      providerOwnership,
    };
  }
  if (/\b(timed? out|timeout|deadline exceeded)\b/.test(message)) {
    return {
      reason: 'timeout',
      safeMessage: 'Assistant request timed out',
      providerOwnership,
    };
  }
  if (/\b(unauthorized|forbidden|authorization|authentication|401|403)\b/.test(message)) {
    return {
      reason: 'provider_authentication',
      safeMessage: 'Assistant request was not authorized',
      providerOwnership,
    };
  }
  if (/\b(invalid request|bad request|malformed request|400)\b/.test(message)) {
    return {
      reason: 'invalid_request',
      safeMessage: 'Assistant request was invalid',
      providerOwnership,
    };
  }
  if (/\b(service unavailable|temporarily unavailable|overloaded|502|503|504)\b/.test(message)) {
    return {
      reason: 'provider_unavailable',
      safeMessage: 'Assistant service is unavailable',
      providerOwnership,
    };
  }
  return {
    reason: 'unknown',
    safeMessage: GENERIC_FAILURE_MESSAGES.assistant_error,
    providerOwnership,
  };
}

export function classifyAssistantFailureMessage(source: unknown): string {
  return classifyAssistantFailure(source).safeMessage;
}

function extractErrorMessage(source: unknown): string {
  if (typeof source === 'string') return source;
  if (typeof source !== 'object' || source === null) return '';
  if ('data' in source && typeof source.data === 'object' && source.data !== null) {
    if ('message' in source.data && typeof source.data.message === 'string') {
      return source.data.message;
    }
  }
  if ('message' in source && typeof source.message === 'string') return source.message;
  return '';
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
    message === undefined
  ) {
    return undefined;
  }

  return {
    ...(source.failureStage === undefined ? {} : { stage: source.failureStage }),
    ...(source.failureCode === undefined ? {} : { code: source.failureCode }),
    ...(subtype === undefined ? {} : { subtype }),
    ...(source.attempts === undefined ? {} : { attempts: source.attempts }),
    ...(message === undefined ? {} : { message }),
  };
}
