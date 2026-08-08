/* eslint-disable max-lines, promise/avoid-new, promise/no-multiple-resolved -- Turn loop with a transparent stream-retry tier; the cancellable delay needs a raw, guard-settled promise. */
import {
  createAssistantMessage,
  createThinkingBlock,
  createUserMessage,
} from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import { runToolCalls } from './agent-tool-results';
import type { FetchLike } from './auth';
import { buildGatewayMessagesFromEvents } from './agent-llm-harness';
import type { KiloGatewayToolCallRequest, KiloGatewayToolDefinition } from './kilo-api-client';
import {
  fetchKiloGatewayChatCompletionStream,
  KiloGatewayHttpError,
  KiloGatewayStreamStalledError,
} from './kilo-api-client';
import type { EvalTabResult } from './tab-debugger';

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
  readonly failureMessage: (error: unknown) => string;
  readonly fetch: FetchLike;
  readonly maxToolRounds: number;
  readonly model: string;
  readonly noResponseMessage: string;
  readonly onUsage?: OnTurnUsage | undefined;
  readonly organizationId?: string | undefined;
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

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const isHighEffort = (thinkingEffort: string | undefined): boolean =>
  thinkingEffort === 'high' || thinkingEffort === 'xhigh' || thinkingEffort === 'max';

const isSignalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

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
const TRUNCATED_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'content_filter',
  'content-filter',
  'error',
  'network_error',
  'failed',
  'model_context_window_exceeded',
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
  /\b(?:i'?ll|i will|i am going to|let me|now i|next i)\b|^\s*\w+ing\b[^.!?]*\b(?:workflow|script|search|page|result)/iu;

const deservesContinueNudge = (lastAssistantText: string): boolean =>
  lastAssistantText.length > 0 &&
  lastAssistantText.length < CONTINUE_NUDGE_MAX_TEXT_LENGTH &&
  !lastAssistantText.includes('?') &&
  ANNOUNCEMENT_RE.test(lastAssistantText);

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
  failureMessage,
  fetch,
  maxToolRounds,
  model,
  noResponseMessage,
  onUsage,
  organizationId,
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
}: RunLlmTurnOptions<ToolCall>): Promise<void> => {
  const getGatewayChatCompletion = (
    nextEvents: AgentConversationEvent[],
    onContentDelta: (delta: string) => void,
    onReasoningDelta: (delta: string) => void
  ) =>
    fetchKiloGatewayChatCompletionStream({
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
      tools,
    });

  const appendCompletion = async (
    nextEvents: AgentConversationEvent[]
  ): Promise<{
    completionEvents: AgentConversationEvent[];
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
          if (
            streamAttempt >= MAX_STREAM_ATTEMPTS ||
            !isRetriableStreamError(error) ||
            isSignalAborted(signal)
          ) {
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
          if (isSignalAborted(signal)) {
            const abortError = new Error('The user aborted a request.');
            abortError.name = 'AbortError';
            throw abortError;
          }
          return streamWithRetries(streamAttempt + 1);
        }
      };
      const completion = await streamWithRetries(1);

      if (completion.usage !== undefined) {
        onUsage?.(completion.usage);
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
        const finalStreamedText = completion.content ?? streamedText;
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

      const toolCallEvents = withReasoningDetails(
        toToolCallEvents(completion.toolCalls),
        completion.reasoningDetails
      );
      completionEvents.push(...toolCallEvents);

      appendEvents(
        completionEvents.filter(
          event => event.id !== streamedAssistantEventId && event.id !== streamedThinkingEventId
        )
      );

      return { completionEvents, toolCallEvents };
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
    ): Promise<void> => {
      if (remainingRounds === 0) {
        appendEvents([createAssistantMessage(tooManyToolRoundsMessage)]);
        return;
      }

      const { completionEvents, toolCallEvents } = await appendCompletion(nextConversationEvents);

      if (completionEvents.length === 0) {
        appendEvents([createAssistantMessage(noResponseMessage)]);
        return;
      }

      nextConversationEvents.push(...completionEvents);

      if (toolCallEvents.length === 0) {
        const lastAssistantText =
          completionEvents
            .toReversed()
            .find(
              (event): event is Extract<AgentConversationEvent, { type: 'message' }> =>
                event.type === 'message' && event.role === 'assistant'
            )?.text ?? '';
        if (
          turnUsedTools &&
          !continueNudgeSent &&
          remainingRounds > 1 &&
          !isSignalAborted(signal) &&
          deservesContinueNudge(lastAssistantText)
        ) {
          continueNudgeSent = true;
          // Ephemeral: sent to the model, never appended to the stored conversation.
          nextConversationEvents.push(createUserMessage(CONTINUE_NUDGE_TEXT));
          await continueConversation(nextConversationEvents, remainingRounds - 1);
        }
        return;
      }
      turnUsedTools = true;

      if (isSignalAborted(signal)) {
        appendEvents([createAssistantMessage('Stopped.')]);
        return;
      }

      const toolResultEvents: AgentConversationEvent[] = await runToolCalls(
        toolCallEvents,
        executeToolCall,
        signal
      );

      if (isSignalAborted(signal)) {
        appendEvents([createAssistantMessage('Stopped.')]);
        return;
      }

      appendEvents(toolResultEvents);
      nextConversationEvents.push(...toolResultEvents);

      await continueConversation(nextConversationEvents, remainingRounds - 1);
    };

    await continueConversation([...conversationEvents], maxToolRounds);
  } catch (error) {
    appendEvents([
      createAssistantMessage(isAbortError(error) ? 'Stopped.' : failureMessage(error)),
    ]);
  }
};
