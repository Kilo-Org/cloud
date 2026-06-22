import { describe, expect, it } from 'vitest';
import {
  createAssistantMessage,
  createEvalToolCall,
  createToolResult,
  createUserMessage,
  planLocalDangerousAgentTurn,
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

  it('plans an eval tool call for dangerous-mode page inspection prompts', () => {
    expect(
      planLocalDangerousAgentTurn({
        mode: 'dangerous',
        selectedTabId: 7,
        userText: 'Inspect this tab and tell me the HTML length',
      })
    ).toMatchObject([
      {
        role: 'assistant',
        text: 'I will inspect the selected tab with eval.',
        type: 'message',
      },
      {
        code: 'return document.documentElement.outerHTML.length;',
        name: 'eval',
        tabId: 7,
        type: 'tool-call',
      },
    ]);
  });

  it('does not plan eval outside dangerous mode', () => {
    expect(
      planLocalDangerousAgentTurn({
        mode: 'safe',
        selectedTabId: 7,
        userText: 'Inspect this tab and tell me the HTML length',
      })
    ).toMatchObject([
      {
        role: 'assistant',
        text: 'Switch to dangerous mode before I can run eval in a tab.',
        type: 'message',
      },
    ]);
  });

  it('asks for a target tab before planning eval', () => {
    expect(
      planLocalDangerousAgentTurn({
        mode: 'dangerous',
        selectedTabId: undefined,
        userText: 'Inspect this tab and tell me the HTML length',
      })
    ).toMatchObject([
      {
        role: 'assistant',
        text: 'Pick a target tab first.',
        type: 'message',
      },
    ]);
  });
});
