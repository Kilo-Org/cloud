import { createAssistantMessage, createThinkingBlock } from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import { runToolCalls } from './agent-tool-results';
import type { FetchLike } from './auth';
import { buildGatewayMessagesFromEvents } from './agent-llm-harness';
import type { KiloGatewayToolCallRequest, KiloGatewayToolDefinition } from './kilo-api-client';
import { fetchKiloGatewayChatCompletionStream } from './kilo-api-client';
import type { EvalTabResult } from './tab-debugger';

type ToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;

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

const isSignalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

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
}: RunLlmTurnOptions<ToolCall>): Promise<void> => {
  const getGatewayChatCompletion = (
    nextEvents: AgentConversationEvent[],
    onContentDelta: (delta: string) => void,
    onReasoningDelta: (delta: string) => void
  ) =>
    fetchKiloGatewayChatCompletionStream({
      apiBaseUrl,
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
    const completion = await getGatewayChatCompletion(
      nextEvents,
      delta => {
        streamedText += delta;

        if (streamedAssistantEventId === undefined) {
          const assistantEvent = createAssistantMessage(streamedText);

          streamedAssistantEventId = assistantEvent.id;
          completionEvents.push(assistantEvent);
          appendEvents([assistantEvent]);
          return;
        }

        updateAssistantMessage(streamedAssistantEventId, streamedText);
      },
      delta => {
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
  };

  try {
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
        return;
      }

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
