import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createAssistantMessage,
  createEvalToolCall,
  createRemoteMcpToolCall,
  createThinkingBlock,
  createToolResult,
  createUserMessage,
  groupConversationEvents,
  getConversationScrollKey,
} from './agent-conversation';

describe('agent conversation events', () => {
  it('creates stable conversation events for messages and eval tools', () => {
    const userMessage = createUserMessage('Inspect the page');
    const assistantMessage = createAssistantMessage('I can do that.');
    const thinkingBlock = createThinkingBlock('I should inspect the title.');
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
    const { id: thinkingBlockId, ...thinkingBlockPayload } = thinkingBlock;
    const { id: toolCallId, ...toolCallPayload } = toolCall;
    const { id: toolResultId, ...toolResultPayload } = toolResult;

    expect({
      assistantMessageIdType: typeof assistantMessageId,
      assistantMessagePayload,
      thinkingBlockIdType: typeof thinkingBlockId,
      thinkingBlockPayload,
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
      thinkingBlockIdType: 'string',
      thinkingBlockPayload: {
        text: 'I should inspect the title.',
        type: 'thinking',
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

  it('changes the scroll key when a streamed message grows in place', () => {
    const assistantMessage = createAssistantMessage('Streaming');
    const firstKey = getConversationScrollKey(groupConversationEvents([assistantMessage]));
    const nextKey = getConversationScrollKey(
      groupConversationEvents([{ ...assistantMessage, text: 'Streaming more tokens' }])
    );

    expect(nextKey).not.toBe(firstKey);
  });

  it('does not reuse event ids across extension reloads', async () => {
    vi.resetModules();
    const firstSession = await import('./agent-conversation');
    const firstId = firstSession.createAssistantMessage('First session reply').id;

    vi.resetModules();
    const secondSession = await import('./agent-conversation');
    const secondId = secondSession.createAssistantMessage('Second session reply').id;

    expect(secondId).not.toBe(firstId);
  });

  it('changes the scroll key when a streamed thinking block grows in place', () => {
    const thinkingBlock = createThinkingBlock('Thinking');
    const firstKey = getConversationScrollKey(groupConversationEvents([thinkingBlock]));
    const nextKey = getConversationScrollKey(
      groupConversationEvents([{ ...thinkingBlock, text: 'Thinking more tokens' }])
    );

    expect(nextKey).not.toBe(firstKey);
  });

  it('creates remote MCP tool-call events', () => {
    const toolCall = createRemoteMcpToolCall({
      arguments: { query: 'kilo' },
      name: 'mcp_github_search_repos',
      providerToolCallId: 'call-1',
      remoteToolName: 'search_repos',
      serverId: 'server-1',
      serverName: 'GitHub',
    });
    const { id, ...payload } = toolCall;

    expectTypeOf(id).toBeString();
    expect(payload).toStrictEqual({
      arguments: { query: 'kilo' },
      name: 'mcp_github_search_repos',
      providerToolCallId: 'call-1',
      remoteToolName: 'search_repos',
      serverId: 'server-1',
      serverName: 'GitHub',
      type: 'tool-call',
    });
  });
});
