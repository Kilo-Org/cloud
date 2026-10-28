import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessage,
  createRemoteMcpToolCall,
  createThinkingBlock,
  createToolCall,
  createToolResult,
  createUserMessage,
  createWorkflowToolCall,
  getConversationScrollKey,
  groupConversationEvents,
} from './agent-conversation';
import type { GroupedConversationItem } from './agent-conversation';

describe('agent conversation events', () => {
  it('creates stable conversation events for messages and browser tools', () => {
    const userMessage = createUserMessage('Inspect the page');
    const assistantMessage = createAssistantMessage('I can do that.');
    const thinkingBlock = createThinkingBlock('I should inspect the title.');
    const toolCall = createToolCall({
      arguments: { function: 'return document.title;' },
      name: 'kilo_browser_evaluate',
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
        arguments: { function: 'return document.title;' },
        name: 'kilo_browser_evaluate',
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

  it('groups matching browser tool calls and results into one transcript item', () => {
    const userMessage = createUserMessage('Inspect');
    const toolCall = createToolCall({
      arguments: { function: 'return document.title;' },
      name: 'kilo_browser_evaluate',
      tabId: 7,
    });
    const toolResult = createToolResult({
      ok: true,
      toolCallId: toolCall.id,
      value: 'Kilo',
    });
    const assistantMessage = createAssistantMessage('The browser tool returned Kilo.');

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

  it('marks an in-flight agent tool exchange in the scroll key', () => {
    const toolCall = {
      arguments: { filePath: 'src/auth.ts' },
      id: 'tc-agent',
      name: 'read',
      source: 'agent' as const,
      type: 'tool-call' as const,
    };
    const items: GroupedConversationItem[] = [{ toolCall, type: 'tool-exchange' }];

    expect(getConversationScrollKey(items)).toBe('tc-agent:running');
  });

  it('keeps the result id in the scroll key once the tool exchange completes', () => {
    const toolCall = {
      arguments: { filePath: 'src/auth.ts' },
      id: 'tc-agent',
      name: 'read',
      source: 'agent' as const,
      type: 'tool-call' as const,
    };
    const result = createToolResult({
      ok: true,
      toolCallId: toolCall.id,
      value: 'export const guard = () => true;',
    });
    const items: GroupedConversationItem[] = [{ result, toolCall, type: 'tool-exchange' }];

    expect(getConversationScrollKey(items)).toBe(`tc-agent:${result.id}`);
  });

  it('creates a generic browser tool-call event with the upstream arguments verbatim', () => {
    const toolCall = createToolCall({
      arguments: { element: 'Save', nested: { deep: { value: [1, 2, 3] } }, ref: 'e5' },
      name: 'kilo_browser_click',
      providerToolCallId: 'call-1',
      tabId: 7,
    });
    const { id: _id, ...payload } = toolCall;

    expect(payload).toStrictEqual({
      arguments: { element: 'Save', nested: { deep: { value: [1, 2, 3] } }, ref: 'e5' },
      name: 'kilo_browser_click',
      providerToolCallId: 'call-1',
      tabId: 7,
      type: 'tool-call',
    });
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
    const { id: _id, ...payload } = toolCall;

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

  it('groups workflow tool calls and results into one transcript item', () => {
    const toolCall = createWorkflowToolCall({
      arguments: { workflowId: 'wf-1' },
      name: 'run_workflow',
      tabId: 7,
    });
    const toolResult = createToolResult({
      ok: true,
      toolCallId: toolCall.id,
      value: { done: true, result: 'Completed' },
    });

    expect(groupConversationEvents([toolCall, toolResult])).toStrictEqual([
      { result: toolResult, toolCall, type: 'tool-exchange' },
    ]);
  });
});
