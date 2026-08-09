import { describe, expect, test } from '@jest/globals';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { getToolsAvailable, getToolsUsed } from './api-metrics.server';

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

function chatRequest(overrides: Partial<OpenRouterChatCompletionRequest> = {}): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: 'test-model',
      messages: [],
      ...overrides,
    },
  };
}

function responsesRequest(overrides: Partial<GatewayResponsesRequest> = {}): GatewayRequest {
  return {
    kind: 'responses',
    body: {
      model: 'test-model',
      input: [],
      ...overrides,
    },
  };
}

function messagesRequest(overrides: Partial<GatewayMessagesRequest> = {}): GatewayRequest {
  return {
    kind: 'messages',
    body: {
      model: 'test-model',
      max_tokens: 16,
      messages: [],
      ...overrides,
    },
  };
}

describe('getToolsAvailable', () => {
  test('returns empty when tools is missing', () => {
    expect(getToolsAvailable(chatRequest())).toEqual([]);
  });

  test('returns empty when tools is not an array', () => {
    expect(
      getToolsAvailable(
        chatRequest({
          tools: { type: 'function', function: { name: 'search' } } as never,
        })
      )
    ).toEqual([]);
    expect(getToolsAvailable(chatRequest({ tools: 'search' as never }))).toEqual([]);
  });

  test('labels chat completion function and custom tools', () => {
    expect(
      getToolsAvailable(
        chatRequest({
          tools: [
            { type: 'function', function: { name: '  search  ' } },
            { type: 'custom', custom: { name: 'browser' } },
            { type: 'function', function: { name: '' } },
          ],
        })
      )
    ).toEqual(['function:search', 'custom:browser', 'function:unknown']);
  });

  test('labels responses tools and tolerates missing mcp server_label', () => {
    expect(
      getToolsAvailable(
        responsesRequest({
          tools: [
            { type: 'function', name: 'lookup' },
            { type: 'custom', name: 'browser' },
            { type: 'mcp' },
            { type: 'web_search_preview' },
          ] as GatewayResponsesRequest['tools'],
        })
      )
    ).toEqual(['function:lookup', 'custom:browser', 'mcp:unknown', 'web_search_preview']);
  });

  test('labels messages tools', () => {
    expect(
      getToolsAvailable(
        messagesRequest({
          tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        })
      )
    ).toEqual(['function:read_file']);
  });
});

describe('getToolsUsed', () => {
  test('returns empty when chat messages are missing', () => {
    expect(getToolsUsed(chatRequest({ messages: undefined as never }))).toEqual([]);
  });

  test('labels chat completion tool calls', () => {
    expect(
      getToolsUsed(
        chatRequest({
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: '1', type: 'function', function: { name: 'search', arguments: '{}' } },
                { id: '2', type: 'custom', custom: { name: 'browser', input: '{}' } },
              ],
            },
          ],
        })
      )
    ).toEqual(['function:search', 'custom:browser']);
  });

  test('tolerates responses tool calls with missing names', () => {
    expect(
      getToolsUsed(
        responsesRequest({
          input: [
            { type: 'function_call', call_id: '1', name: 'search', arguments: '{}' },
            { type: 'function_call', call_id: '2' },
            { type: 'custom_tool_call', call_id: '3', name: 'browser', input: '{}' },
            { type: 'custom_tool_call', call_id: '4' },
          ] as GatewayResponsesRequest['input'],
        })
      )
    ).toEqual(['function:search', 'function:unknown', 'custom:browser', 'custom:unknown']);
  });

  test('labels messages tool_use blocks', () => {
    expect(
      getToolsUsed(
        messagesRequest({
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: '1', name: 'read_file', input: {} }],
            },
          ],
        })
      )
    ).toEqual(['function:read_file']);
  });
});
