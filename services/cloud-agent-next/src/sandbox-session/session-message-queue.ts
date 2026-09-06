import {
  renderExecutionTurnContent,
  type AcceptedCommandTurn,
  type AcceptedExecutionTurn,
  type AcceptedPromptTurn,
  type AgentSelection,
  type AgentSelectionOverride,
  type SessionMessageIntent,
  type TurnFinalization,
} from '../execution/types.js';
import { dispatchedKilocodeModelId } from '../persistence/model-utils.js';
import type { CloudMessageFailedPayload } from '../session/message-settlement-outbox.js';
import {
  sessionOperationAuthorizationSchema,
  sameSessionOperation,
  type SessionMessageOutcome,
  type SessionOperationAck,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';

export type SessionMessageState = 'queued' | 'accepted' | 'completed' | 'failed' | 'cancelled';
export type SessionMessageTerminalSource = 'coordinator' | 'wrapper_outcome' | 'operation_result';

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

export type SessionOperationProof = {
  authorization: SessionOperationAuthorization;
  dispatched: boolean;
  result?: SessionOperationDelivery['result'];
  resultHash?: string;
  completedAt?: number;
  decision?: SessionOperationAck['decision'];
};

type SessionMessageLifecycle = {
  messageId: string;
  state: SessionMessageState;
  acceptedAt?: number;
  lastActivityAt?: number;
  deliveryDeadlineAt?: number;
  deliveryRetryScope?: 'message' | 'runtime';
  unresolvedDispatch?: true;
  wrapperInstanceId?: string;
  terminalAt?: number;
  terminalSource?: SessionMessageTerminalSource;
  failedReason?: string;
  attachFailures?: number;
  promptFailures?: number;
  preparationAttemptId?: string;
  operations?: {
    attach?: SessionOperationProof;
    prompt?: SessionOperationProof;
  };
};

export type SessionMessageRecordV2 = SessionMessageLifecycle & {
  readonly version: 2;
  readonly intent: ControlSessionMessageIntent;
  turn?: never;
  prompt?: never;
  finalization?: never;
  legacyIntentInvalid?: never;
};

type LegacySessionMessageRecord = SessionMessageLifecycle & {
  version?: undefined;
  intent?: ControlSessionMessageIntent;
  turn?: AcceptedExecutionTurn;
  prompt?: string;
  finalization?: TurnFinalization;
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
  defaults?: AgentSelectionOverride,
  defaultFinalization?: TurnFinalization
): SessionMessageRecord[] {
  return messages.map((message): SessionMessageRecord => {
    if (message.version === 2 || message.state !== 'queued' || message.intent) return message;
    const { turn, prompt, finalization, legacyIntentInvalid, ...record } = message;
    if (legacyIntentInvalid) return message;
    const legacyTurn =
      turn ??
      (prompt !== undefined
        ? { type: 'prompt' as const, messageId: message.messageId, prompt }
        : undefined);
    const intent = legacyTurn
      ? resolveSessionMessageIntent(
          {
            turn: legacyTurn,
            ...(finalization || defaultFinalization
              ? { finalization: { ...defaultFinalization, ...finalization } }
              : {}),
          },
          defaults
        )
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
  reason: string,
  wrapperInstanceId?: string
): { messages: SessionMessageRecord[]; failedIds: string[] } {
  const head =
    messages.find(message => message.state === 'accepted') ??
    messages.find(message => message.state === 'queued');
  const failUnassigned =
    wrapperInstanceId === undefined || head?.wrapperInstanceId === wrapperInstanceId;
  const failedIds: string[] = [];
  return {
    messages: messages.map(message => {
      if (message.state !== 'queued' && message.state !== 'accepted') return message;
      if (
        wrapperInstanceId !== undefined &&
        message.wrapperInstanceId !== wrapperInstanceId &&
        !(message.wrapperInstanceId === undefined && failUnassigned)
      ) {
        return message;
      }
      failedIds.push(message.messageId);
      return { ...message, state: 'failed', failedReason: reason };
    }),
    failedIds,
  };
}

export function incrementDeliveryFailure(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  kind: 'attach' | 'prompt'
): { messages: SessionMessageRecord[]; exhausted: boolean } {
  const field = kind === 'attach' ? 'attachFailures' : 'promptFailures';
  const limit = kind === 'attach' ? ATTACH_FAILURE_LIMIT : PROMPT_FAILURE_LIMIT;
  let failures = 0;
  return {
    messages: messages.map(message => {
      if (message.messageId !== messageId || message.state !== 'queued') return message;
      failures = (message[field] ?? 0) + 1;
      return { ...message, [field]: failures };
    }),
    exhausted: failures >= limit,
  };
}

export function nextQueuedMessageId(messages: readonly SessionMessageRecord[]): string | undefined {
  if (messages.some(message => message.state === 'accepted')) return undefined;
  return messages.find(message => message.state === 'queued')?.messageId;
}

export function applyMessageOutcome(
  messages: readonly SessionMessageRecord[],
  outcome: SessionMessageOutcome,
  wrapperInstanceId: string,
  now: number,
  terminalSource: SessionMessageTerminalSource = 'wrapper_outcome'
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === outcome.messageId);
  if (
    !message ||
    (message.state !== 'queued' && message.state !== 'accepted') ||
    message.wrapperInstanceId !== wrapperInstanceId ||
    (message.state === 'queued' && nextQueuedMessageId(messages) !== message.messageId)
  ) {
    return undefined;
  }
  return messages.map(item =>
    item.messageId === outcome.messageId
      ? {
          ...item,
          state: outcome.status,
          unresolvedDispatch: undefined,
          acceptedAt: item.acceptedAt ?? now,
          terminalAt: now,
          terminalSource,
          ...(outcome.reason ? { failedReason: outcome.reason } : {}),
        }
      : item
  );
}

export function hasAcceptedMessage(messages: readonly SessionMessageRecord[]): boolean {
  return messages.some(message => message.state === 'accepted');
}

export function failQueuedMessage(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  reason?: string
): SessionMessageRecord[] | undefined {
  if (!messages.some(message => message.messageId === messageId && message.state === 'queued')) {
    return undefined;
  }
  return messages.map(message =>
    message.messageId === messageId && message.state === 'queued'
      ? { ...message, state: 'failed', ...(reason ? { failedReason: reason } : {}) }
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
      ? {
          ...message,
          state: 'accepted',
          acceptedAt,
          lastActivityAt: acceptedAt,
          unresolvedDispatch: undefined,
        }
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

export type StreamQueuedSnapshot = {
  messageId: string;
  content: string;
  timestamp: number;
  delivery?: 'sent';
  terminalFailure?: CloudMessageFailedPayload & { timestamp: number };
};

export function failedMessageSnapshot(
  message: SessionMessageRecord,
  now: number
): CloudMessageFailedPayload & { timestamp: number } {
  const accepted = message.acceptedAt !== undefined;
  const cancelled = message.state === 'cancelled';
  return {
    messageId: message.messageId,
    status: cancelled ? 'interrupted' : 'failed',
    delivery: accepted ? 'sent' : 'queued',
    accepted,
    reason: cancelled ? 'interrupted' : message.failedReason,
    ...(cancelled ? { error: 'The message was interrupted' } : {}),
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
        ...(message.state === 'accepted' ? { delivery: 'sent' as const } : {}),
        ...(message.state === 'failed'
          ? { terminalFailure: failedMessageSnapshot(message, now) }
          : {}),
      };
    });
}

export function streamCloudStatus(
  messages: readonly SessionMessageRecord[]
): { type: 'preparing' } | { type: 'ready' } | null {
  if (hasAcceptedMessage(messages)) return { type: 'ready' };
  if (messages.some(message => message.state === 'queued')) return { type: 'preparing' };
  return messages.length > 0 ? { type: 'ready' } : null;
}

export function applySessionOperationResult(
  messages: readonly SessionMessageRecord[],
  delivery: SessionOperationDelivery,
  resultHash: string,
  now: number
):
  | {
      messages: SessionMessageRecord[];
      disposition: SessionOperationAck['disposition'];
      decision: SessionOperationAck['decision'];
    }
  | undefined {
  const authorization = delivery.authorization;
  const message = messages.find(item => item.messageId === authorization.messageId);
  const kind = authorization.operation === 'session.attach' ? 'attach' : 'prompt';
  const proof = message?.operations?.[kind];
  const storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  if (
    !message ||
    !proof?.dispatched ||
    !storedAuthorization.success ||
    message.wrapperInstanceId !== authorization.wrapperInstanceId ||
    !sameSessionOperation(storedAuthorization.data, authorization)
  )
    return undefined;
  if (message.state !== 'queued' && message.state !== 'accepted') {
    if (message.terminalAt === undefined) return undefined;
    return {
      messages: [...messages],
      disposition:
        proof.resultHash === resultHash
          ? 'identical'
          : message.terminalSource === 'coordinator'
            ? 'superseded'
            : 'already_final',
      decision: { state: message.state, at: message.terminalAt },
    };
  }
  if (proof.resultHash !== undefined) {
    return proof.resultHash === resultHash && proof.decision
      ? { messages: [...messages], disposition: 'identical', decision: proof.decision }
      : undefined;
  }
  const applied = delivery.outcome
    ? applyMessageOutcome(
        messages,
        delivery.outcome,
        authorization.wrapperInstanceId,
        now,
        'operation_result'
      )
    : [...messages];
  if (!applied) return undefined;
  const resultMessage = applied.find(item => item.messageId === message.messageId);
  if (!resultMessage) return undefined;
  const decision = {
    state: resultMessage.state,
    at: resultMessage.terminalAt ?? delivery.completedAt,
  };
  return {
    messages: applied.map(item =>
      item.messageId === message.messageId
        ? {
            ...item,
            operations: {
              ...item.operations,
              [kind]: {
                ...proof,
                result: delivery.result,
                resultHash,
                completedAt: delivery.completedAt,
                decision,
              },
            },
          }
        : item
    ),
    disposition: 'applied',
    decision,
  };
}

export function recordSessionOperationDispatch(
  messages: readonly SessionMessageRecord[],
  authorization: SessionOperationAuthorization
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const kind = authorization.operation === 'session.attach' ? 'attach' : 'prompt';
  const proof = message?.operations?.[kind];
  const storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  if (
    !message ||
    nextQueuedMessageId(messages) !== message.messageId ||
    message.wrapperInstanceId !== authorization.wrapperInstanceId ||
    (proof &&
      (!storedAuthorization.success ||
        !sameSessionOperation(storedAuthorization.data, authorization)))
  )
    return undefined;
  return messages.map(item =>
    item.messageId === message.messageId
      ? {
          ...item,
          unresolvedDispatch: true,
          deliveryRetryScope: undefined,
          operations: {
            ...item.operations,
            [kind]: {
              authorization: structuredClone(authorization),
              dispatched: true,
            },
          },
        }
      : item
  );
}

export function completeSessionOperationAttachment(
  messages: readonly SessionMessageRecord[],
  authorization: SessionOperationAuthorization
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const proof = message?.operations?.attach;
  const storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  if (
    authorization.operation !== 'session.attach' ||
    !message ||
    !proof?.dispatched ||
    !storedAuthorization.success ||
    !sameSessionOperation(storedAuthorization.data, authorization) ||
    nextQueuedMessageId(messages) !== message.messageId
  )
    return undefined;
  return messages.map(item =>
    item.messageId === message.messageId
      ? {
          ...item,
          unresolvedDispatch: undefined,
          operations: {
            ...item.operations,
            attach: { ...proof, completedAt: proof.completedAt ?? Date.now() },
          },
        }
      : item
  );
}
