import { describe, expect, it } from 'vitest';
import {
  createAssistantMessage,
  createEvalToolCall,
  createToolResult,
  createUserMessage,
  groupConversationEvents,
} from './agent-conversation';

describe('agent conversation events', () => {
  it('creates stable conversation events for messages and eval tools', () => {
    const userMessage = createUserMessage('Inspect the page');
    const assistantMessage = createAssistantMessage('I can do that.');
    const toolCall = createEvalToolCall({
      code: 'return document.title;',
      tabId: 7,
    });
    const toolResult = createToolResult({
      ok: true,
      toolCallId: 'event-3',
      value: 'Kilo',
    });

    const { id: userMessageId, ...userMessagePayload } = userMessage;
    const { id: assistantMessageId, ...assistantMessagePayload } = assistantMessage;
    const { id: toolCallId, ...toolCallPayload } = toolCall;
    const { id: toolResultId, ...toolResultPayload } = toolResult;

    expect({
      assistantMessageIdType: typeof assistantMessageId,
      assistantMessagePayload,
      toolCallIdType: typeof toolCallId,
      toolCallPayload,
      toolResultIdType: typeof toolResultId,
      toolResultPayload,
      userMessageIdType: typeof userMessageId,
      userMessagePayload,
    }).toStrictEqual({
      assistantMessageIdType: 'string',
      assistantMessagePayload: {
        role: 'assistant',
        text: 'I can do that.',
        type: 'message',
      },
      toolCallIdType: 'string',
      toolCallPayload: {
        code: 'return document.title;',
        name: 'eval',
        tabId: 7,
        type: 'tool-call',
      },
      toolResultIdType: 'string',
      toolResultPayload: {
        ok: true,
        toolCallId: 'event-3',
        type: 'tool-result',
        value: 'Kilo',
      },
      userMessageIdType: 'string',
      userMessagePayload: {
        role: 'user',
        text: 'Inspect the page',
        type: 'message',
      },
    });
  });

  it('groups matching eval tool calls and results into one transcript item', () => {
    const userMessage = createUserMessage('Inspect');
    const toolCall = createEvalToolCall({
      code: 'return document.title;',
      tabId: 7,
    });
    const toolResult = createToolResult({
      ok: true,
      toolCallId: toolCall.id,
      value: 'Kilo',
    });
    const assistantMessage = createAssistantMessage('Eval returned Kilo.');

    expect(
      groupConversationEvents([userMessage, toolCall, toolResult, assistantMessage])
    ).toStrictEqual([
      { event: userMessage, type: 'event' },
      { result: toolResult, toolCall, type: 'tool-exchange' },
      { event: assistantMessage, type: 'event' },
    ]);
  });
});
