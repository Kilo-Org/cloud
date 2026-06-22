import {
  createAssistantMessage,
  createEvalToolCall,
  createToolResult,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import {
  buildGatewayMessagesFromEvents,
  createEvalToolDefinition,
} from '@/src/shared/agent-llm-harness';
import type { FetchLike } from '@/src/shared/auth';
import { fetchKiloGatewayChatCompletion } from '@/src/shared/kilo-api-client';
import { executeEvalToolCall } from './agent-eval-runtime';

interface RunDangerousLlmTurnOptions {
  readonly apiBaseUrl: string;
  readonly appendEvents: (events: AgentConversationEvent[]) => void;
  readonly conversationEvents: AgentConversationEvent[];
  readonly fetch: FetchLike;
  readonly model: string;
  readonly selectedTabId: number;
  readonly token: string;
}

const evalToolDefinition = createEvalToolDefinition();

export const runDangerousLlmTurn = async ({
  apiBaseUrl,
  appendEvents,
  conversationEvents,
  fetch,
  model,
  selectedTabId,
  token,
}: RunDangerousLlmTurnOptions): Promise<void> => {
  const getGatewayChatCompletion = (nextEvents: AgentConversationEvent[]) =>
    fetchKiloGatewayChatCompletion({
      apiBaseUrl,
      fetch,
      messages: buildGatewayMessagesFromEvents(nextEvents),
      model,
      token,
      tools: [evalToolDefinition],
    });

  try {
    const firstCompletion = await getGatewayChatCompletion(conversationEvents);
    const firstCompletionEvents: AgentConversationEvent[] = [];

    if (firstCompletion.content !== undefined) {
      firstCompletionEvents.push(createAssistantMessage(firstCompletion.content));
    }

    const [evalToolCall] = firstCompletion.toolCalls;

    if (evalToolCall !== undefined) {
      firstCompletionEvents.push(
        createEvalToolCall({
          code: evalToolCall.code,
          providerToolCallId: evalToolCall.id,
          tabId: selectedTabId,
        })
      );
    }

    if (firstCompletionEvents.length === 0) {
      appendEvents([createAssistantMessage('The model did not return a response.')]);
      return;
    }

    appendEvents(firstCompletionEvents);

    if (evalToolCall === undefined) {
      return;
    }

    const toolCallEvent = firstCompletionEvents.find(
      (event): event is Extract<AgentConversationEvent, { readonly type: 'tool-call' }> =>
        event.type === 'tool-call'
    );

    if (toolCallEvent === undefined) {
      appendEvents([createAssistantMessage('The model did not return eval code.')]);
      return;
    }

    const result = await executeEvalToolCall(toolCallEvent);
    const toolResultEvent = result.ok
      ? createToolResult({
          ok: true,
          toolCallId: toolCallEvent.id,
          value: result.value,
        })
      : createToolResult({
          error: result.error,
          ok: false,
          toolCallId: toolCallEvent.id,
        });
    const conversationWithToolResult = [
      ...conversationEvents,
      ...firstCompletionEvents,
      toolResultEvent,
    ];

    appendEvents([toolResultEvent]);

    const finalCompletion = await getGatewayChatCompletion(conversationWithToolResult);

    appendEvents([
      createAssistantMessage(
        finalCompletion.content ??
          'The model requested another eval after this tool result. Send another message to continue.'
      ),
    ]);
  } catch (error) {
    appendEvents([
      createAssistantMessage(
        `LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      ),
    ]);
  }
};
