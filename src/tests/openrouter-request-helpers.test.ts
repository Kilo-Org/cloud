import { describe, expect, test } from '@jest/globals';
import { addCacheBreakpoints } from '@/lib/providers/openrouter/request-helpers';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';

describe('addCacheBreakpoints', () => {
  test('adds a cache breakpoint to the last eligible chat completions message when none exist', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'test-model',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'First prompt' },
          { role: 'assistant', content: 'First response' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Latest prompt' },
              { type: 'text', text: 'Latest detail' },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    const lastMessage = request.body.messages.at(-1);
    expect(Array.isArray(lastMessage?.content)).toBe(true);
    expect(lastMessage?.content.at(-1)).toMatchObject({
      type: 'text',
      text: 'Latest detail',
      cache_control: { type: 'ephemeral' },
    });
  });

  test('does nothing for chat completions requests when any cache_control is already present', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'test-model',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          {
            role: 'user',
            content: [{ type: 'text', text: 'First prompt', cache_control: { type: 'ephemeral' } }],
          },
          { role: 'assistant', content: 'First response' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Latest prompt' },
              { type: 'text', text: 'Latest detail' },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    const lastMessage = request.body.messages.at(-1);
    expect(lastMessage).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Latest prompt' },
        { type: 'text', text: 'Latest detail' },
      ],
    });
  });

  test('does nothing for responses requests when any cache_control is already present', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'test-model',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First prompt', cache_control: { type: 'ephemeral' } }],
          },
          {
            type: 'function_call_output',
            call_id: 'call_123',
            output: [
              { type: 'input_text', text: 'Tool output' },
              { type: 'input_text', text: 'Tool detail' },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    const lastItem = request.body.input.at(-1);
    expect(lastItem).toMatchObject({
      type: 'function_call_output',
      output: [
        { type: 'input_text', text: 'Tool output' },
        { type: 'input_text', text: 'Tool detail' },
      ],
    });
  });
});
