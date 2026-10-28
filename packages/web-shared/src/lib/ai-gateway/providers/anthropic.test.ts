import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { applyAnthropicModelSettings } from './anthropic';

const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function apply(request: GatewayRequest) {
  applyAnthropicModelSettings(request, {});
}

describe('applyAnthropicModelSettings tool call ids', () => {
  it('normalizes invalid chat completions tool call ids consistently', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call:1/a b', type: 'function', function: { name: 'read', arguments: '{}' } },
              { id: 'call_2-ok', type: 'function', function: { name: 'read', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call:1/a b', content: 'one' },
          { role: 'tool', tool_call_id: 'call_2-ok', content: 'two' },
        ],
      },
    };

    apply(request);

    const [, assistant, firstResult, secondResult] = request.body.messages;
    if (assistant.role !== 'assistant' || firstResult.role !== 'tool') {
      throw new Error('unexpected message shape');
    }
    if (secondResult.role !== 'tool') throw new Error('unexpected message shape');
    const [firstCall, secondCall] = assistant.tool_calls ?? [];
    expect(firstCall.id).toMatch(VALID_ID);
    expect(firstCall.id).not.toBe('call:1/a b');
    expect(firstResult.tool_call_id).toBe(firstCall.id);
    expect(secondCall.id).toBe('call_2-ok');
    expect(secondResult.tool_call_id).toBe('call_2-ok');
  });

  it('normalizes tool call ids longer than 128 characters', () => {
    const maxLengthId = 'a'.repeat(128);
    const tooLongId = 'a'.repeat(129);
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: maxLengthId, type: 'function', function: { name: 'read', arguments: '{}' } },
              { id: tooLongId, type: 'function', function: { name: 'read', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: maxLengthId, content: 'one' },
          { role: 'tool', tool_call_id: tooLongId, content: 'two' },
        ],
      },
    };

    apply(request);

    const [assistant, firstResult, secondResult] = request.body.messages;
    if (assistant.role !== 'assistant' || firstResult.role !== 'tool') {
      throw new Error('unexpected message shape');
    }
    if (secondResult.role !== 'tool') throw new Error('unexpected message shape');
    const [firstCall, secondCall] = assistant.tool_calls ?? [];
    expect(firstCall.id).toBe(maxLengthId);
    expect(firstResult.tool_call_id).toBe(maxLengthId);
    expect(secondCall.id).toMatch(VALID_ID);
    expect(secondCall.id).not.toBe(tooLongId);
    expect(secondResult.tool_call_id).toBe(secondCall.id);
  });

  it('normalizes invalid responses call ids consistently', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        input: [
          { type: 'function_call', call_id: 'fc.1', name: 'read', arguments: '{}' },
          { type: 'function_call_output', call_id: 'fc.1', output: 'one' },
          { type: 'function_call', call_id: 'fc_2', name: 'read', arguments: '{}' },
          { type: 'function_call_output', call_id: 'fc_2', output: 'two' },
        ],
      } as GatewayResponsesRequest,
    };

    apply(request);

    const callIds = (request.body.input as Array<{ call_id: string }>).map(item => item.call_id);
    expect(callIds[0]).toMatch(VALID_ID);
    expect(callIds[0]).not.toBe('fc.1');
    expect(callIds[1]).toBe(callIds[0]);
    expect(callIds.slice(2)).toEqual(['fc_2', 'fc_2']);
  });

  it('normalizes invalid messages tool use ids consistently', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'functions.read:0', name: 'read', input: {} },
              { type: 'tool_use', id: 'toolu_ok', name: 'read', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'functions.read:0', content: 'one' },
              { type: 'tool_result', tool_use_id: 'toolu_ok', content: 'two' },
            ],
          },
        ],
      } as GatewayMessagesRequest,
    };

    apply(request);

    const [assistant, user] = request.body.messages;
    if (!Array.isArray(assistant.content) || !Array.isArray(user.content)) {
      throw new Error('unexpected message shape');
    }
    const [firstUse, secondUse] = assistant.content;
    const [firstResult, secondResult] = user.content;
    if (firstUse.type !== 'tool_use' || secondUse.type !== 'tool_use') {
      throw new Error('unexpected block shape');
    }
    if (firstResult.type !== 'tool_result' || secondResult.type !== 'tool_result') {
      throw new Error('unexpected block shape');
    }
    expect(firstUse.id).toMatch(VALID_ID);
    expect(firstUse.id).not.toBe('functions.read:0');
    expect(firstResult.tool_use_id).toBe(firstUse.id);
    expect(secondUse.id).toBe('toolu_ok');
    expect(secondResult.tool_use_id).toBe('toolu_ok');
  });
});

describe('applyAnthropicModelSettings tool call id normalization logging', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function chatRequest(toolCallIds: string[]): GatewayRequest {
    return {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: toolCallIds.map(id => ({
              id,
              type: 'function' as const,
              function: { name: 'read', arguments: '{}' },
            })),
          },
          ...toolCallIds.map(id => ({ role: 'tool' as const, tool_call_id: id, content: 'ok' })),
        ],
      },
    };
  }

  it('logs once per request with the number of distinct normalized ids', () => {
    apply(chatRequest(['call:1', 'call:2', 'call_ok']));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[normalizeToolCallIds] normalized tool call ids', {
      kind: 'chat_completions',
      model: 'anthropic/claude-sonnet-4.5',
      normalizedIdCount: 2,
      exampleId: 'call:1',
    });
  });

  it('truncates the example id', () => {
    apply(chatRequest(['a'.repeat(200)]));

    expect(warn).toHaveBeenCalledWith(
      '[normalizeToolCallIds] normalized tool call ids',
      expect.objectContaining({ normalizedIdCount: 1, exampleId: 'a'.repeat(64) })
    );
  });

  it('does not log when no ids need normalization', () => {
    apply(chatRequest(['call_1', 'toolu_2']));

    expect(warn).not.toHaveBeenCalled();
  });
});
