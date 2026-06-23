import {
  createAssistantMessage,
  createEvalToolCall,
  createSafeToolCall,
  createThinkingBlock,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent, SafeToolName } from '@/src/shared/agent-conversation';
import {
  buildGatewayMessagesFromEvents,
  createEvalToolDefinition,
  createSafeToolDefinitions,
} from '@/src/shared/agent-llm-harness';
import { runToolCalls } from '@/src/shared/agent-tool-results';
import type { FetchLike } from '@/src/shared/auth';
import { fetchKiloGatewayChatCompletionStream } from '@/src/shared/kilo-api-client';
import { executeEvalToolCall } from './agent-eval-runtime';
import { executeSafeToolCall } from './agent-safe-tool-runtime';

type ToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;

interface RunDangerousLlmTurnOptions {
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

const dangerousToolDefinitions = [...createSafeToolDefinitions(), createEvalToolDefinition()];
const createAssistantMessageEvent = (
  text: string
): Extract<AgentConversationEvent, { readonly type: 'message' }> => {
  const event = createAssistantMessage(text);

  if (event.type !== 'message') {
    throw new Error('Expected assistant message event.');
  }

  return event;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const isSignalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
const getStringArgument = (args: Record<string, unknown>, name: string): string | undefined =>
  typeof args[name] === 'string' ? args[name] : undefined;
const isSafeToolName = (name: string): name is SafeToolName =>
  name === 'find_in_page' || name === 'get_element_details' || name === 'get_page_snapshot';
const maxEvalRounds = 4;

export const runDangerousLlmTurn = async ({
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
}: RunDangerousLlmTurnOptions): Promise<void> => {
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
      tools: dangerousToolDefinitions,
    });

  const appendCompletion = async (
    nextEvents: AgentConversationEvent[]
  ): Promise<{
    completionEvents: AgentConversationEvent[];
    toolCallEvents: ToolCallEvent[];
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

    const toolCallEvents: ToolCallEvent[] = [];

    for (const toolCall of completion.toolCalls) {
      if (toolCall.name === 'eval') {
        if (typeof toolCall.arguments['code'] === 'string') {
          toolCallEvents.push(
            createEvalToolCall({
              code: toolCall.arguments['code'],
              providerToolCallId: toolCall.id,
              tabId: selectedTabId,
            })
          );
        }
      } else if (isSafeToolName(toolCall.name)) {
        const elementId = getStringArgument(toolCall.arguments, 'elementId');
        const query = getStringArgument(toolCall.arguments, 'query');

        toolCallEvents.push(
          createSafeToolCall({
            name: toolCall.name,
            providerToolCallId: toolCall.id,
            ...(elementId === undefined ? {} : { elementId }),
            ...(query === undefined ? {} : { query }),
            tabId: selectedTabId,
          })
        );
      }
    }
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
            'The model requested too many eval rounds. Send another message to continue.'
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
        toolCall =>
          toolCall.name === 'eval' ? executeEvalToolCall(toolCall) : executeSafeToolCall(toolCall)
      );

      if (isSignalAborted(signal)) {
        appendEvents([createAssistantMessage('Stopped.')]);
        return;
      }

      appendEvents(toolResultEvents);
      nextConversationEvents.push(...toolResultEvents);

      await continueConversation(nextConversationEvents, remainingRounds - 1);
    };

    await continueConversation([...conversationEvents], maxEvalRounds);
  } catch (error) {
    if (isAbortError(error)) {
      appendEvents([createAssistantMessage('Stopped.')]);
      return;
    }

    appendEvents([
      createAssistantMessage(
        `LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      ),
    ]);
  }
};
