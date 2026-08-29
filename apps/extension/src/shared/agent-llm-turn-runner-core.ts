/* eslint-disable max-lines, max-classes-per-file, promise/avoid-new, promise/no-multiple-resolved -- The turn loop uses distinct typed failures and a cancellable retry delay. */
import {
  createAssistantMessage,
  createThinkingBlock,
  createUserMessage,
} from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import {
  ExecutionStoppedError,
  isExecutionStopped,
  normalizeExecutionGuard,
  runToolCalls,
} from './agent-tool-results';
import type { ExecutionGuard, ToolResultEvent } from './agent-tool-results';
import { normalizeEvalTabResult } from './tab-debugger';
import type { EvalTabResult, NormalizedEvalTabResult } from './tab-debugger';
import type { FetchLike } from './auth';
import { buildGatewayMessagesFromEvents } from './agent-llm-harness';
import type { KiloGatewayToolCallRequest, KiloGatewayToolDefinition } from './kilo-api-client';
import {
  fetchKiloGatewayChatCompletionStream,
  KiloGatewayHttpError,
  KiloGatewayStreamStalledError,
  KiloGatewayUnsupportedToolError,
} from './kilo-api-client';

export type LlmTurnFailureReason =
  | 'model_failure'
  | 'retry_exhausted'
  | 'context_overflow'
  | 'rounds_exhausted'
  | 'truncated_response'
  | 'empty_response'
  | 'incomplete_response'
  | 'tool_failure_limit'
  | 'unsafe_tool_call';

type TurnTermination =
  | { readonly status: 'succeeded'; readonly reason: 'completed' }
  | { readonly status: 'failed'; readonly reason: LlmTurnFailureReason }
  | { readonly status: 'cancelled' | 'interrupted'; readonly reason: string };

export type LlmTurnOutcome = TurnTermination & {
  readonly summary: string;
  /** Only settled, confirmed results from this turn; never inferred evidence. */
  readonly toolResults: ToolResultEvent[];
  readonly effectsUncertain: boolean;
};

class ToolFailureLimitError extends Error {}

type ToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;

export interface TurnUsage {
  readonly costUsd?: number;
  readonly promptTokens: number;
}

export type OnTurnUsage = (usage: TurnUsage) => void;

interface RunLlmTurnOptions<ToolCall extends ToolCallEvent> {
  readonly apiBaseUrl: string;
  readonly appendEvents: (events: AgentConversationEvent[]) => void;
  readonly conversationEvents: AgentConversationEvent[];
  readonly executeToolCall: (toolCall: ToolCall) => Promise<EvalTabResult>;
  readonly executionGuard?: ExecutionGuard | undefined;
  readonly failureMessage: (error: unknown) => string;
  readonly fetch: FetchLike;
  readonly maxToolRounds: number;
  readonly model: string;
  readonly noResponseMessage: string;
  readonly onUsage?: OnTurnUsage | undefined;
  readonly organizationId?: string | undefined;
  readonly prepareTools?: (() => Promise<KiloGatewayToolDefinition[]>) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly supportsImages?: boolean | undefined;
  readonly thinkingEffort?: string | undefined;
  readonly token: string;
  readonly tools: KiloGatewayToolDefinition[];
  readonly tooManyToolRoundsMessage: string;
  readonly toToolCallEvents: (toolCalls: KiloGatewayToolCallRequest[]) => ToolCall[];
  readonly updateAssistantMessage: (eventId: string, text: string) => void;
  readonly updateThinkingBlock: (eventId: string, text: string) => void;
  /** Fires with the assistant event id on first content delta; fires undefined when that stream ends. */
  readonly onAssistantStreaming?: ((eventId: string | undefined) => void) | undefined;
}

// Attach the turn's reasoning blocks to the first tool call so the harness can replay them on the assistant tool-call message (providers may require signed/encrypted reasoning for a continuation).
const withReasoningDetails = <ToolCall extends ToolCallEvent>(
  toolCallEvents: ToolCall[],
  reasoningDetails: readonly unknown[] | undefined
): ToolCall[] => {
  const [first, ...rest] = toolCallEvents;

  if (first === undefined || reasoningDetails === undefined || reasoningDetails.length === 0) {
    return toolCallEvents;
  }

  return [{ ...first, reasoningDetails }, ...rest];
};

const isHighEffort = (thinkingEffort: string | undefined): boolean =>
  thinkingEffort === 'high' || thinkingEffort === 'xhigh' || thinkingEffort === 'max';

// One transparent retry tier for failures the user cannot act on: a stalled stream, a transient network failure, or a retriable gateway status.
const MAX_STREAM_ATTEMPTS = 3;
const STREAM_RETRY_DELAYS_MS = [1000, 4000];

const isRetriableStreamError = (error: unknown): boolean => {
  if (error instanceof KiloGatewayStreamStalledError || error instanceof TruncatedCompletionError) {
    return true;
  }
  if (error instanceof KiloGatewayHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  // Fetch network failures surface as TypeError ("Failed to fetch").
  return error instanceof TypeError;
};

// Mirrors the gateway's own error-class finish reasons. A completion cut short mid-thought (no tool calls to act on) is a provider fault the user cannot fix, so the turn retries it transparently.
// 'model_context_window_exceeded' is deliberately absent: a prompt that overflowed the context cannot fit on a retry of the same messages, so the turn keeps the partial completion instead of burning identical billed attempts.
const TRUNCATED_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'content_filter',
  'content-filter',
  'error',
  'network_error',
  'failed',
  'engine_overloaded',
  'incomplete',
]);

class TruncatedCompletionError extends Error {
  constructor(finishReason: string) {
    super(`The model response was cut short (finish reason: ${finishReason}).`);
    this.name = 'TruncatedCompletionError';
  }
}

// Some models announce an action ("Creating the workflow…") and then stop, expecting to be re-invoked. A user would type "continue"; the harness sends that once, invisibly, when a tool-using turn ends on a short, question-free announcement of work. The nudge message is never persisted.
const CONTINUE_NUDGE_TEXT =
  'Continue: finish the request now, in this turn. If everything is already done, state the final result.';
const CONTINUE_NUDGE_MAX_TEXT_LENGTH = 300;
// First-person intent or a progressive verb: the model said what it is about to do rather than what it did.
const ANNOUNCEMENT_RE =
  /\b(?:i'?ll|i will|i'?m \w+ing|i am \w+ing|i am going to|let me|now i|next i)\b|^\s*\w+(?<!th)ing\b[^.!?]*\b(?:workflow|script|search|page|result)/iu;

// A real question to the user ends the message with "?"; a mid-text "?" is usually a URL query string (…/search?q=) or code, not a question, so only a trailing "?" suppresses the nudge.
const endsWithQuestion = (text: string): boolean => text.trimEnd().endsWith('?');

const deservesContinueNudge = (lastAssistantText: string): boolean =>
  lastAssistantText.length > 0 &&
  lastAssistantText.length < CONTINUE_NUDGE_MAX_TEXT_LENGTH &&
  !endsWithQuestion(lastAssistantText) &&
  ANNOUNCEMENT_RE.test(lastAssistantText);

// A turn that ends with thinking but no assistant text and no tool calls never answered the user; the model spent its completion reasoning and stopped. The finish reason is healthy, so the retry tier never sees it — the nudge does.
const endedThinkingOnly = (
  completionEvents: readonly AgentConversationEvent[],
  lastAssistantText: string
): boolean => lastAssistantText.length === 0 && completionEvents.length > 0;

// eslint-disable-next-line promise/avoid-new -- A cancellable timer has no promise-returning primitive to defer to.
const abortableDelay = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });

export const runLlmTurn = async <ToolCall extends ToolCallEvent>({
  apiBaseUrl,
  appendEvents,
  conversationEvents,
  executeToolCall,
  executionGuard,
  failureMessage,
  fetch,
  maxToolRounds,
  model,
  noResponseMessage,
  onUsage,
  organizationId,
  prepareTools,
  signal,
  supportsImages = false,
  thinkingEffort,
  token,
  tools,
  tooManyToolRoundsMessage,
  toToolCallEvents,
  updateAssistantMessage,
  updateThinkingBlock,
  onAssistantStreaming,
}: RunLlmTurnOptions<ToolCall>): Promise<LlmTurnOutcome> => {
  const guard = normalizeExecutionGuard(executionGuard, signal);
  const confirmedToolResults: ToolResultEvent[] = [];
  let lastAssistantSummary = '';
  let effectsUncertain = false;
  let issuedActionPending = false;
  let streamRetriesExhausted = false;
  const outcome = (
    termination: TurnTermination,
    summary = lastAssistantSummary
  ): LlmTurnOutcome => ({
    ...termination,
    effectsUncertain,
    summary,
    toolResults: [...confirmedToolResults],
  });
  // A weak model can loop one byte-identical failing tool call for the whole turn (measured: 118 identical run_workflow calls). After the third identical failure the error tells it to stop; a success resets the count.
  const identicalFailureCounts = new Map<string, number>();
  // Count total failures per tool, even across changed arguments and interleaved successes.
  const MAX_TOOL_FAILURES_PER_TURN = 25;
  const failureTotals = new Map<string, number>();
  let streakStopMessage: string | undefined = undefined;
  const guardedExecuteToolCall = async (toolCall: ToolCall): Promise<NormalizedEvalTabResult> => {
    guard();
    // Key on the call content, not its per-call ids or attached reasoning: repeats must collide.
    const {
      id: _id,
      providerToolCallId: _provider,
      reasoningDetails: _reasoning,
      ...callContent
    } = toolCall as ToolCallEvent & {
      readonly providerToolCallId?: string;
      readonly reasoningDetails?: readonly unknown[];
    };
    const key = JSON.stringify(callContent);
    issuedActionPending = true;
    const result = normalizeEvalTabResult(await executeToolCall(toolCall));
    issuedActionPending = false;
    if (result.effectsUncertain) {
      return result;
    }
    if (result.ok) {
      identicalFailureCounts.delete(key);
      return result;
    }
    const totalFailures = (failureTotals.get(toolCall.name) ?? 0) + 1;
    failureTotals.set(toolCall.name, totalFailures);
    if (totalFailures >= MAX_TOOL_FAILURES_PER_TURN) {
      streakStopMessage = `Stopped: ${toolCall.name} failed ${String(totalFailures)} times this turn. Something is blocking this approach — please adjust the request or try again.`;
    }
    const count = (identicalFailureCounts.get(key) ?? 0) + 1;
    identicalFailureCounts.set(key, count);
    if (count < 3) {
      return result;
    }
    return {
      ...result,
      error: `${result.error} — You have sent this exact ${toolCall.name} call ${count} times and it keeps failing. Do not send it again. Change the arguments or take a different approach.`,
    };
  };
  const getGatewayChatCompletion = async (
    nextEvents: AgentConversationEvent[],
    onContentDelta: (delta: string) => void,
    onReasoningDelta: (delta: string) => void
  ) => {
    guard();
    const requestTools = prepareTools === undefined ? tools : await prepareTools();
    guard();

    return fetchKiloGatewayChatCompletionStream({
      apiBaseUrl,
      // A high-effort model legitimately streams for minutes; anything else past two minutes is a pathological trickle worth cutting and retrying.
      completionTimeoutMs: isHighEffort(thinkingEffort) ? 300_000 : 120_000,
      fetch,
      messages: buildGatewayMessagesFromEvents(nextEvents, { supportsImages }),
      model,
      onContentDelta,
      onReasoningDelta,
      organizationId,
      signal,
      thinkingEffort,
      token,
      tools: requestTools,
    });
  };

  const appendCompletion = async (
    nextEvents: AgentConversationEvent[]
  ): Promise<{
    completionEvents: AgentConversationEvent[];
    discardedToolCalls: boolean;
    finishReason: string | undefined;
    toolCallEvents: ToolCall[];
  }> => {
    const completionEvents: AgentConversationEvent[] = [];
    let streamedText = '';
    let streamedAssistantEventId: string | undefined = undefined;
    let streamedThinkingText = '';
    let streamedThinkingEventId: string | undefined = undefined;
    let didStartAssistantStreaming = false;
    // A retry replaces the streamed text only when its own first delta arrives; a retry that fails outright leaves the previous text in place instead of a permanently empty bubble.
    let resetStreamedTextOnNextDelta = false;
    let resetThinkingTextOnNextDelta = false;

    try {
      const streamOnce = (): Promise<Awaited<ReturnType<typeof getGatewayChatCompletion>>> =>
        getGatewayChatCompletion(
          nextEvents,
          delta => {
            if (resetStreamedTextOnNextDelta) {
              resetStreamedTextOnNextDelta = false;
              streamedText = '';
            }
            streamedText += delta;

            if (streamedAssistantEventId === undefined) {
              const assistantEvent = createAssistantMessage(streamedText);

              streamedAssistantEventId = assistantEvent.id;
              didStartAssistantStreaming = true;
              onAssistantStreaming?.(assistantEvent.id);
              completionEvents.push(assistantEvent);
              appendEvents([assistantEvent]);
              return;
            }

            updateAssistantMessage(streamedAssistantEventId, streamedText);
          },
          delta => {
            if (resetThinkingTextOnNextDelta) {
              resetThinkingTextOnNextDelta = false;
              streamedThinkingText = '';
            }
            streamedThinkingText += delta;

            if (streamedThinkingEventId === undefined) {
              const thinkingEvent = createThinkingBlock(streamedThinkingText);

              streamedThinkingEventId = thinkingEvent.id;
              completionEvents.push(thinkingEvent);
              appendEvents([thinkingEvent]);
              return;
            }

            updateThinkingBlock(streamedThinkingEventId, streamedThinkingText);
          }
        );

      // Retry keeps the already-created streamed events and re-streams into them: text resets to empty, ids stay stable, so the UI never shows a duplicated or half-doubled message.
      let lastTruncatedCompletion:
        | Awaited<ReturnType<typeof getGatewayChatCompletion>>
        | undefined = undefined;
      const streamWithRetries = async (
        streamAttempt: number
      ): Promise<Awaited<ReturnType<typeof getGatewayChatCompletion>>> => {
        try {
          const completion = await streamOnce();
          // A healthy stream always reports a finish_reason; a stream that ends without one died mid-flight. Either way, with no tool calls there is nothing to act on, so the attempt retries.
          if (
            completion.toolCalls.length === 0 &&
            (completion.finishReason === undefined ||
              TRUNCATED_FINISH_REASONS.has(completion.finishReason))
          ) {
            lastTruncatedCompletion = completion;
            throw new TruncatedCompletionError(completion.finishReason ?? 'missing');
          }
          return completion;
        } catch (error) {
          // Preserve producer uncertainty even when the owner revokes authority at the same time.
          if (error instanceof ExecutionStoppedError) {
            throw error;
          }
          guard();
          if (isExecutionStopped(error)) {
            throw error;
          }
          if (streamAttempt >= MAX_STREAM_ATTEMPTS || !isRetriableStreamError(error)) {
            streamRetriesExhausted = isRetriableStreamError(error);
            // When every attempt came back truncated, degrade to the last partial text rather than replacing it with a failure message.
            if (
              error instanceof TruncatedCompletionError &&
              lastTruncatedCompletion !== undefined
            ) {
              return lastTruncatedCompletion;
            }
            throw error;
          }
          resetStreamedTextOnNextDelta = true;
          resetThinkingTextOnNextDelta = true;
          await abortableDelay(STREAM_RETRY_DELAYS_MS[streamAttempt - 1] ?? 4000, signal);
          guard();
          return streamWithRetries(streamAttempt + 1);
        }
      };
      const completion = await streamWithRetries(1);

      if (completion.usage !== undefined) {
        onUsage?.(completion.usage);
      }

      // An unfinished tool batch is terminal; do not retry it or expose unmatched calls in history.
      if (completion.toolCalls.length > 0 && completion.finishReason === undefined) {
        throw new TruncatedCompletionError('missing');
      }

      if (streamedThinkingEventId !== undefined) {
        const finalStreamedThinkingText = completion.reasoning ?? streamedThinkingText;
        const streamedThinkingEventIndex = completionEvents.findIndex(
          event => event.id === streamedThinkingEventId
        );

        if (streamedThinkingEventIndex !== -1) {
          completionEvents.splice(streamedThinkingEventIndex, 1, {
            id: streamedThinkingEventId,
            text: finalStreamedThinkingText,
            type: 'thinking',
          });
        }
      }

      if (streamedAssistantEventId !== undefined) {
        const finalStreamedText =
          completion.content ?? (resetStreamedTextOnNextDelta ? '' : streamedText);
        const streamedAssistantEventIndex = completionEvents.findIndex(
          event => event.id === streamedAssistantEventId
        );

        if (streamedAssistantEventIndex !== -1) {
          completionEvents.splice(streamedAssistantEventIndex, 1, {
            id: streamedAssistantEventId,
            role: 'assistant',
            text: finalStreamedText,
            type: 'message',
          });
        }
      }

      // Non-streamed completion.content path: no onAssistantStreaming start/end.
      if (completion.content !== undefined && streamedAssistantEventId === undefined) {
        completionEvents.push(createAssistantMessage(completion.content));
      }

      if (completion.reasoning !== undefined && streamedThinkingEventId === undefined) {
        completionEvents.push(createThinkingBlock(completion.reasoning));
      }

      const convertedToolCalls = toToolCallEvents(completion.toolCalls);
      const discardedToolCalls = convertedToolCalls.length !== completion.toolCalls.length;
      // A partially accepted response must not execute its remaining calls or leave unmatched calls in history.
      const toolCallEvents =
        discardedToolCalls ||
        TRUNCATED_FINISH_REASONS.has(completion.finishReason ?? '') ||
        completion.finishReason === 'model_context_window_exceeded'
          ? []
          : withReasoningDetails(convertedToolCalls, completion.reasoningDetails);
      completionEvents.push(...toolCallEvents);

      appendEvents(
        completionEvents.filter(
          event => event.id !== streamedAssistantEventId && event.id !== streamedThinkingEventId
        )
      );

      return {
        completionEvents,
        discardedToolCalls,
        finishReason: completion.finishReason,
        toolCallEvents,
      };
    } finally {
      if (didStartAssistantStreaming) {
        // Explicit clear: callers key collapse chrome off this id being undefined.
        const cleared: string | undefined = undefined;
        onAssistantStreaming?.(cleared);
      }
    }
  };

  try {
    let turnUsedTools = false;
    let continueNudgeSent = false;
    const continueConversation = async (
      nextConversationEvents: AgentConversationEvent[],
      remainingRounds: number
    ): Promise<LlmTurnOutcome> => {
      guard();
      if (remainingRounds <= 0) {
        appendEvents([createAssistantMessage(tooManyToolRoundsMessage)]);
        return outcome({ reason: 'rounds_exhausted', status: 'failed' }, tooManyToolRoundsMessage);
      }

      const { completionEvents, discardedToolCalls, finishReason, toolCallEvents } =
        await appendCompletion(nextConversationEvents);
      guard();
      const lastAssistantText =
        completionEvents
          .toReversed()
          .find(
            (event): event is Extract<AgentConversationEvent, { type: 'message' }> =>
              event.type === 'message' && event.role === 'assistant'
          )?.text ?? '';
      lastAssistantSummary = lastAssistantText;
      nextConversationEvents.push(...completionEvents);

      if (discardedToolCalls) {
        throw new KiloGatewayUnsupportedToolError();
      }
      if (
        finishReason === 'model_context_window_exceeded' ||
        TRUNCATED_FINISH_REASONS.has(finishReason ?? '') ||
        (toolCallEvents.length === 0 &&
          completionEvents.length > 0 &&
          finishReason !== 'stop' &&
          finishReason !== 'end_turn')
      ) {
        if (lastAssistantText.trim() === '') {
          lastAssistantSummary = noResponseMessage;
          appendEvents([createAssistantMessage(noResponseMessage)]);
        }
        return outcome({
          reason:
            finishReason === 'model_context_window_exceeded'
              ? 'context_overflow'
              : 'truncated_response',
          status: 'failed',
        });
      }
      if (completionEvents.length === 0) {
        appendEvents([createAssistantMessage(noResponseMessage)]);
        return outcome({ reason: 'empty_response', status: 'failed' }, noResponseMessage);
      }

      if (toolCallEvents.length === 0) {
        const needsContinuation =
          endedThinkingOnly(completionEvents, lastAssistantText) ||
          (turnUsedTools && deservesContinueNudge(lastAssistantText));
        if (!continueNudgeSent && remainingRounds > 1 && needsContinuation) {
          continueNudgeSent = true;
          // Ephemeral: sent to the model, never appended to the stored conversation.
          nextConversationEvents.push(createUserMessage(CONTINUE_NUDGE_TEXT));
          return continueConversation(nextConversationEvents, remainingRounds - 1);
        }
        if (lastAssistantText.trim() === '') {
          appendEvents([createAssistantMessage(noResponseMessage)]);
          return outcome({ reason: 'empty_response', status: 'failed' }, noResponseMessage);
        }
        if (needsContinuation) {
          return outcome({ reason: 'incomplete_response', status: 'failed' });
        }
        return outcome({ reason: 'completed', status: 'succeeded' });
      }
      turnUsedTools = true;

      await runToolCalls(toolCallEvents, guardedExecuteToolCall, signal, {
        executionGuard: guard,
        onResult: result => {
          issuedActionPending = false;
          effectsUncertain ||= result.effectsUncertain;
          if (!result.effectsUncertain) {
            confirmedToolResults.push(result);
          }
          // Keep confirmed events even if Stop or lease loss prevents the next call.
          appendEvents([result]);
          nextConversationEvents.push(result);
          if (streakStopMessage !== undefined) {
            throw new ToolFailureLimitError(streakStopMessage);
          }
        },
      });
      if (effectsUncertain) {
        throw new ExecutionStoppedError('effects_uncertain', 'interrupted', true);
      }
      guard();
      return continueConversation(nextConversationEvents, remainingRounds - 1);
    };

    return await continueConversation([...conversationEvents], maxToolRounds);
  } catch (error) {
    if (error instanceof ExecutionStoppedError) {
      effectsUncertain ||= error.effectsUncertain;
      const summary = error.status === 'cancelled' ? 'Stopped.' : `Interrupted: ${error.reason}.`;
      appendEvents([createAssistantMessage(summary)]);
      return outcome({ reason: error.reason, status: error.status }, summary);
    }
    if (isExecutionStopped(error)) {
      effectsUncertain ||= issuedActionPending;
      appendEvents([createAssistantMessage('Stopped.')]);
      return outcome({ reason: 'cancelled', status: 'cancelled' }, 'Stopped.');
    }
    if (error instanceof KiloGatewayUnsupportedToolError) {
      const summary =
        'The model requested an unavailable or unsafe tool. No calls from that response were executed.';
      appendEvents([createAssistantMessage(summary)]);
      return outcome({ reason: 'unsafe_tool_call', status: 'failed' }, summary);
    }
    const summary = error instanceof ToolFailureLimitError ? error.message : failureMessage(error);
    appendEvents([createAssistantMessage(summary)]);
    if (issuedActionPending) {
      effectsUncertain = true;
      return outcome({ reason: 'effects_uncertain', status: 'interrupted' }, summary);
    }
    if (error instanceof TruncatedCompletionError) {
      return outcome({ reason: 'truncated_response', status: 'failed' }, summary);
    }
    if (error instanceof ToolFailureLimitError) {
      return outcome({ reason: 'tool_failure_limit', status: 'failed' }, summary);
    }
    return outcome(
      {
        reason: streamRetriesExhausted ? 'retry_exhausted' : 'model_failure',
        status: 'failed',
      },
      summary
    );
  }
};
