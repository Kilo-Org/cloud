import { describe, expect, test } from '@jest/globals';
import { addCacheBreakpoints } from '@/lib/providers/openrouter/request-helpers';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';
import type OpenAI from 'openai';

describe('addCacheBreakpoints', () => {
  test('adds a cache breakpoint to the system message and the last eligible chat completions message when none exist', () => {
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

    const systemContent = request.body.messages.at(0)?.content;
    expect(Array.isArray(systemContent)).toBe(true);
    if (!Array.isArray(systemContent)) return;
    expect(systemContent.at(-1)).toMatchObject({
      type: 'text',
      text: 'You are helpful.',
      cache_control: { type: 'ephemeral' },
    });

    const lastContent = request.body.messages.at(-1)?.content;
    expect(Array.isArray(lastContent)).toBe(true);
    if (!Array.isArray(lastContent)) return;
    expect(lastContent.at(-1)).toMatchObject({
      type: 'text',
      text: 'Latest detail',
      cache_control: { type: 'ephemeral' },
    });
  });

  test('adds a cache breakpoint to the last eligible chat completions message when there is no system message', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'test-model',
        messages: [
          { role: 'user', content: 'First prompt' },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Latest prompt' },
        ],
      },
    };

    addCacheBreakpoints(request);

    const lastContent = request.body.messages.at(-1)?.content;
    expect(Array.isArray(lastContent)).toBe(true);
    if (!Array.isArray(lastContent)) return;
    expect(lastContent.at(-1)).toMatchObject({
      type: 'text',
      text: 'Latest prompt',
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
            content: [
              {
                type: 'text',
                text: 'First prompt',
                cache_control: { type: 'ephemeral' },
              } as OpenAI.ChatCompletionContentPartText,
            ],
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

    const lastContent =
      request.kind === 'chat_completions' && request.body.messages.at(-1)?.content;
    expect(lastContent).toEqual([
      { type: 'text', text: 'Latest prompt' },
      { type: 'text', text: 'Latest detail' },
    ]);
  });

  test('adds a cache breakpoint to the system message and the last eligible responses message when none exist', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'test-model',
        input: [
          {
            type: 'message',
            role: 'system',
            content: 'You are helpful.',
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First prompt' }],
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

    if (request.kind !== 'responses' || !Array.isArray(request.body.input)) return;
    const systemMessage = request.body.input.at(0);
    expect(systemMessage).toMatchObject({ type: 'message', role: 'system' });
    if (!systemMessage || systemMessage.type !== 'message') return;
    const systemContent = systemMessage.content;
    expect(Array.isArray(systemContent)).toBe(true);
    if (!Array.isArray(systemContent)) return;
    expect(systemContent.at(-1)).toMatchObject({
      type: 'input_text',
      text: 'You are helpful.',
      cache_control: { type: 'ephemeral' },
    });

    const lastItem = request.body.input.at(-1);
    expect(lastItem).toMatchObject({
      type: 'function_call_output',
      output: [
        { type: 'input_text', text: 'Tool output' },
        { type: 'input_text', text: 'Tool detail', cache_control: { type: 'ephemeral' } },
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
            content: [
              {
                type: 'input_text',
                text: 'First prompt',
                // @ts-expect-error non-standard cache_control extension
                cache_control: { type: 'ephemeral' },
              },
            ],
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

    const lastItem = request.kind === 'responses' && request.body.input?.at(-1);
    expect(lastItem).toMatchObject({
      type: 'function_call_output',
      output: [
        { type: 'input_text', text: 'Tool output' },
        { type: 'input_text', text: 'Tool detail' },
      ],
    });
  });

  test('adds top-level cache_control on messages request when none is present', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'First prompt' },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Latest prompt' },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('does nothing for messages request when any cache_control is already present', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'First prompt',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Latest prompt' },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.cache_control).toBeUndefined();
  });
});
