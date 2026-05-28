import type { CallbackJob } from '../callbacks/types.js';
import { logger } from '../logger.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { countPendingSessionMessages, type SessionQueueStorage } from './pending-messages.js';
import {
  getSessionMessageState,
  listNonTerminalAcceptedMessages,
  listTerminalMessagesWithPendingEffects,
  putSessionMessageState,
  terminalizeMessageOnce as persistTerminalStateTransition,
  type SessionMessageState,
  type SessionMessageStorage,
  type TerminalizeParams,
} from './session-message-state.js';
import type { AssistantMessagePart, LatestAssistantMessage } from './types.js';

const CURRENT_IDLE_BATCH_CALLBACK_KEY = 'idle_batch_callback_current';
const IDLE_BATCH_CALLBACK_PREFIX = 'idle_batch_callback:';
const CALLBACK_ENQUEUE_RETRY_DELAY_MS = 30_000;

type IdleBatchCallbackState = {
  batchId: string;
  createdAt: number;
  updatedAt: number;
  representativeMessageId?: string;
  allowWithoutObservedIdle?: boolean;
  wrapperTerminalObservedAt?: number;
  wrapperTerminalWaitReleasedAt?: number;
  finalizedAt?: number;
};

type CallbackQueue = {
  send(job: CallbackJob): Promise<unknown>;
};

type PersistedMessageEvent = {
  sessionId: string;
  streamEventType: string;
  payload: string;
  timestamp: number;
  entityId: string;
};

export type MessageSettlementOutboxStorage = SessionQueueStorage & SessionMessageStorage;

export type FinalizeIdleBatchCallbackOptions = {
  allowWithoutObservedIdle?: boolean;
};

export type TerminalizeSessionMessageOptions = {
  gateResult?: 'pass' | 'fail';
  suppressCallback?: boolean;
  allowIdleBatchWithoutObservedIdle?: boolean;
};

export type MessageSettlementOutbox = {
  persistTerminalTransition(
    messageId: string,
    params: TerminalizeParams,
    opts?: TerminalizeSessionMessageOptions
  ): Promise<{ changed: boolean; state: SessionMessageState | null }>;
  repairTerminalMessageEffects(messageId: string): Promise<void>;
  terminalizeSessionMessageOnce(
    messageId: string,
    params: TerminalizeParams,
    opts?: TerminalizeSessionMessageOptions
  ): Promise<{ changed: boolean; state: SessionMessageState | null }>;
  observeWrapperTerminalForIdleBatch(gateResult?: 'pass' | 'fail'): Promise<void>;
  releaseWrapperTerminalWaitForIdleBatch(): Promise<void>;
  releaseWrapperTerminalWaitForIdleBatchForWrapperRun(wrapperRunId: string): Promise<boolean>;
  isWaitingForWrapperTerminalGateResult(): Promise<boolean>;
  finalizeIdleBatchCallbackIfReady(options?: FinalizeIdleBatchCallbackOptions): Promise<void>;
  repairTerminalEffects(): Promise<boolean>;
  retryPendingCallbacks(now: number): Promise<void>;
  nextCallbackDeadline(): Promise<number | undefined>;
};

export type MessageSettlementOutboxDependencies = {
  storage: MessageSettlementOutboxStorage;
  getMetadata: () => Promise<SessionMetadata | null>;
  requireSessionId: () => Promise<string>;
  resolveCallbackSessionId: (metadata: SessionMetadata | null) => Promise<string>;
  getCallbackQueue: () => CallbackQueue | undefined;
  getAssistantMessageForUserMessage: (
    sessionId: string,
    kiloSessionId: string,
    parentMessageId: string
  ) => LatestAssistantMessage | null;
  ensureTerminalMessageEvent: (event: PersistedMessageEvent) => void;
  hasObservedWrapperIdle: () => Promise<boolean>;
  requestAlarmAtOrBefore: (deadline: number) => Promise<void>;
  getSessionIdForLogs: () => string | undefined;
};

function extractAssistantTextFromParts(parts: AssistantMessagePart[]): string {
  const pieces: string[] = [];
  for (const part of parts) {
    if (part.type !== 'text') continue;
    const text = part.text;
    if (typeof text === 'string' && text.length > 0) {
      pieces.push(text);
    }
  }
  return pieces.join('').trim();
}

function redactCallbackTargetUrl(callbackUrl: string): string {
  try {
    const url = new URL(callbackUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

function idleBatchCallbackKey(batchId: string): string {
  return `${IDLE_BATCH_CALLBACK_PREFIX}${batchId}`;
}

export function createMessageSettlementOutbox(
  dependencies: MessageSettlementOutboxDependencies
): MessageSettlementOutbox {
  const {
    storage,
    getMetadata,
    requireSessionId,
    resolveCallbackSessionId,
    getCallbackQueue,
    getAssistantMessageForUserMessage,
    ensureTerminalMessageEvent,
    hasObservedWrapperIdle,
    requestAlarmAtOrBefore,
    getSessionIdForLogs,
  } = dependencies;

  async function getCurrentIdleBatchCallbackState(): Promise<IdleBatchCallbackState | null> {
    const batchId = await storage.get<string>(CURRENT_IDLE_BATCH_CALLBACK_KEY);
    if (!batchId) return null;

    const state = await storage.get<IdleBatchCallbackState>(idleBatchCallbackKey(batchId));
    if (!state || state.finalizedAt !== undefined) {
      await storage.delete(CURRENT_IDLE_BATCH_CALLBACK_KEY);
      return null;
    }
    return state;
  }

  async function openIdleBatchCallbackState(
    seedMessageId: string
  ): Promise<IdleBatchCallbackState> {
    const current = await getCurrentIdleBatchCallbackState();
    if (current) {
      return current;
    }

    const now = Date.now();
    const state: IdleBatchCallbackState = {
      batchId: `${now}:${seedMessageId}`,
      createdAt: now,
      updatedAt: now,
    };
    await storage.put(idleBatchCallbackKey(state.batchId), state);
    await storage.put(CURRENT_IDLE_BATCH_CALLBACK_KEY, state.batchId);
    logger
      .withFields({ sessionId: getSessionIdForLogs(), batchId: state.batchId, seedMessageId })
      .info('Opened idle-batch callback state');
    return state;
  }

  async function recordIdleBatchCallbackCandidate(
    state: SessionMessageState,
    allowWithoutObservedIdle = false
  ): Promise<void> {
    if (!state.callbackRequired) return;

    const batch = await openIdleBatchCallbackState(state.messageId);
    const currentRepresentative = batch.representativeMessageId
      ? await getSessionMessageState(storage, batch.representativeMessageId)
      : undefined;
    const candidateTime = state.terminalAt ?? state.createdAt;
    const currentTime = currentRepresentative
      ? (currentRepresentative.terminalAt ?? currentRepresentative.createdAt)
      : -1;
    const representativeMessageId =
      candidateTime >= currentTime ? state.messageId : batch.representativeMessageId;
    const updated: IdleBatchCallbackState = {
      ...batch,
      representativeMessageId,
      allowWithoutObservedIdle: batch.allowWithoutObservedIdle || allowWithoutObservedIdle,
      updatedAt: Date.now(),
    };
    await storage.put(idleBatchCallbackKey(updated.batchId), updated);
    logger
      .withFields({
        sessionId: getSessionIdForLogs(),
        batchId: updated.batchId,
        representativeMessageId: updated.representativeMessageId,
      })
      .info('Recorded idle-batch callback representative message');
  }

  async function observeWrapperTerminalForIdleBatch(gateResult?: 'pass' | 'fail'): Promise<void> {
    const batch = await getCurrentIdleBatchCallbackState();
    if (!batch) return;

    const now = Date.now();
    const representativeMessageId = batch.representativeMessageId;
    if (representativeMessageId && gateResult !== undefined) {
      const representative = await getSessionMessageState(storage, representativeMessageId);
      if (representative?.callbackRequired && !representative.callbackEnqueuedAt) {
        await putSessionMessageState(storage, { ...representative, gateResult });
      }
    }

    await storage.put(idleBatchCallbackKey(batch.batchId), {
      ...batch,
      wrapperTerminalObservedAt: now,
      updatedAt: now,
    } satisfies IdleBatchCallbackState);
  }

  async function releaseWrapperTerminalWaitForIdleBatch(): Promise<void> {
    const batch = await getCurrentIdleBatchCallbackState();
    if (!batch) return;

    await releaseWrapperTerminalWaitForIdleBatchState(batch);
  }

  async function releaseWrapperTerminalWaitForIdleBatchState(
    batch: IdleBatchCallbackState
  ): Promise<void> {
    const now = Date.now();
    await storage.put(idleBatchCallbackKey(batch.batchId), {
      ...batch,
      wrapperTerminalWaitReleasedAt: now,
      updatedAt: now,
    } satisfies IdleBatchCallbackState);
  }

  async function releaseWrapperTerminalWaitForIdleBatchForWrapperRun(
    wrapperRunId: string
  ): Promise<boolean> {
    const batch = await getCurrentIdleBatchCallbackState();
    if (!batch?.representativeMessageId) return false;

    const representative = await getSessionMessageState(storage, batch.representativeMessageId);
    if (representative?.wrapperRunId !== wrapperRunId) return false;

    await releaseWrapperTerminalWaitForIdleBatchState(batch);
    return true;
  }

  async function isWaitingForWrapperTerminalGateResult(): Promise<boolean> {
    const batch = await getCurrentIdleBatchCallbackState();
    return batch ? shouldWaitForWrapperGateResult(batch) : false;
  }

  async function emitSessionMessageCompleted(
    state: SessionMessageState,
    extra?: { gateResult?: 'pass' | 'fail' }
  ): Promise<void> {
    const sessionId = await requireSessionId();
    const payload: Record<string, unknown> = {
      messageId: state.messageId,
      status: 'completed',
      delivery: 'sent',
      accepted: true,
      completionSource: state.completionSource,
    };
    if (state.assistantMessageId) {
      payload.assistantMessageId = state.assistantMessageId;
    }
    if (extra?.gateResult !== undefined) {
      payload.gateResult = extra.gateResult;
    }
    ensureTerminalMessageEvent({
      entityId: `terminal-message/${state.messageId}`,
      sessionId,
      streamEventType: 'cloud.message.completed',
      payload: JSON.stringify(payload),
      timestamp: Date.now(),
    });
  }

  async function emitSessionMessageFailed(
    state: SessionMessageState,
    extra?: { error?: string }
  ): Promise<void> {
    const sessionId = await requireSessionId();
    const wasAccepted = state.status === 'accepted' || state.acceptedAt !== undefined;
    const payload: Record<string, unknown> = {
      messageId: state.messageId,
      status: state.status,
      delivery: wasAccepted ? 'sent' : 'queued',
      accepted: wasAccepted,
      completionSource: state.completionSource,
      reason: state.failureReason,
    };
    if (state.attempts !== undefined) {
      payload.attempts = state.attempts;
    }
    if (extra?.error !== undefined) {
      payload.error = extra.error;
    } else if (state.error) {
      payload.error = state.error;
    }
    ensureTerminalMessageEvent({
      entityId: `terminal-message/${state.messageId}`,
      sessionId,
      streamEventType: 'cloud.message.failed',
      payload: JSON.stringify(payload),
      timestamp: Date.now(),
    });
  }

  async function enqueueMessageCallbackNotification(state: SessionMessageState): Promise<void> {
    const { status } = state;
    if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') {
      return;
    }

    const metadata = await getMetadata();
    const callbackQueue = getCallbackQueue();

    if (!state.callbackTarget || !callbackQueue) {
      if (state.callbackRequired) {
        const retryAt = Date.now() + CALLBACK_ENQUEUE_RETRY_DELAY_MS;
        const error = !state.callbackTarget
          ? 'Missing callback target'
          : 'Callback queue not available';
        state.callbackLastError = error;
        state.callbackAttempts = (state.callbackAttempts ?? 0) + 1;
        state.callbackRetryAt = retryAt;
        await putSessionMessageState(storage, state);
        logger
          .withFields({
            sessionId: metadata?.identity.sessionId ?? '',
            messageId: state.messageId,
            error,
          })
          .error('Cannot enqueue message callback job');
        await requestAlarmAtOrBefore(retryAt);
      }
      return;
    }

    logger.info('Message callback enqueue requested', {
      cloudAgentSessionId: metadata?.identity.sessionId,
      messageId: state.messageId,
      status,
      callbackTarget: redactCallbackTargetUrl(state.callbackTarget.url),
    });

    const sessionId = await resolveCallbackSessionId(metadata);

    let lastAssistantMessageText: string | undefined;
    if (state.status === 'completed' && metadata?.auth.kiloSessionId) {
      const assistantMessage = getAssistantMessageForUserMessage(
        sessionId,
        metadata.auth.kiloSessionId,
        state.messageId
      );
      if (assistantMessage) {
        lastAssistantMessageText = extractAssistantTextFromParts(assistantMessage.parts);
      }
    }

    const payload: CallbackJob['payload'] = {
      sessionId,
      cloudAgentSessionId: sessionId,
      executionId: state.messageId,
      messageId: state.messageId,
      status,
      errorMessage: state.error,
      lastSeenBranch: metadata?.repository?.upstreamBranch,
      kiloSessionId: metadata?.auth.kiloSessionId,
      gateResult: state.gateResult,
      lastAssistantMessageText,
      idempotencyKey: state.messageId,
    };

    const callbackJob: CallbackJob = {
      target: state.callbackTarget,
      payload,
    };

    try {
      await callbackQueue.send(callbackJob);
      state.callbackEnqueuedAt = Date.now();
      await putSessionMessageState(storage, state);
      logger
        .withFields({
          sessionId,
          messageId: state.messageId,
          status,
          callbackTarget: redactCallbackTargetUrl(state.callbackTarget.url),
        })
        .info('Message callback job enqueued');
    } catch (err) {
      const retryAt = Date.now() + CALLBACK_ENQUEUE_RETRY_DELAY_MS;
      state.callbackLastError = err instanceof Error ? err.message : String(err);
      state.callbackAttempts = (state.callbackAttempts ?? 0) + 1;
      state.callbackRetryAt = retryAt;
      await putSessionMessageState(storage, state);
      logger
        .withFields({
          sessionId,
          messageId: state.messageId,
          error: state.callbackLastError,
        })
        .error('Failed to enqueue message callback job');
      await requestAlarmAtOrBefore(retryAt);
    }
  }

  async function shouldWaitForWrapperGateResult(batch: IdleBatchCallbackState): Promise<boolean> {
    if (
      batch.wrapperTerminalObservedAt !== undefined ||
      batch.wrapperTerminalWaitReleasedAt !== undefined ||
      !batch.representativeMessageId
    ) {
      return false;
    }

    const representative = await getSessionMessageState(storage, batch.representativeMessageId);
    if (representative?.status !== 'completed' || representative.gateResult !== undefined) {
      return false;
    }

    const gateThreshold = (await getMetadata())?.finalization?.gateThreshold;
    return gateThreshold !== undefined && gateThreshold !== 'off';
  }

  async function finalizeIdleBatchCallbackIfReady(
    options?: FinalizeIdleBatchCallbackOptions
  ): Promise<void> {
    const batch = await getCurrentIdleBatchCallbackState();
    if (!batch) return;

    const pendingCount = await countPendingSessionMessages(storage);
    if (pendingCount > 0) return;

    const acceptedMessages = await listNonTerminalAcceptedMessages(storage);
    if (acceptedMessages.length > 0) return;

    if (!options?.allowWithoutObservedIdle && !(await hasObservedWrapperIdle())) {
      return;
    }

    if (await shouldWaitForWrapperGateResult(batch)) {
      return;
    }

    const finalized: IdleBatchCallbackState = {
      ...batch,
      finalizedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await storage.put(idleBatchCallbackKey(finalized.batchId), finalized);
    await storage.delete(CURRENT_IDLE_BATCH_CALLBACK_KEY);
    logger
      .withFields({
        sessionId: getSessionIdForLogs(),
        batchId: finalized.batchId,
        representativeMessageId: finalized.representativeMessageId,
        allowWithoutObservedIdle: options?.allowWithoutObservedIdle ?? false,
      })
      .info('Finalized idle-batch callback state');

    if (!finalized.representativeMessageId) return;
    const representative = await getSessionMessageState(storage, finalized.representativeMessageId);
    if (!representative?.callbackRequired || representative.callbackEnqueuedAt) return;
    await enqueueMessageCallbackNotification(representative);
  }

  async function listPendingIdleBatchCallbacks(): Promise<SessionMessageState[]> {
    const batches = await storage.list<IdleBatchCallbackState>({
      prefix: IDLE_BATCH_CALLBACK_PREFIX,
    });
    const states: SessionMessageState[] = [];
    for (const batch of batches.values()) {
      if (batch.finalizedAt === undefined || !batch.representativeMessageId) continue;
      const state = await getSessionMessageState(storage, batch.representativeMessageId);
      if (!state?.callbackRequired || state.callbackEnqueuedAt) continue;
      states.push(state);
    }
    return states;
  }

  async function applyTerminalEffects(state: SessionMessageState): Promise<void> {
    if (state.terminalEffects?.event !== 'accounted') {
      if (state.status === 'completed') {
        await emitSessionMessageCompleted(state, { gateResult: state.gateResult });
      } else if (state.status === 'failed' || state.status === 'interrupted') {
        await emitSessionMessageFailed(state, { error: state.error });
      }
      await putSessionMessageState(storage, {
        ...state,
        terminalEffects: {
          event: 'accounted',
          callback:
            state.terminalEffects?.callback ??
            (state.callbackRequired
              ? {
                  disposition: 'pending',
                  allowWithoutObservedIdle:
                    state.completionSource === 'interrupt' ||
                    state.completionSource === 'delivery_failure',
                }
              : { disposition: 'not-required' }),
        },
      });
      state = (await getSessionMessageState(storage, state.messageId)) ?? state;
    }

    if (state.terminalEffects?.callback.disposition === 'pending') {
      await recordIdleBatchCallbackCandidate(
        state,
        state.terminalEffects.callback.allowWithoutObservedIdle
      );
      await putSessionMessageState(storage, {
        ...state,
        terminalEffects: {
          event: 'accounted',
          callback: {
            ...state.terminalEffects.callback,
            disposition: 'accounted',
          },
        },
      });
    }
  }

  async function repairTerminalEffects(): Promise<boolean> {
    const terminalStates = await listTerminalMessagesWithPendingEffects(storage);
    try {
      for (const state of terminalStates) {
        await applyTerminalEffects(state);
      }
      const batch = await getCurrentIdleBatchCallbackState();
      if (batch) {
        await finalizeIdleBatchCallbackIfReady({
          allowWithoutObservedIdle: batch.allowWithoutObservedIdle,
        });
      }
    } catch (error) {
      await requestAlarmAtOrBefore(Date.now() + 1_000);
      throw error;
    }
    return terminalStates.length > 0;
  }

  async function persistTerminalTransition(
    messageId: string,
    params: TerminalizeParams,
    opts?: TerminalizeSessionMessageOptions
  ): Promise<{ changed: boolean; state: SessionMessageState | null }> {
    return persistTerminalStateTransition(storage, messageId, params, {
      suppressCallback: opts?.suppressCallback,
      allowIdleBatchWithoutObservedIdle: opts?.allowIdleBatchWithoutObservedIdle,
    });
  }

  async function repairTerminalMessageEffects(messageId: string): Promise<void> {
    const state = await getSessionMessageState(storage, messageId);
    if (!state) return;
    await applyTerminalEffects(state);
  }

  async function terminalizeSessionMessageOnce(
    messageId: string,
    params: TerminalizeParams,
    opts?: TerminalizeSessionMessageOptions
  ): Promise<{ changed: boolean; state: SessionMessageState | null }> {
    const result = await persistTerminalTransition(messageId, params, opts);
    if (!result.state) return result;

    const { state } = result;
    logger
      .withFields({
        sessionId: getSessionIdForLogs(),
        messageId,
        finalStatus: state.status,
        completionSource: state.completionSource,
        callbackRequired: state.callbackRequired,
        suppressCallback: opts?.suppressCallback ?? false,
        hasAssistantMessageId: state.assistantMessageId !== undefined,
      })
      .info('Session message terminalized');

    try {
      await applyTerminalEffects(state);

      if (!opts?.suppressCallback) {
        await finalizeIdleBatchCallbackIfReady({
          allowWithoutObservedIdle: opts?.allowIdleBatchWithoutObservedIdle,
        });
      }
    } catch (error) {
      await requestAlarmAtOrBefore(Date.now() + 1_000);
      throw error;
    }

    return result;
  }

  async function retryPendingCallbacks(now: number): Promise<void> {
    const pendingCallbacks = await listPendingIdleBatchCallbacks();
    for (const state of pendingCallbacks) {
      if (state.callbackRetryAt !== undefined && state.callbackRetryAt > now) continue;
      await enqueueMessageCallbackNotification(state);
    }
  }

  async function nextCallbackDeadline(): Promise<number | undefined> {
    const pendingCallbacks = await listPendingIdleBatchCallbacks();
    return pendingCallbacks
      .map(state => state.callbackRetryAt)
      .filter((retryAt): retryAt is number => retryAt !== undefined)
      .sort((left, right) => left - right)[0];
  }

  return {
    persistTerminalTransition,
    repairTerminalMessageEffects,
    terminalizeSessionMessageOnce,
    observeWrapperTerminalForIdleBatch,
    releaseWrapperTerminalWaitForIdleBatch,
    releaseWrapperTerminalWaitForIdleBatchForWrapperRun,
    isWaitingForWrapperTerminalGateResult,
    finalizeIdleBatchCallbackIfReady,
    repairTerminalEffects,
    retryPendingCallbacks,
    nextCallbackDeadline,
  };
}
