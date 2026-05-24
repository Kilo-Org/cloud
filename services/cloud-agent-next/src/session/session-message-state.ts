import { z } from 'zod';
import type { CallbackTarget } from '../callbacks/index.js';
import type { ExecutionMode, SessionMessageIntent } from '../execution/types.js';
import { renderExecutionTurnContent } from '../execution/types.js';
import { ImagesSchema } from '../persistence/schemas.js';
import { MESSAGE_ID_FORMAT_DESCRIPTION, MESSAGE_ID_PATTERN } from './message-id.js';

const SESSION_MESSAGE_STATE_PREFIX = 'session_message:';

export type SessionMessageStatus = 'queued' | 'accepted' | 'completed' | 'failed' | 'interrupted';

export type SessionMessageCompletionSource =
  | 'assistant_message_event'
  | 'idle_reconciliation'
  | 'wrapper_failure'
  | 'interrupt'
  | 'delivery_failure';

export type LegacyAdmissionConstraints = {
  turn?: SessionMessageIntent['turn'];
  agent?: {
    mode?: ExecutionMode;
    model?: string;
    variant?: string;
  };
  finalization?: SessionMessageIntent['finalization'];
};

export type TerminalCallbackEffectAccounting =
  | { disposition: 'pending' | 'accounted'; allowWithoutObservedIdle: boolean }
  | { disposition: 'not-required' | 'suppressed' };

export type TerminalEffectAccounting = {
  event: 'pending' | 'accounted';
  callback: TerminalCallbackEffectAccounting;
};

export type SessionMessageState = {
  messageId: string;
  status: SessionMessageStatus;
  prompt: string;
  admissionSnapshot?: SessionMessageIntent;
  legacyAdmissionConstraints?: LegacyAdmissionConstraints;
  createdAt: number;
  queuedAt?: number;
  acceptedAt?: number;
  terminalAt?: number;
  wrapperRunId?: string;
  assistantMessageId?: string;
  assistantCompletedAt?: number;
  completionSource?: SessionMessageCompletionSource;
  error?: string;
  failureReason?: string;
  attempts?: number;
  gateResult?: 'pass' | 'fail';
  callbackRequired?: boolean;
  callbackTarget?: CallbackTarget;
  callbackEnqueuedAt?: number;
  callbackLastError?: string;
  callbackAttempts?: number;
  callbackRetryAt?: number;
  terminalEffects?: TerminalEffectAccounting;
  agent?: {
    mode?: ExecutionMode;
    model?: string;
    variant?: string;
  };
  finalization?: {
    autoCommit?: boolean;
    condenseOnComplete?: boolean;
  };
};

export const SessionMessageStateSchema = z
  .object({
    messageId: z.string().regex(MESSAGE_ID_PATTERN, MESSAGE_ID_FORMAT_DESCRIPTION),
    status: z.enum(['queued', 'accepted', 'completed', 'failed', 'interrupted']),
    prompt: z.string(),
    admissionSnapshot: z
      .object({
        turn: z.discriminatedUnion('type', [
          z.object({
            type: z.literal('prompt'),
            messageId: z.string(),
            prompt: z.string(),
            images: ImagesSchema.optional(),
          }),
          z.object({
            type: z.literal('command'),
            messageId: z.string(),
            command: z.string(),
            arguments: z.string(),
          }),
        ]),
        agent: z.object({ mode: z.string(), model: z.string(), variant: z.string().optional() }),
        finalization: z
          .object({
            autoCommit: z.boolean().optional(),
            condenseOnComplete: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    legacyAdmissionConstraints: z
      .object({
        turn: z
          .discriminatedUnion('type', [
            z.object({
              type: z.literal('prompt'),
              messageId: z.string(),
              prompt: z.string(),
              images: ImagesSchema.optional(),
            }),
            z.object({
              type: z.literal('command'),
              messageId: z.string(),
              command: z.string(),
              arguments: z.string(),
            }),
          ])
          .optional(),
        agent: z
          .object({
            mode: z.string().optional(),
            model: z.string().optional(),
            variant: z.string().optional(),
          })
          .optional(),
        finalization: z
          .object({
            autoCommit: z.boolean().optional(),
            condenseOnComplete: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    turn: z.unknown().optional(),
    images: ImagesSchema.optional(),
    createdAt: z.number(),
    queuedAt: z.number().optional(),
    acceptedAt: z.number().optional(),
    terminalAt: z.number().optional(),
    wrapperRunId: z.string().optional(),
    assistantMessageId: z.string().optional(),
    assistantCompletedAt: z.number().optional(),
    completionSource: z
      .enum([
        'assistant_message_event',
        'idle_reconciliation',
        'wrapper_failure',
        'interrupt',
        'delivery_failure',
      ])
      .optional(),
    error: z.string().optional(),
    failureReason: z.string().optional(),
    attempts: z.number().int().nonnegative().optional(),
    gateResult: z.enum(['pass', 'fail']).optional(),
    callbackRequired: z.boolean().optional(),
    callbackTarget: z
      .object({
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    callbackEnqueuedAt: z.number().optional(),
    callbackLastError: z.string().optional(),
    callbackAttempts: z.number().int().nonnegative().optional(),
    callbackRetryAt: z.number().optional(),
    terminalEffects: z
      .object({
        event: z.enum(['pending', 'accounted']),
        callback: z.union([
          z.object({
            disposition: z.enum(['pending', 'accounted']),
            allowWithoutObservedIdle: z.boolean(),
          }),
          z.object({ disposition: z.enum(['not-required', 'suppressed']) }),
        ]),
      })
      .optional(),
    agent: z
      .object({
        mode: z.string().optional(),
        model: z.string().optional(),
        variant: z.string().optional(),
      })
      .optional(),
    finalization: z
      .object({
        autoCommit: z.boolean().optional(),
        condenseOnComplete: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

export type SessionMessageStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
};

function sessionMessageStateKey(messageId: string): string {
  return `${SESSION_MESSAGE_STATE_PREFIX}${messageId}`;
}

export async function getSessionMessageState(
  storage: SessionMessageStorage,
  messageId: string
): Promise<SessionMessageState | undefined> {
  const raw = await storage.get<unknown>(sessionMessageStateKey(messageId));
  if (raw === undefined) return undefined;
  const result = SessionMessageStateSchema.safeParse(raw);
  if (!result.success) {
    console.warn('Invalid session message state', {
      messageId,
      issues: result.error.issues,
    });
    return undefined;
  }
  const state = result.data;
  const currentState = { ...state };

  delete currentState.turn;
  delete currentState.images;
  delete currentState.agent;
  delete currentState.finalization;
  if (state.admissionSnapshot) return currentState;
  const legacy = raw as {
    turn?: unknown;
    agent?: { mode?: string; model?: string; variant?: string };
    finalization?: SessionMessageIntent['finalization'];
  };
  const parsedTurn = z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('prompt'),
        messageId: z.string(),
        prompt: z.string(),
        images: ImagesSchema.optional(),
      }),
      z.object({
        type: z.literal('command'),
        messageId: z.string(),
        command: z.string(),
        arguments: z.string(),
      }),
    ])
    .safeParse(legacy.turn);
  const constraints: LegacyAdmissionConstraints = {
    turn: parsedTurn.success ? parsedTurn.data : undefined,
    agent:
      legacy.agent &&
      (legacy.agent.mode !== undefined ||
        legacy.agent.model !== undefined ||
        legacy.agent.variant !== undefined)
        ? {
            mode: legacy.agent.mode,
            model: legacy.agent.model,
            variant: legacy.agent.variant,
          }
        : undefined,
    finalization: legacy.finalization,
  };
  if (!constraints.turn && !constraints.agent && !constraints.finalization) return currentState;
  return { ...currentState, legacyAdmissionConstraints: constraints };
}

export async function putSessionMessageState(
  storage: SessionMessageStorage,
  state: SessionMessageState
): Promise<void> {
  await storage.put(
    sessionMessageStateKey(state.messageId),
    SessionMessageStateSchema.parse(state)
  );
}

export function createQueuedSessionMessageState(
  intent: SessionMessageIntent,
  callbackSnapshot?: { required: boolean; target?: CallbackTarget },
  now = Date.now()
): SessionMessageState {
  return {
    messageId: intent.turn.messageId,
    status: 'queued',
    prompt: renderExecutionTurnContent(intent.turn),
    admissionSnapshot: intent,
    createdAt: now,
    queuedAt: now,
    callbackRequired: callbackSnapshot?.required ?? false,
    callbackTarget: callbackSnapshot?.target,
  };
}

export async function markMessageAccepted(
  storage: SessionMessageStorage,
  messageId: string,
  wrapperRunId: string,
  now = Date.now()
): Promise<SessionMessageState | null> {
  const state = await getSessionMessageState(storage, messageId);
  if (!state) return null;
  if (state.status !== 'queued') return null;
  const updated: SessionMessageState = {
    ...state,
    status: 'accepted',
    acceptedAt: now,
    wrapperRunId,
  };
  await putSessionMessageState(storage, updated);
  return updated;
}

export type MarkMessageCompletedParams = {
  assistantMessageId?: string;
  completionSource: SessionMessageCompletionSource;
  gateResult?: 'pass' | 'fail';
};

export async function markMessageCompleted(
  storage: SessionMessageStorage,
  messageId: string,
  params: MarkMessageCompletedParams,
  now = Date.now()
): Promise<SessionMessageState | null> {
  const state = await getSessionMessageState(storage, messageId);
  if (!state) return null;
  if (isTerminalStatus(state.status)) return null;
  const updated: SessionMessageState = {
    ...state,
    status: 'completed',
    terminalAt: now,
    assistantMessageId: params.assistantMessageId,
    completionSource: params.completionSource,
    gateResult: params.gateResult,
  };
  await putSessionMessageState(storage, updated);
  return updated;
}

export type MarkMessageFailedParams = {
  reason: string;
  error?: string;
  completionSource: SessionMessageCompletionSource;
  attempts?: number;
};

export async function markMessageFailed(
  storage: SessionMessageStorage,
  messageId: string,
  params: MarkMessageFailedParams,
  now = Date.now()
): Promise<SessionMessageState | null> {
  const state = await getSessionMessageState(storage, messageId);
  if (!state) return null;
  if (isTerminalStatus(state.status)) return null;
  const updated: SessionMessageState = {
    ...state,
    status: 'failed',
    terminalAt: now,
    failureReason: params.reason,
    error: params.error,
    completionSource: params.completionSource,
    attempts: params.attempts,
  };
  await putSessionMessageState(storage, updated);
  return updated;
}

export type MarkMessageInterruptedParams = {
  error?: string;
  completionSource?: SessionMessageCompletionSource;
};

export async function markMessageInterrupted(
  storage: SessionMessageStorage,
  messageId: string,
  params: MarkMessageInterruptedParams,
  now = Date.now()
): Promise<SessionMessageState | null> {
  const state = await getSessionMessageState(storage, messageId);
  if (!state) return null;
  if (isTerminalStatus(state.status)) return null;
  const updated: SessionMessageState = {
    ...state,
    status: 'interrupted',
    terminalAt: now,
    failureReason: 'interrupted',
    error: params.error,
    completionSource: params.completionSource ?? 'interrupt',
  };
  await putSessionMessageState(storage, updated);
  return updated;
}

function isTerminalStatus(status: SessionMessageStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export function isTerminalMessageState(state: SessionMessageState): boolean {
  return isTerminalStatus(state.status);
}

export async function listNonTerminalAcceptedMessages(
  storage: SessionMessageStorage,
  wrapperRunId?: string
): Promise<SessionMessageState[]> {
  const entries = await listSessionMessageStates(storage);
  return entries.filter(
    state =>
      state.status === 'accepted' &&
      (wrapperRunId === undefined || state.wrapperRunId === wrapperRunId)
  );
}

type NeverAcceptedTerminalQueuedMessageState = SessionMessageState & {
  status: 'failed' | 'interrupted';
};

export async function listNeverAcceptedTerminalQueuedMessages(
  storage: SessionMessageStorage
): Promise<NeverAcceptedTerminalQueuedMessageState[]> {
  const entries = await listSessionMessageStates(storage);
  return entries.filter(
    (state): state is NeverAcceptedTerminalQueuedMessageState =>
      state.acceptedAt === undefined &&
      state.queuedAt !== undefined &&
      (state.status === 'failed' || state.status === 'interrupted') &&
      (state.completionSource === 'delivery_failure' || state.completionSource === 'interrupt')
  );
}

export async function listMessagesWithPendingCallbacks(
  storage: SessionMessageStorage
): Promise<SessionMessageState[]> {
  const entries = await listSessionMessageStates(storage);
  return entries.filter(
    state => isTerminalStatus(state.status) && state.callbackRequired && !state.callbackEnqueuedAt
  );
}

export async function listTerminalMessagesWithPendingEffects(
  storage: SessionMessageStorage
): Promise<SessionMessageState[]> {
  const entries = await listSessionMessageStates(storage);
  return entries
    .flatMap(state => {
      if (!isTerminalStatus(state.status)) return [];
      const normalized =
        state.terminalEffects || !state.callbackRequired || state.callbackEnqueuedAt
          ? state
          : {
              ...state,
              terminalEffects: {
                event: 'accounted' as const,
                callback: { disposition: 'pending' as const, allowWithoutObservedIdle: false },
              },
            };
      if (!normalized.terminalEffects) return [];
      return normalized.terminalEffects.event !== 'accounted' ||
        normalized.terminalEffects.callback.disposition === 'pending'
        ? [normalized]
        : [];
    })
    .sort(
      (left, right) => (left.terminalAt ?? left.createdAt) - (right.terminalAt ?? right.createdAt)
    );
}

async function listSessionMessageStates(
  storage: SessionMessageStorage
): Promise<SessionMessageState[]> {
  const entries = await storage.list<unknown>({ prefix: SESSION_MESSAGE_STATE_PREFIX });
  return Array.from(entries.values()).flatMap(raw => {
    const result = SessionMessageStateSchema.safeParse(raw);
    if (!result.success) {
      console.warn('Skipping invalid session message state', { issues: result.error.issues });
      return [];
    }
    return [result.data];
  });
}

export type TerminalizeEffectOptions = {
  suppressCallback?: boolean;
  allowIdleBatchWithoutObservedIdle?: boolean;
};

export type TerminalizeParams =
  | {
      kind: 'completed';
      assistantMessageId?: string;
      completionSource: SessionMessageCompletionSource;
      gateResult?: 'pass' | 'fail';
    }
  | {
      kind: 'failed';
      reason: string;
      error?: string;
      completionSource: SessionMessageCompletionSource;
      attempts?: number;
    }
  | { kind: 'interrupted'; error?: string; completionSource?: SessionMessageCompletionSource };

export async function terminalizeMessageOnce(
  storage: SessionMessageStorage,
  messageId: string,
  params: TerminalizeParams,
  effectsOrNow: TerminalizeEffectOptions | number = {},
  at = Date.now()
): Promise<{ changed: boolean; state: SessionMessageState | null }> {
  const effects = typeof effectsOrNow === 'number' ? {} : effectsOrNow;
  const now = typeof effectsOrNow === 'number' ? effectsOrNow : at;
  const state = await getSessionMessageState(storage, messageId);
  if (!state) return { changed: false, state: null };
  if (isTerminalStatus(state.status)) return { changed: false, state };

  const terminalEffects: TerminalEffectAccounting = {
    event: 'pending',
    callback: effects.suppressCallback
      ? { disposition: 'suppressed' }
      : state.callbackRequired
        ? {
            disposition: 'pending',
            allowWithoutObservedIdle: effects.allowIdleBatchWithoutObservedIdle ?? false,
          }
        : { disposition: 'not-required' },
  };
  let updated: SessionMessageState;
  if (params.kind === 'completed') {
    updated = {
      ...state,
      status: 'completed',
      terminalAt: now,
      assistantMessageId: params.assistantMessageId,
      completionSource: params.completionSource,
      gateResult: params.gateResult,
      terminalEffects,
    };
  } else if (params.kind === 'failed') {
    updated = {
      ...state,
      status: 'failed',
      terminalAt: now,
      failureReason: params.reason,
      error: params.error,
      completionSource: params.completionSource,
      attempts: params.attempts,
      terminalEffects,
    };
  } else {
    updated = {
      ...state,
      status: 'interrupted',
      terminalAt: now,
      failureReason: 'interrupted',
      error: params.error,
      completionSource: params.completionSource ?? 'interrupt',
      terminalEffects,
    };
  }

  await putSessionMessageState(storage, updated);
  return { changed: true, state: updated };
}
