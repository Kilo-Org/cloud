import {
  findPendingSessionMessageByMessageId,
  type PendingSessionMessage,
  type SessionQueueStorage,
} from './pending-messages.js';
import {
  lookupSessionMessageState,
  type SessionMessageCompletionSource,
  type SessionMessageState,
  type SessionMessageStorage,
} from './session-message-state.js';
import { projectSafeFailure, type SafeFailureProjection } from './safe-failure-projection.js';
import { isTerminalFailureRetryable } from './terminal-error-projector.js';

export type SafeMessageResult = {
  messageId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  createdAt: number;
  queuedAt?: number;
  acceptedAt?: number;
  terminalAt?: number;
  completionSource?: SessionMessageCompletionSource;
  failure?: SafeFailureProjection & { retryable: boolean };
  gateResult?: 'pass' | 'fail';
};

export type SafeMessageResultResponse = SafeMessageResult & {
  cloudAgentSessionId: string;
  assistant?: {
    messageId: string;
    text?: string;
  };
};

export type MessageResultRPCResponse =
  | { type: 'session-not-found' }
  | { type: 'message-not-found' }
  | { type: 'state-invalid' }
  | { type: 'found'; result: SafeMessageResultResponse };

type AssistantLookup = { type: 'message-id'; messageId: string; parentMessageId: string };

type ResolvedSessionMessageResult =
  | { type: 'state-invalid' }
  | { type: 'found'; result: SafeMessageResult; assistantLookup?: AssistantLookup };

type MessageResultStorage = SessionMessageStorage & SessionQueueStorage;

function projectFailure(state: SessionMessageState): SafeMessageResult['failure'] {
  if (state.status !== 'failed' && state.status !== 'interrupted') return undefined;
  return {
    ...projectSafeFailure(state),
    retryable: isTerminalFailureRetryable({
      failureStage: state.failureStage,
      failureCode: state.failureCode,
    }),
  };
}

function projectLifecycleState(state: SessionMessageState): ResolvedSessionMessageResult {
  const failure = projectFailure(state);
  const assistantLookup: AssistantLookup | undefined =
    state.status === 'completed' && state.assistantMessageId
      ? {
          type: 'message-id',
          messageId: state.assistantMessageId,
          parentMessageId: state.messageId,
        }
      : undefined;
  return {
    type: 'found',
    result: {
      messageId: state.messageId,
      status: state.status === 'accepted' ? 'running' : state.status,
      createdAt: state.createdAt,
      ...(state.queuedAt === undefined ? {} : { queuedAt: state.queuedAt }),
      ...(state.acceptedAt === undefined ? {} : { acceptedAt: state.acceptedAt }),
      ...(state.terminalAt === undefined ? {} : { terminalAt: state.terminalAt }),
      ...(state.completionSource === undefined ? {} : { completionSource: state.completionSource }),
      ...(failure === undefined ? {} : { failure }),
      ...(state.gateResult === undefined ? {} : { gateResult: state.gateResult }),
    },
    ...(assistantLookup ? { assistantLookup } : {}),
  };
}

function projectPendingMessage(message: PendingSessionMessage): ResolvedSessionMessageResult {
  return {
    type: 'found',
    result: {
      messageId: message.messageId,
      status: 'queued',
      createdAt: message.createdAt,
      queuedAt: message.createdAt,
    },
  };
}

export async function resolveSessionMessageResult(
  storage: MessageResultStorage,
  messageId: string
): Promise<ResolvedSessionMessageResult | undefined> {
  const lifecycle = await lookupSessionMessageState(storage, messageId);
  if (lifecycle.type === 'invalid') return { type: 'state-invalid' };
  if (lifecycle.type === 'found') return projectLifecycleState(lifecycle.state);
  const pending = await findPendingSessionMessageByMessageId(storage, messageId);
  return pending ? projectPendingMessage(pending) : undefined;
}
