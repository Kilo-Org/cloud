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

type EvalToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;

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

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const isSignalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
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
      signal,
      thinkingEffort,
      token,
      tools: [evalToolDefinition],
    });

  const appendCompletion = async (
    nextEvents: AgentConversationEvent[]
  ): Promise<{
    completionEvents: AgentConversationEvent[];
    toolCallEvents: EvalToolCallEvent[];
  }> => {
    const completionEvents: AgentConversationEvent[] = [];
    let streamedText = '';
    let streamedAssistantEventId: string | undefined = undefined;
    const completion = await getGatewayChatCompletion(nextEvents, delta => {
      streamedText += delta;

      if (streamedAssistantEventId === undefined) {
        const assistantEvent = createAssistantMessageEvent(streamedText);

        streamedAssistantEventId = assistantEvent.id;
        completionEvents.push(assistantEvent);
        appendEvents([assistantEvent]);
        return;
      }

      updateAssistantMessage(streamedAssistantEventId, streamedText);
    });

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

    const toolCallEvents = completion.toolCalls.map(evalToolCall =>
      createEvalToolCall({
        code: evalToolCall.code,
        providerToolCallId: evalToolCall.id,
        tabId: selectedTabId,
      })
    );
    completionEvents.push(...toolCallEvents);

    appendEvents(completionEvents.filter(event => event.id !== streamedAssistantEventId));

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

      const toolResultEvents: AgentConversationEvent[] = await runEvalToolCalls(
        toolCallEvents,
        executeEvalToolCall
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
