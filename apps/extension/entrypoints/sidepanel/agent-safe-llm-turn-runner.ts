import {
  createAssistantMessage,
  createSafeToolCall,
  createThinkingBlock,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent, SafeToolName } from '@/src/shared/agent-conversation';
import {
  buildGatewayMessagesFromEvents,
  createSafeToolDefinitions,
} from '@/src/shared/agent-llm-harness';
import { runToolCalls } from '@/src/shared/agent-tool-results';
import type { FetchLike } from '@/src/shared/auth';
import { fetchKiloGatewayChatCompletionStream } from '@/src/shared/kilo-api-client';
import { executeSafeToolCall } from './agent-safe-tool-runtime';

type SafeToolCallEvent = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;

interface RunSafeLlmTurnOptions {
  readonly apiBaseUrl: string;
  readonly appendEvents: (events: AgentConversationEvent[]) => void;
  readonly conversationEvents: AgentConversationEvent[];
  readonly fetch: FetchLike;
  readonly model: string;
  readonly organizationId?: string | undefined;
  readonly selectedTabId: number;
  readonly signal?: AbortSignal | undefined;
  readonly thinkingEffort?: string | undefined;
  readonly token: string;
  readonly updateAssistantMessage: (eventId: string, text: string) => void;
  readonly updateThinkingBlock: (eventId: string, text: string) => void;
}

const safeToolDefinitions = createSafeToolDefinitions();
const maxSafeToolRounds = 4;

const createAssistantMessageEvent = (
  text: string
): Extract<AgentConversationEvent, { readonly type: 'message' }> => createAssistantMessage(text);

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const isSignalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const getStringArgument = (args: Record<string, unknown>, name: string): string | undefined =>
  typeof args[name] === 'string' ? args[name] : undefined;

const isSafeToolName = (name: string): name is SafeToolName =>
  name === 'find_in_page' || name === 'get_element_details' || name === 'get_page_snapshot';

export const runSafeLlmTurn = async ({
  apiBaseUrl,
  appendEvents,
  conversationEvents,
  fetch,
  model,
  organizationId,
  selectedTabId,
  signal,
  thinkingEffort,
  token,
  updateAssistantMessage,
  updateThinkingBlock,
}: RunSafeLlmTurnOptions): Promise<void> => {
  const getGatewayChatCompletion = (
    nextEvents: AgentConversationEvent[],
    onContentDelta: (delta: string) => void,
    onReasoningDelta: (delta: string) => void
  ) =>
    fetchKiloGatewayChatCompletionStream({
      apiBaseUrl,
      fetch,
      messages: buildGatewayMessagesFromEvents(nextEvents),
      model,
      onContentDelta,
      onReasoningDelta,
      organizationId,
      signal,
      thinkingEffort,
      token,
      tools: safeToolDefinitions,
    });

  const appendCompletion = async (
    nextEvents: AgentConversationEvent[]
  ): Promise<{
    completionEvents: AgentConversationEvent[];
    toolCallEvents: SafeToolCallEvent[];
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
          const assistantEvent = createAssistantMessageEvent(streamedText);

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

    if (completion.content !== undefined && streamedAssistantEventId === undefined) {
      completionEvents.push(createAssistantMessage(completion.content));
    }

    if (completion.reasoning !== undefined && streamedThinkingEventId === undefined) {
      completionEvents.push(createThinkingBlock(completion.reasoning));
    }

    const toolCallEvents = completion.toolCalls.flatMap(toolCall => {
      if (!isSafeToolName(toolCall.name)) {
        return [];
      }

      const elementId = getStringArgument(toolCall.arguments, 'elementId');
      const query = getStringArgument(toolCall.arguments, 'query');

      return [
        createSafeToolCall({
          name: toolCall.name,
          providerToolCallId: toolCall.id,
          ...(elementId === undefined ? {} : { elementId }),
          ...(query === undefined ? {} : { query }),
          tabId: selectedTabId,
        }),
      ];
    });
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
        appendEvents([
          createAssistantMessage(
            'The model requested too many safe read rounds. Send another message to continue.'
          ),
        ]);
        return;
      }

      const { completionEvents, toolCallEvents } = await appendCompletion(nextConversationEvents);

      if (completionEvents.length === 0) {
        appendEvents([createAssistantMessage('The model did not return a response.')]);
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
        executeSafeToolCall
      );

      if (isSignalAborted(signal)) {
        appendEvents([createAssistantMessage('Stopped.')]);
        return;
      }

      appendEvents(toolResultEvents);
      nextConversationEvents.push(...toolResultEvents);

      await continueConversation(nextConversationEvents, remainingRounds - 1);
    };

    await continueConversation([...conversationEvents], maxSafeToolRounds);
  } catch (error) {
    if (isAbortError(error)) {
      appendEvents([createAssistantMessage('Stopped.')]);
      return;
    }

    appendEvents([
      createAssistantMessage(error instanceof Error ? error.message : 'Failed to run safe mode.'),
    ]);
  }
};
