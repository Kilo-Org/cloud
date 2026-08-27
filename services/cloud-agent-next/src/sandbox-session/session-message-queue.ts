import {
  renderExecutionTurnContent,
  type AcceptedCommandTurn,
  type AcceptedExecutionTurn,
  type AcceptedPromptTurn,
  type AgentSelection,
  type AgentSelectionOverride,
  type SessionMessageIntent,
} from '../execution/types.js';
import { dispatchedKilocodeModelId } from '../persistence/model-utils.js';
import type { CloudMessageFailedPayload } from '../session/message-settlement-outbox.js';

export type SessionMessageState = 'queued' | 'accepted' | 'completed' | 'failed' | 'cancelled';

export type ControlCommandAgentSelection = Omit<AgentSelection, 'model'> & { model?: string };

export type ControlSessionMessageIntent =
  | (SessionMessageIntent & { turn: AcceptedPromptTurn })
  | (Omit<SessionMessageIntent, 'turn' | 'agent'> & {
      turn: AcceptedCommandTurn;
      agent: ControlCommandAgentSelection;
    });

export type ControlSessionMessageInput = Pick<SessionMessageIntent, 'turn' | 'finalization'> & {
  agent?: AgentSelectionOverride;
};

type SessionMessageLifecycle = {
  messageId: string;
  state: SessionMessageState;
  acceptedAt?: number;
  lastActivityAt?: number;
  failedReason?: string;
  attachFailures?: number;
  promptFailures?: number;
  preparationAttemptId?: string;
};

export type SessionMessageRecordV2 = SessionMessageLifecycle & {
  readonly version: 2;
  readonly intent: ControlSessionMessageIntent;
  turn?: never;
  prompt?: never;
  legacyIntentInvalid?: never;
};

type LegacySessionMessageRecord = SessionMessageLifecycle & {
  version?: undefined;
  intent?: undefined;
  turn?: AcceptedExecutionTurn;
  prompt?: string;
  legacyIntentInvalid?: true;
};

export type SessionMessageRecord = SessionMessageRecordV2 | LegacySessionMessageRecord;

export const ATTACH_FAILURE_LIMIT = 2;
export const PROMPT_FAILURE_LIMIT = 5;

export function resolveSessionMessageIntent(
  input: ControlSessionMessageInput,
  defaults?: AgentSelectionOverride
): ControlSessionMessageIntent | undefined {
  const model = input.agent?.model !== undefined ? input.agent.model : defaults?.model;
  const modelId = dispatchedKilocodeModelId(model);
  if (model !== undefined && !modelId) return undefined;

  const mode = input.agent?.mode ?? defaults?.mode ?? 'code';
  const variant =
    input.agent?.variant ??
    (modelId === dispatchedKilocodeModelId(defaults?.model) ? defaults?.variant : undefined);
  const agent = {
    mode,
    ...(model !== undefined ? { model } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
  const finalization = input.finalization
    ? {
        autoCommit: input.finalization.autoCommit,
        condenseOnComplete: input.finalization.condenseOnComplete,
      }
    : undefined;
  if (input.turn.type === 'prompt') {
    if (model === undefined) return undefined;
    return {
      turn: structuredClone(input.turn),
      agent: { ...agent, model },
      ...(finalization ? { finalization } : {}),
    };
  }
  return {
    turn: structuredClone(input.turn),
    agent,
    ...(finalization ? { finalization } : {}),
  };
}

export function createSessionMessageRecord(
  intent: ControlSessionMessageIntent
): SessionMessageRecordV2 {
  return {
    version: 2,
    messageId: intent.turn.messageId,
    state: 'queued',
    intent: structuredClone(intent),
  };
}

export function getSessionMessageTurn(
  message: SessionMessageRecord
): AcceptedExecutionTurn | undefined {
  return (
    message.intent?.turn ??
    message.turn ??
    (message.prompt !== undefined
      ? { type: 'prompt', messageId: message.messageId, prompt: message.prompt }
      : undefined)
  );
}

function sameExecutionTurn(left: AcceptedExecutionTurn, right: AcceptedExecutionTurn): boolean {
  if (left.messageId !== right.messageId) return false;
  if (left.type === 'command') {
    return (
      right.type === 'command' &&
      left.command === right.command &&
      left.arguments === right.arguments
    );
  }
  return (
    right.type === 'prompt' &&
    left.prompt === right.prompt &&
    left.attachments?.path === right.attachments?.path &&
    JSON.stringify(left.attachments?.files) === JSON.stringify(right.attachments?.files)
  );
}

export function matchesSessionMessageReplay(
  message: SessionMessageRecord,
  input: ControlSessionMessageInput
): boolean {
  if (message.state !== 'queued' && message.state !== 'accepted') return false;
  if (message.messageId !== input.turn.messageId || message.legacyIntentInvalid) return false;
  const turn = getSessionMessageTurn(message);
  if (turn && !sameExecutionTurn(turn, input.turn)) return false;
  const requestedModelId = dispatchedKilocodeModelId(input.agent?.model);
  if (input.agent?.model !== undefined && !requestedModelId) return false;
  const intent = message.intent;
  if (!intent) return true;
  return (
    (input.agent?.model === undefined ||
      requestedModelId === dispatchedKilocodeModelId(intent.agent.model)) &&
    (input.agent?.mode === undefined || input.agent.mode === intent.agent.mode) &&
    (input.agent?.variant === undefined || input.agent.variant === intent.agent.variant) &&
    (input.finalization?.autoCommit === undefined ||
      input.finalization.autoCommit === intent.finalization?.autoCommit) &&
    (input.finalization?.condenseOnComplete === undefined ||
      input.finalization.condenseOnComplete === intent.finalization?.condenseOnComplete)
  );
}

export function freezeLegacyQueuedMessages(
  messages: readonly SessionMessageRecord[],
  defaults?: AgentSelectionOverride
): SessionMessageRecord[] {
  return messages.map((message): SessionMessageRecord => {
    if (message.state !== 'queued' || message.intent) return message;
    const { turn, prompt, legacyIntentInvalid, ...record } = message;
    if (legacyIntentInvalid) return message;
    const legacyTurn =
      turn ??
      (prompt !== undefined
        ? { type: 'prompt' as const, messageId: message.messageId, prompt }
        : undefined);
    const intent = legacyTurn
      ? resolveSessionMessageIntent({ turn: legacyTurn }, defaults)
      : undefined;
    return intent
      ? { ...record, ...createSessionMessageRecord(intent) }
      : { ...message, legacyIntentInvalid: true };
  });
}

export function assignPreparationAttemptId(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  mint: () => string
): { messages: SessionMessageRecord[]; attemptId: string } | undefined {
  const message = messages.find(item => item.messageId === messageId);
  if (!message) return undefined;
  if (message.preparationAttemptId) {
    return {
      messages: messages as SessionMessageRecord[],
      attemptId: message.preparationAttemptId,
    };
  }
  const attemptId = mint();
  return {
    messages: messages.map(item =>
      item.messageId === messageId ? { ...item, preparationAttemptId: attemptId } : item
    ),
    attemptId,
  };
}

export function failWaitingMessages(
  messages: readonly SessionMessageRecord[],
  reason: string
): { messages: SessionMessageRecord[]; failedIds: string[] } {
  const failedIds: string[] = [];
  return {
    messages: messages.map(message => {
      if (message.state !== 'queued' && message.state !== 'accepted') return message;
      failedIds.push(message.messageId);
      return { ...message, state: 'failed', failedReason: reason };
    }),
    failedIds,
  };
}

export function incrementAttachFailure(
  messages: readonly SessionMessageRecord[],
  messageId: string
): { messages: SessionMessageRecord[]; failures: number } {
  let failures = 0;
  return {
    messages: messages.map(message => {
      if (message.messageId !== messageId) return message;
      failures = (message.attachFailures ?? 0) + 1;
      return { ...message, attachFailures: failures };
    }),
    failures,
  };
}

export function incrementPromptFailure(
  messages: readonly SessionMessageRecord[],
  messageId: string
): { messages: SessionMessageRecord[]; failures: number } {
  let failures = 0;
  return {
    messages: messages.map(message => {
      if (message.messageId !== messageId) return message;
      failures = (message.promptFailures ?? 0) + 1;
      return { ...message, promptFailures: failures };
    }),
    failures,
  };
}

export function isAttachExhausted(failures: number): boolean {
  return failures >= ATTACH_FAILURE_LIMIT;
}

export function isPromptExhausted(failures: number): boolean {
  return failures >= PROMPT_FAILURE_LIMIT;
}

export function nextQueuedMessageId(messages: readonly SessionMessageRecord[]): string | undefined {
  if (messages.some(message => message.state === 'accepted')) return undefined;
  return messages.find(message => message.state === 'queued')?.messageId;
}

export function userTurnTerminalState(
  type: string,
  kiloSessionId?: string,
  rootKiloSessionId?: string
): 'completed' | 'failed' | undefined {
  if (
    kiloSessionId !== undefined &&
    rootKiloSessionId !== undefined &&
    kiloSessionId !== rootKiloSessionId
  ) {
    return undefined;
  }
  if (type === 'session.turn.close') return 'completed';
  if (type === 'session.error') return 'failed';
  return undefined;
}

export function terminalizeAcceptedMessages(
  messages: readonly SessionMessageRecord[],
  state: 'completed' | 'failed'
): SessionMessageRecord[] {
  return messages.map(message => (message.state === 'accepted' ? { ...message, state } : message));
}

export function hasAcceptedMessage(messages: readonly SessionMessageRecord[]): boolean {
  return messages.some(message => message.state === 'accepted');
}

export function cancelActiveMessages(messages: readonly SessionMessageRecord[]): {
  messages: SessionMessageRecord[];
  cancelledIds: string[];
} {
  const cancelledIds: string[] = [];
  return {
    messages: messages.map(message => {
      if (message.state !== 'queued' && message.state !== 'accepted') return message;
      cancelledIds.push(message.messageId);
      return { ...message, state: 'cancelled' };
    }),
    cancelledIds,
  };
}

export function failQueuedMessage(
  messages: readonly SessionMessageRecord[],
  messageId: string
): SessionMessageRecord[] | undefined {
  if (!messages.some(message => message.messageId === messageId && message.state === 'queued')) {
    return undefined;
  }
  return messages.map(message =>
    message.messageId === messageId && message.state === 'queued'
      ? { ...message, state: 'failed' }
      : message
  );
}

export function acceptQueuedMessage(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  acceptedAt: number
): SessionMessageRecord[] | undefined {
  if (nextQueuedMessageId(messages) !== messageId) return undefined;
  return messages.map(message =>
    message.messageId === messageId
      ? { ...message, state: 'accepted', acceptedAt, lastActivityAt: acceptedAt }
      : message
  );
}

export function recordAcceptedMessageActivity(
  messages: readonly SessionMessageRecord[],
  lastActivityAt: number
): SessionMessageRecord[] | undefined {
  if (!hasAcceptedMessage(messages)) return undefined;
  return messages.map(message =>
    message.state === 'accepted' ? { ...message, lastActivityAt } : message
  );
}

export function hasInterruptibleWork(messages: readonly SessionMessageRecord[]): boolean {
  return messages.some(
    message =>
      message.state === 'queued' || message.state === 'accepted' || message.state === 'cancelled'
  );
}

export type StreamQueuedSnapshot = {
  messageId: string;
  content: string;
  timestamp: number;
  terminalFailure?: CloudMessageFailedPayload & { timestamp: number };
};

export function failedMessageSnapshot(
  message: SessionMessageRecord,
  now: number
): CloudMessageFailedPayload & { timestamp: number } {
  const accepted = message.acceptedAt !== undefined;
  return {
    messageId: message.messageId,
    status: 'failed',
    delivery: accepted ? 'sent' : 'queued',
    accepted,
    reason: message.failedReason,
    timestamp: message.acceptedAt ?? now,
  };
}

export function streamQueuedSnapshots(
  messages: readonly SessionMessageRecord[],
  now: number
): StreamQueuedSnapshot[] {
  return messages
    .filter(
      message =>
        message.state === 'queued' || message.state === 'accepted' || message.state === 'failed'
    )
    .map(message => {
      const turn = getSessionMessageTurn(message);
      return {
        messageId: message.messageId,
        content: turn ? renderExecutionTurnContent(turn) : '',
        timestamp: message.acceptedAt ?? now,
        ...(message.state === 'failed'
          ? { terminalFailure: failedMessageSnapshot(message, now) }
          : {}),
      };
    });
}

export function streamCloudStatus(
  messages: readonly SessionMessageRecord[]
): { type: 'preparing' } | { type: 'ready' } | null {
  if (messages.some(message => message.state === 'queued' || message.state === 'accepted')) {
    return { type: 'preparing' };
  }
  return messages.length > 0 ? { type: 'ready' } : null;
}
