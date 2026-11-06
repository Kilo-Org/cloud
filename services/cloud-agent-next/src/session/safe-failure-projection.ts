import {
  CLOUD_AGENT_SAFE_FAILURE_MESSAGE_MAX_LENGTH,
  CloudAgentSafeFailureSchema,
  userVisibleFailureMessage,
  workspaceFailureUserMessage,
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

export function genericFailureMessage(code: CloudAgentFailureCode): string {
  return userVisibleFailureMessage(code);
}

export function workspaceFailureMessage(subtype: WorkspaceFailureSubtype): string {
  return workspaceFailureUserMessage(subtype);
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
