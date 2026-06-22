import { createAssistantMessage, createEvalToolCall } from '@/src/shared/agent-conversation';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import {
  buildGatewayMessagesFromEvents,
  createEvalToolDefinition,
} from '@/src/shared/agent-llm-harness';
import { runEvalToolCalls } from '@/src/shared/agent-tool-results';
import type { FetchLike } from '@/src/shared/auth';
import { fetchKiloGatewayChatCompletionStream } from '@/src/shared/kilo-api-client';
import { executeEvalToolCall } from './agent-eval-runtime';

interface RunDangerousLlmTurnOptions {
  readonly apiBaseUrl: string;
  readonly appendEvents: (events: AgentConversationEvent[]) => void;
  readonly conversationEvents: AgentConversationEvent[];
  readonly fetch: FetchLike;
  readonly model: string;
  readonly organizationId?: string | undefined;
  readonly selectedTabId: number;
  readonly token: string;
  readonly updateAssistantMessage: (eventId: string, text: string) => void;
}

const evalToolDefinition = createEvalToolDefinition();
const createAssistantMessageEvent = (
  text: string
): Extract<AgentConversationEvent, { readonly type: 'message' }> => {
  const event = createAssistantMessage(text);

  if (event.type !== 'message') {
    throw new Error('Expected assistant message event.');
  }

  return event;
};

export const runDangerousLlmTurn = async ({
  apiBaseUrl,
  appendEvents,
  conversationEvents,
  fetch,
  model,
  organizationId,
  selectedTabId,
  token,
  updateAssistantMessage,
}: RunDangerousLlmTurnOptions): Promise<void> => {
  const getGatewayChatCompletion = (
    nextEvents: AgentConversationEvent[],
    onContentDelta: (delta: string) => void
  ) =>
    fetchKiloGatewayChatCompletionStream({
      apiBaseUrl,
      fetch,
      messages: buildGatewayMessagesFromEvents(nextEvents),
      model,
      onContentDelta,
      organizationId,
      token,
      tools: [evalToolDefinition],
    });

  try {
    const firstCompletionEvents: AgentConversationEvent[] = [];
    let streamedText = '';
    let streamedAssistantEventId: string | undefined = undefined;
    const firstCompletion = await getGatewayChatCompletion(conversationEvents, delta => {
      streamedText += delta;

      if (streamedAssistantEventId === undefined) {
        const assistantEvent = createAssistantMessageEvent(streamedText);

        streamedAssistantEventId = assistantEvent.id;
        firstCompletionEvents.push(assistantEvent);
        appendEvents([assistantEvent]);
        return;
      }

      updateAssistantMessage(streamedAssistantEventId, streamedText);
    });

    if (streamedAssistantEventId !== undefined) {
      const finalStreamedText = firstCompletion.content ?? streamedText;
      const streamedAssistantEventIndex = firstCompletionEvents.findIndex(
        event => event.id === streamedAssistantEventId
      );

      if (streamedAssistantEventIndex !== -1) {
        firstCompletionEvents.splice(streamedAssistantEventIndex, 1, {
          id: streamedAssistantEventId,
          role: 'assistant',
          text: finalStreamedText,
          type: 'message',
        });
      }
    }

    if (firstCompletion.content !== undefined && streamedAssistantEventId === undefined) {
      firstCompletionEvents.push(createAssistantMessage(firstCompletion.content));
    }

    const toolCallEvents = firstCompletion.toolCalls.map(evalToolCall =>
      createEvalToolCall({
        code: evalToolCall.code,
        providerToolCallId: evalToolCall.id,
        tabId: selectedTabId,
      })
    );
    firstCompletionEvents.push(...toolCallEvents);

    if (firstCompletionEvents.length === 0) {
      appendEvents([createAssistantMessage('The model did not return a response.')]);
      return;
    }

    appendEvents(firstCompletionEvents.filter(event => event.id !== streamedAssistantEventId));

    if (toolCallEvents.length === 0) {
      return;
    }

    const toolResultEvents: AgentConversationEvent[] = await runEvalToolCalls(
      toolCallEvents,
      executeEvalToolCall
    );

    const conversationWithToolResult = [
      ...conversationEvents,
      ...firstCompletionEvents,
      ...toolResultEvents,
    ];

    appendEvents(toolResultEvents);

    let finalText = '';
    let finalAssistantEventId: string | undefined = undefined;
    const finalCompletion = await getGatewayChatCompletion(conversationWithToolResult, delta => {
      finalText += delta;

      if (finalAssistantEventId === undefined) {
        const assistantEvent = createAssistantMessageEvent(finalText);

        finalAssistantEventId = assistantEvent.id;
        appendEvents([assistantEvent]);
        return;
      }

      updateAssistantMessage(finalAssistantEventId, finalText);
    });

    if (finalAssistantEventId === undefined) {
      appendEvents([
        createAssistantMessage(
          finalCompletion.content ??
            'The model requested another eval after this tool result. Send another message to continue.'
        ),
      ]);
    }
  } catch (error) {
    appendEvents([
      createAssistantMessage(
        `LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      ),
    ]);
  }
};
