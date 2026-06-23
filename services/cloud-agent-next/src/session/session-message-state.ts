import { z } from 'zod';
import {
  CloudAgentFailureCodeSchema,
  CloudAgentFailureStageSchema,
  WorkspaceFailureSubtypeSchema,
  type CloudAgentFailureCode,
  type CloudAgentFailureStage,
} from '@kilocode/worker-utils/cloud-agent-failure';
import type { CloudAgentRunStateReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import type { CallbackTarget } from '../callbacks/index.js';
import type { ExecutionMode, SessionMessageIntent } from '../execution/types.js';
import { renderExecutionTurnContent } from '../execution/types.js';
import { AttachmentsSchema } from '../persistence/schemas.js';
import { MESSAGE_ID_FORMAT_DESCRIPTION, MESSAGE_ID_PATTERN } from './message-id.js';
import {
  WRAPPER_READY_ERROR_DETAIL_MAX_LENGTH,
  type WorkspaceFailureSubtype,
} from '../shared/wrapper-bootstrap.js';
import {
  getWrapperRuntimeState,
  hasCompleteWrapperRunMessageIndex,
} from './wrapper-runtime-state.js';
import {
  parseModelNotFoundRuntimeDiagnostics,
  type ModelNotFoundRuntimeDiagnostics,
} from '../shared/runtime-model-diagnostics.js';

const SESSION_MESSAGE_STATE_PREFIX = 'session_message:';
const WRAPPER_RUN_MESSAGE_INDEX_PREFIX = 'session_message_wrapper_run:';

const ModelNotFoundRuntimeDiagnosticsSchema = z.custom<ModelNotFoundRuntimeDiagnostics>(
  value => parseModelNotFoundRuntimeDiagnostics(value).success,
  'Invalid model-not-found runtime diagnostics'
);

export type SessionMessageStatus = 'queued' | 'accepted' | 'completed' | 'failed' | 'interrupted';

export const SessionMessageCompletionSourceSchema = z.enum([
  'assistant_message_event',
  'manual_compact_summarize',
  'idle_reconciliation',
  'wrapper_failure',
  'interrupt',
  'delivery_failure',
]);
export type SessionMessageCompletionSource = z.infer<typeof SessionMessageCompletionSourceSchema>;

type AssertTrue<T extends true> = T;
type CloudAgentRunFailureStage = NonNullable<CloudAgentRunStateReport['run']['failureStage']>;
type CloudAgentRunFailureCode = NonNullable<CloudAgentRunStateReport['run']['failureCode']>;
type StageContractMatchesReport = AssertTrue<
  CloudAgentRunFailureStage extends CloudAgentFailureStage ? true : false
>;
type CodeContractMatchesReport = AssertTrue<
  CloudAgentRunFailureCode extends CloudAgentFailureCode ? true : false
>;

export const SessionMessageFailureStageSchema = CloudAgentFailureStageSchema;
export type SessionMessageFailureStage = StageContractMatchesReport extends true
  ? CloudAgentFailureStage
  : never;

export const SessionMessageFailureCodeSchema = CloudAgentFailureCodeSchema;
export type SessionMessageFailureCode = CodeContractMatchesReport extends true
  ? CloudAgentFailureCode
  : never;
export type SessionMessageDispatchAcceptanceKind = 'observed' | 'inferred_from_terminal';

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

export type TerminalPushEffectAccounting = {
  disposition: 'pending' | 'accounted' | 'not-required' | 'suppressed';
};

export type TerminalEffectAccounting = {
  event: 'pending' | 'accounted';
  callback: TerminalCallbackEffectAccounting;
  push?: TerminalPushEffectAccounting;
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
  dispatchAcceptanceKind?: SessionMessageDispatchAcceptanceKind;
  agentActivityObservedAt?: number;
  terminalAt?: number;
  wrapperRunId?: string;
  assistantMessageId?: string;
  assistantCompletedAt?: number;
  completionSource?: SessionMessageCompletionSource;
  failureStage?: SessionMessageFailureStage;
  failureCode?: SessionMessageFailureCode;
  failureSubtype?: WorkspaceFailureSubtype;
  safeFailureMessage?: string;
  modelNotFoundRuntimeDiagnostics?: ModelNotFoundRuntimeDiagnostics;
  error?: string;
  failureReason?: string;
  attempts?: number;
  gateResult?: 'pass' | 'fail';
  callbackRequired?: boolean;
  callbackTarget?: CallbackTarget;
  callbackEnqueuedAt?: number;
  callbackAbandonedAt?: number;
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
          z
            .object({
              type: z.literal('prompt'),
              messageId: z.string(),
              prompt: z.string(),
              attachments: AttachmentsSchema.optional(),
            })
            .strict(),
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
            z
              .object({
                type: z.literal('prompt'),
                messageId: z.string(),
                prompt: z.string(),
                attachments: AttachmentsSchema.optional(),
              })
              .strict(),
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
    createdAt: z.number(),
    queuedAt: z.number().optional(),
    acceptedAt: z.number().optional(),
    dispatchAcceptanceKind: z.enum(['observed', 'inferred_from_terminal']).optional(),
    agentActivityObservedAt: z.number().optional(),
    terminalAt: z.number().optional(),
    wrapperRunId: z.string().optional(),
    assistantMessageId: z.string().optional(),
    assistantCompletedAt: z.number().optional(),
    completionSource: SessionMessageCompletionSourceSchema.optional(),
    failureStage: SessionMessageFailureStageSchema.optional(),
    failureCode: SessionMessageFailureCodeSchema.optional(),
    failureSubtype: WorkspaceFailureSubtypeSchema.optional(),
    safeFailureMessage: z.string().max(WRAPPER_READY_ERROR_DETAIL_MAX_LENGTH).optional(),
    modelNotFoundRuntimeDiagnostics: ModelNotFoundRuntimeDiagnosticsSchema.optional(),
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
    callbackAbandonedAt: z.number().optional(),
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
        push: z
          .object({ disposition: z.enum(['pending', 'accounted', 'not-required', 'suppressed']) })
          .optional(),
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
  .passthrough()
  .refine(
    state => state.failureSubtype === undefined || state.failureCode === 'workspace_setup_failed',
    {
      message: 'Workspace failure subtype requires workspace_setup_failed failure code',
      path: ['failureSubtype'],
    }
  );

export type SessionMessageStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
};

function sessionMessageStateKey(messageId: string): string {
  return `${SESSION_MESSAGE_STATE_PREFIX}${messageId}`;
}

function wrapperRunMessageIndexPrefix(wrapperRunId: string): string {
  return `${WRAPPER_RUN_MESSAGE_INDEX_PREFIX}${encodeURIComponent(wrapperRunId)}:`;
}

function wrapperRunMessageIndexKey(wrapperRunId: string, messageId: string): string {
  return `${wrapperRunMessageIndexPrefix(wrapperRunId)}${messageId}`;
}

function normalizeLegacyAdmissionConstraints(
  constraints: z.infer<typeof SessionMessageStateSchema>['legacyAdmissionConstraints']
): LegacyAdmissionConstraints | undefined {
  if (!constraints) return undefined;
  return {
    ...constraints,
    turn:
      constraints.turn?.type === 'prompt'
        ? {
            type: 'prompt',
            messageId: constraints.turn.messageId,
            prompt: constraints.turn.prompt,
            attachments: constraints.turn.attachments,
          }
        : constraints.turn,
  };
}

function normalizeParsedSessionMessageState(
  state: z.infer<typeof SessionMessageStateSchema>
): SessionMessageState {
  const currentState = { ...state };

  delete currentState.turn;
  delete currentState.images;
  delete currentState.agent;
  delete currentState.finalization;
  currentState.legacyAdmissionConstraints = normalizeLegacyAdmissionConstraints(
    state.legacyAdmissionConstraints
  );
  if (state.admissionSnapshot) {
    const admissionSnapshot = state.admissionSnapshot;
    return {
      ...currentState,
      admissionSnapshot: {
        ...admissionSnapshot,
        turn:
          admissionSnapshot.turn.type === 'prompt'
            ? {
                type: 'prompt',
                messageId: admissionSnapshot.turn.messageId,
                prompt: admissionSnapshot.turn.prompt,
                attachments: admissionSnapshot.turn.attachments,
              }
            : admissionSnapshot.turn,
      },
    };
  }
  const parsedTurn = z
    .discriminatedUnion('type', [
      z
        .object({
          type: z.literal('prompt'),
          messageId: z.string(),
          prompt: z.string(),
          attachments: AttachmentsSchema.optional(),
        })
        .strict(),
      z.object({
        type: z.literal('command'),
        messageId: z.string(),
        command: z.string(),
        arguments: z.string(),
      }),
    ])
    .safeParse(state.turn);
  const constraints: LegacyAdmissionConstraints = {
    turn: parsedTurn.success
      ? parsedTurn.data.type === 'prompt'
        ? {
            type: 'prompt',
            messageId: parsedTurn.data.messageId,
            prompt: parsedTurn.data.prompt,
            attachments: parsedTurn.data.attachments,
          }
        : parsedTurn.data
      : undefined,
    agent:
      state.agent &&
      (state.agent.mode !== undefined ||
        state.agent.model !== undefined ||
        state.agent.variant !== undefined)
        ? {
            mode: state.agent.mode,
            model: state.agent.model,
            variant: state.agent.variant,
          }
        : undefined,
    finalization: state.finalization,
  };
  if (!constraints.turn && !constraints.agent && !constraints.finalization) return currentState;
  return { ...currentState, legacyAdmissionConstraints: constraints };
}

export type SessionMessageStateLookup =
  | { type: 'missing' }
  | { type: 'invalid' }
  | { type: 'found'; state: SessionMessageState };

export async function lookupSessionMessageState(
  storage: SessionMessageStorage,
  messageId: string
): Promise<SessionMessageStateLookup> {
  const raw = await storage.get<unknown>(sessionMessageStateKey(messageId));
  if (raw === undefined) return { type: 'missing' };
  const result = SessionMessageStateSchema.safeParse(raw);
  if (!result.success) {
    console.warn('Invalid session message state', {
      messageId,
      issues: result.error.issues,
    });
    return { type: 'invalid' };
  }
  if (result.data.messageId !== messageId) {
    console.warn('Mismatched session message state identity', {
      messageId,
      storedMessageId: result.data.messageId,
    });
    return { type: 'invalid' };
  }
  return { type: 'found', state: normalizeParsedSessionMessageState(result.data) };
}

export async function getSessionMessageState(
  storage: SessionMessageStorage,
  messageId: string
): Promise<SessionMessageState | undefined> {
  const lookup = await lookupSessionMessageState(storage, messageId);
  return lookup.type === 'found' ? lookup.state : undefined;
}

export async function putSessionMessageState(
  storage: SessionMessageStorage,
  state: SessionMessageState
): Promise<void> {
  const parsedState = SessionMessageStateSchema.parse(state);
  if (parsedState.wrapperRunId) {
    await storage.put(
      wrapperRunMessageIndexKey(parsedState.wrapperRunId, parsedState.messageId),
      true
    );
  }
  await storage.put(sessionMessageStateKey(parsedState.messageId), parsedState);
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
  now = Date.now(),
  dispatchAcceptanceKind: SessionMessageDispatchAcceptanceKind = 'observed'
): Promise<SessionMessageState | null> {
  const state = await getSessionMessageState(storage, messageId);
  if (!state) return null;
  if (state.status !== 'queued') return null;
  const updated: SessionMessageState = {
    ...state,
    status: 'accepted',
    acceptedAt: now,
    dispatchAcceptanceKind,
    wrapperRunId,
  };
  await putSessionMessageState(storage, updated);
  return updated;
}

export async function markAgentActivityObserved(
  storage: SessionMessageStorage,
  messageId: string,
  now = Date.now()
): Promise<SessionMessageState | null> {
  const state = await getSessionMessageState(storage, messageId);
  if (!state || state.agentActivityObservedAt !== undefined || state.acceptedAt === undefined) {
    return null;
  }
  const updated: SessionMessageState = { ...state, agentActivityObservedAt: now };
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
  failureStage?: SessionMessageFailureStage;
  failureCode?: SessionMessageFailureCode;
  failureSubtype?: WorkspaceFailureSubtype;
  safeFailureMessage?: string;
  modelNotFoundRuntimeDiagnostics?: ModelNotFoundRuntimeDiagnostics;
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
    failureStage: params.failureStage,
    failureCode: params.failureCode,
    failureSubtype: params.failureSubtype,
    safeFailureMessage: params.safeFailureMessage,
    modelNotFoundRuntimeDiagnostics: params.modelNotFoundRuntimeDiagnostics,
    attempts: params.attempts,
  };
  await putSessionMessageState(storage, updated);
  return updated;
}

export type MarkMessageInterruptedParams = {
  error?: string;
  completionSource?: SessionMessageCompletionSource;
  failureStage?: 'interruption';
  failureCode?: 'user_interrupt' | 'container_shutdown' | 'system_interrupt';
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
    failureStage: params.failureStage,
    failureCode: params.failureCode,
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
  const entries =
    wrapperRunId === undefined
      ? await listSessionMessageStates(storage)
      : await listMessagesForWrapperRun(storage, wrapperRunId);
  return entries.filter(state => state.status === 'accepted');
}

async function listIndexedMessagesForWrapperRun(
  storage: SessionMessageStorage,
  wrapperRunId: string
): Promise<SessionMessageState[]> {
  const indexPrefix = wrapperRunMessageIndexPrefix(wrapperRunId);
  const index = await storage.list<unknown>({ prefix: indexPrefix });
  const messages = await Promise.all(
    Array.from(index.keys()).map(async key => {
      const messageId = key.slice(indexPrefix.length);
      if (!messageId) return undefined;
      const state = await getSessionMessageState(storage, messageId);
      return state?.wrapperRunId === wrapperRunId ? state : undefined;
    })
  );
  return messages.filter(state => state !== undefined);
}

export async function listMessagesForWrapperRun(
  storage: SessionMessageStorage,
  wrapperRunId: string
): Promise<SessionMessageState[]> {
  if (hasCompleteWrapperRunMessageIndex(await getWrapperRuntimeState(storage), wrapperRunId)) {
    return listIndexedMessagesForWrapperRun(storage, wrapperRunId);
  }

  const entries = await listSessionMessageStates(storage);
  return entries.filter(state => state.wrapperRunId === wrapperRunId);
}

type NeverAcceptedTerminalQueuedMessageState = SessionMessageState & {
  status: 'failed' | 'interrupted';
};

export async function listReconnectVisibleTerminalQueuedMessages(
  storage: SessionMessageStorage
): Promise<NeverAcceptedTerminalQueuedMessageState[]> {
  const entries = await listSessionMessageStates(storage);
  return entries.filter(
    (state): state is NeverAcceptedTerminalQueuedMessageState =>
      state.acceptedAt === undefined &&
      state.queuedAt !== undefined &&
      (state.status === 'failed' || state.status === 'interrupted') &&
      (state.completionSource === 'delivery_failure' || state.completionSource === 'interrupt') &&
      !entries.some(
        laterState =>
          (laterState.acceptedAt !== undefined ||
            laterState.status === 'accepted' ||
            laterState.status === 'completed') &&
          (laterState.queuedAt ?? laterState.createdAt) > (state.queuedAt ?? state.createdAt)
      )
  );
}

export async function listMessagesWithPendingCallbacks(
  storage: SessionMessageStorage
): Promise<SessionMessageState[]> {
  const entries = await listSessionMessageStates(storage);
  return entries.filter(
    state =>
      isTerminalStatus(state.status) &&
      state.callbackRequired &&
      !state.callbackEnqueuedAt &&
      !state.callbackAbandonedAt
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
        state.terminalEffects ||
        !state.callbackRequired ||
        state.callbackEnqueuedAt ||
        state.callbackAbandonedAt
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
        normalized.terminalEffects.callback.disposition === 'pending' ||
        normalized.terminalEffects.push?.disposition === 'pending'
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
    return [normalizeParsedSessionMessageState(result.data)];
  });
}

export type TerminalizeEffectOptions = {
  suppressCallback?: boolean;
  suppressPush?: boolean;
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
      failureStage?: SessionMessageFailureStage;
      failureCode?: SessionMessageFailureCode;
      failureSubtype?: WorkspaceFailureSubtype;
      safeFailureMessage?: string;
      modelNotFoundRuntimeDiagnostics?: ModelNotFoundRuntimeDiagnostics;
      attempts?: number;
    }
  | {
      kind: 'interrupted';
      error?: string;
      completionSource?: SessionMessageCompletionSource;
      failureStage?: 'interruption';
      failureCode?: 'user_interrupt' | 'container_shutdown' | 'system_interrupt';
    };

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
    push: effects.suppressPush ? { disposition: 'suppressed' } : { disposition: 'pending' },
  };
  const stateForTerminal: SessionMessageState =
    state.acceptedAt !== undefined && state.dispatchAcceptanceKind === undefined
      ? { ...state, dispatchAcceptanceKind: 'inferred_from_terminal' }
      : state;
  let updated: SessionMessageState;
  if (params.kind === 'completed') {
    updated = {
      ...stateForTerminal,
      status: 'completed',
      terminalAt: now,
      assistantMessageId: params.assistantMessageId,
      completionSource: params.completionSource,
      gateResult: params.gateResult,
      terminalEffects,
    };
  } else if (params.kind === 'failed') {
    updated = {
      ...stateForTerminal,
      status: 'failed',
      terminalAt: now,
      failureReason: params.reason,
      error: params.error,
      completionSource: params.completionSource,
      failureStage: params.failureStage,
      failureCode: params.failureCode,
      failureSubtype: params.failureSubtype,
      safeFailureMessage: params.safeFailureMessage,
      modelNotFoundRuntimeDiagnostics: params.modelNotFoundRuntimeDiagnostics,
      attempts: params.attempts,
      terminalEffects,
    };
  } else {
    updated = {
      ...stateForTerminal,
      status: 'interrupted',
      terminalAt: now,
      failureReason: 'interrupted',
      error: params.error,
      completionSource: params.completionSource ?? 'interrupt',
      failureStage: params.failureStage,
      failureCode: params.failureCode,
      terminalEffects,
    };
  }

  await putSessionMessageState(storage, updated);
  return { changed: true, state: updated };
}
