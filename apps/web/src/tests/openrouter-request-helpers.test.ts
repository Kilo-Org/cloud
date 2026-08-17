import { describe, expect, test } from '@jest/globals';
import { addCacheBreakpoints } from '@/lib/ai-gateway/providers/openrouter/request-helpers';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
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

  test('adds a cache breakpoint before environment details in a chat completions user message', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'test-model',
        messages: [
          { role: 'user', content: 'First prompt' },
          { role: 'assistant', content: 'First response' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Latest prompt' },
              { type: 'text', text: '<environment_details>dynamic context' },
            ],
          },
          { role: 'assistant', content: 'Latest response' },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.messages.at(-2)?.content).toEqual([
      { type: 'text', text: 'Latest prompt', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<environment_details>dynamic context' },
    ]);
  });

  test('adds a cache breakpoint before environment details in a single chat completions user message', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'test-model',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Build snake in plain JS' },
              { type: 'text', text: '<environment_details>dynamic context' },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.messages.at(0)?.content).toEqual([
      { type: 'text', text: 'Build snake in plain JS', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<environment_details>dynamic context' },
    ]);
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
      prompt_cache_breakpoint: { mode: 'explicit' },
    });

    const lastItem = request.body.input.at(-1);
    expect(lastItem).toMatchObject({
      type: 'function_call_output',
      output: [
        { type: 'input_text', text: 'Tool output' },
        {
          type: 'input_text',
          text: 'Tool detail',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ],
    });
  });

  test('adds a cache breakpoint to the last responses instructions message', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'test-model',
        input: [
          { type: 'message', role: 'system', content: 'You are helpful.' },
          { type: 'message', role: 'developer', content: 'Be concise.' },
          { type: 'message', role: 'user', content: 'Latest prompt' },
        ],
      },
    };

    addCacheBreakpoints(request);

    if (request.kind !== 'responses' || !Array.isArray(request.body.input)) return;
    expect(request.body.input.at(0)).toMatchObject({
      type: 'message',
      role: 'system',
      content: 'You are helpful.',
    });
    expect(request.body.input.at(1)).toMatchObject({
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'Be concise.',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ],
    });
  });

  test('does nothing for responses requests when any prompt_cache_breakpoint is already present', () => {
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
                prompt_cache_breakpoint: { mode: 'explicit' },
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

  test('adds a cache breakpoint before environment details in a responses user message', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'test-model',
        input: [
          { type: 'message', role: 'user', content: 'First prompt' },
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Latest prompt' },
              { type: 'input_text', text: '<environment_details>dynamic context' },
            ],
          },
          {
            type: 'function_call',
            call_id: 'call_123',
            name: 'get_context',
            arguments: '{}',
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    if (request.kind !== 'responses' || !Array.isArray(request.body.input)) return;
    const userMessage = request.body.input.at(-2);
    expect(userMessage).toMatchObject({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'Latest prompt',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
        { type: 'input_text', text: '<environment_details>dynamic context' },
      ],
    });
  });

  test('adds a cache breakpoint before environment details in a single responses user message', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'test-model',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Build snake in plain JS' },
              { type: 'input_text', text: '<environment_details>dynamic context' },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    if (request.kind !== 'responses' || !Array.isArray(request.body.input)) return;
    expect(request.body.input.at(0)).toMatchObject({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'Build snake in plain JS',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
        { type: 'input_text', text: '<environment_details>dynamic context' },
      ],
    });
  });

  test('adds cache_control to the system prompt and last content block of a messages request', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        system: 'You are helpful.',
        messages: [
          { role: 'user', content: 'First prompt' },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Latest prompt' },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.cache_control).toBeUndefined();
    expect(request.body.system).toEqual([
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(request.body.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'Latest prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  test('adds cache_control to the last block of a messages system prompt', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        system: [
          { type: 'text', text: 'You are helpful.' },
          { type: 'text', text: 'Be concise.' },
        ],
        messages: [{ role: 'user', content: 'Latest prompt' }],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.system).toEqual([
      { type: 'text', text: 'You are helpful.' },
      { type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  test('adds nested cache_control when an unhonored top-level value is present', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        cache_control: { type: 'ephemeral', ttl: '1h' },
        messages: [
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

    expect(request.body.cache_control).toBeUndefined();
    expect(request.body.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'Latest prompt' },
      {
        type: 'text',
        text: 'Latest detail',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
  });

  test('adds cache_control before environment details in a messages user message', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'First prompt' },
          { role: 'assistant', content: 'First response' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Latest prompt' },
              { type: 'text', text: '<environment_details>dynamic context' },
            ],
          },
          { role: 'assistant', content: '' },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.messages.at(-2)?.content).toEqual([
      { type: 'text', text: 'Latest prompt', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<environment_details>dynamic context' },
    ]);
  });

  test('adds cache_control before environment details in a single messages user message', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Build snake in plain JS' },
              { type: 'text', text: '<environment_details>dynamic context' },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.messages.at(0)?.content).toEqual([
      { type: 'text', text: 'Build snake in plain JS', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<environment_details>dynamic context' },
    ]);
  });

  test('adds cache_control to the last cacheable content block', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Prompt' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Response' },
              { type: 'thinking', thinking: 'Reasoning', signature: 'signature' },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'Response', cache_control: { type: 'ephemeral' } },
      { type: 'thinking', thinking: 'Reasoning', signature: 'signature' },
    ]);
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

  test('does nothing for messages requests when the system prompt has cache_control', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: 'You are helpful.',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'Latest prompt' }],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.messages.at(-1)?.content).toBe('Latest prompt');
  });
});
