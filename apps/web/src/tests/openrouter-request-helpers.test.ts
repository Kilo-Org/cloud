import { describe, expect, test } from '@jest/globals';
import {
  addCacheBreakpoints,
  removeCacheBreakpoints,
} from '@/lib/ai-gateway/providers/openrouter/request-helpers';
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

  test('adds a cache breakpoint before environment_details when the last message is a user message with multiple parts in chat completions', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'test-model',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'assistant', content: 'First response' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Main task instruction' },
              { type: 'text', text: '<environment_details>\nOS: Linux\n</environment_details>' },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    const userContent = request.body.messages.at(2)?.content;
    expect(Array.isArray(userContent)).toBe(true);
    if (!Array.isArray(userContent)) return;
    expect(userContent).toEqual([
      {
        type: 'text',
        text: 'Main task instruction',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: '<environment_details>\nOS: Linux\n</environment_details>',
      },
    ]);
  });

  test('adds a cache breakpoint before environment_details on the last message in multi-turn chat completions', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'test-model',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Turn 1 prompt' },
              { type: 'text', text: '<environment_details>\nTurn 1 env\n</environment_details>' },
            ],
          },
          { role: 'assistant', content: 'Turn 1 response' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Turn 2 prompt part 1' },
              { type: 'text', text: 'Turn 2 prompt part 2' },
              { type: 'text', text: '<environment_details>\nTurn 2 env\n</environment_details>' },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    const turn1Content = request.body.messages.at(1)?.content;
    expect(turn1Content).toEqual([
      { type: 'text', text: 'Turn 1 prompt' },
      { type: 'text', text: '<environment_details>\nTurn 1 env\n</environment_details>' },
    ]);

    const turn2Content = request.body.messages.at(3)?.content;
    expect(turn2Content).toEqual([
      { type: 'text', text: 'Turn 2 prompt part 1' },
      {
        type: 'text',
        text: 'Turn 2 prompt part 2',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: '<environment_details>\nTurn 2 env\n</environment_details>',
      },
    ]);
  });

  test('adds a cache breakpoint at the end when the last message is a tool message even if previous user message had environment_details', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'test-model',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'User prompt' },
              { type: 'text', text: '<environment_details>\nOS: Linux\n</environment_details>' },
            ],
          },
          { role: 'assistant', content: 'Calling tool' },
          { role: 'tool', content: 'Tool output' },
        ],
      },
    };

    addCacheBreakpoints(request);

    const userContent = request.body.messages.at(1)?.content;
    expect(userContent).toEqual([
      { type: 'text', text: 'User prompt' },
      { type: 'text', text: '<environment_details>\nOS: Linux\n</environment_details>' },
    ]);

    const toolContent = request.body.messages.at(3)?.content;
    expect(toolContent).toEqual([
      { type: 'text', text: 'Tool output', cache_control: { type: 'ephemeral' } },
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

  test('adds a prompt_cache_breakpoint to the system message and the last eligible responses message with mode implicit', () => {
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
    expect(request.body.prompt_cache_options).toEqual({ mode: 'implicit' });

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
        { type: 'input_text', text: 'Tool detail', prompt_cache_breakpoint: { mode: 'explicit' } },
      ],
    });
  });

  test('adds a prompt_cache_breakpoint before environment_details when the last message is a user message with multiple parts in responses', () => {
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
            content: [
              { type: 'input_text', text: 'Main user instructions' },
              {
                type: 'input_text',
                text: '<environment_details>\nCurrent time: 2026-08-08\n</environment_details>',
              },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    if (request.kind !== 'responses' || !Array.isArray(request.body.input)) return;
    expect(request.body.prompt_cache_options).toEqual({ mode: 'implicit' });

    const userMessage = request.body.input.at(1);
    expect(userMessage).toMatchObject({ type: 'message', role: 'user' });
    if (!userMessage || userMessage.type !== 'message') return;
    expect(userMessage.content).toEqual([
      {
        type: 'input_text',
        text: 'Main user instructions',
        prompt_cache_breakpoint: { mode: 'explicit' },
      },
      {
        type: 'input_text',
        text: '<environment_details>\nCurrent time: 2026-08-08\n</environment_details>',
      },
    ]);
  });

  test('does nothing for responses requests when prompt_cache_options is already present', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'test-model',
        prompt_cache_options: { mode: 'explicit' },
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First prompt' }],
          },
          {
            type: 'function_call_output',
            call_id: 'call_123',
            output: [{ type: 'input_text', text: 'Tool output' }],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.prompt_cache_options).toEqual({ mode: 'explicit' });
    const userMessage = request.body.input.at(0);
    if (userMessage && userMessage.type === 'message' && Array.isArray(userMessage.content)) {
      expect(userMessage.content[0]).toEqual({ type: 'input_text', text: 'First prompt' });
    }
  });

  test('does nothing for responses requests when any prompt_cache_breakpoint or cache_control is already present', () => {
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

    expect(request.body.prompt_cache_options).toBeUndefined();
    const lastItem = request.kind === 'responses' && request.body.input?.at(-1);
    expect(lastItem).toMatchObject({
      type: 'function_call_output',
      output: [
        { type: 'input_text', text: 'Tool output' },
        { type: 'input_text', text: 'Tool detail' },
      ],
    });
  });

  test('adds cache_control to the last content block of a messages request', () => {
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

    expect(request.body.cache_control).toBeUndefined();
    expect(request.body.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'Latest prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  test('adds a cache breakpoint before environment_details when the last message is a user message with multiple parts in messages', () => {
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
              { type: 'text', text: 'Latest instructions' },
              {
                type: 'text',
                text: '<environment_details>\nWorking directory: /workspace\n</environment_details>',
              },
            ],
          },
        ],
      },
    };

    addCacheBreakpoints(request);

    expect(request.body.cache_control).toBeUndefined();
    expect(request.body.messages.at(-1)?.content).toEqual([
      {
        type: 'text',
        text: 'Latest instructions',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: '<environment_details>\nWorking directory: /workspace\n</environment_details>',
      },
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
});

describe('removeCacheBreakpoints', () => {
  test('removes all cache breakpoints added to a chat completions request', () => {
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
    expect(containsCacheControlDeep(request.body.messages)).toBe(true);

    removeCacheBreakpoints(request);

    expect(containsCacheControlDeep(request.body.messages)).toBe(false);
  });

  test('removes all cache breakpoints and prompt_cache_options added to a responses request', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'test-model',
        input: [
          { type: 'message', role: 'system', content: 'You are helpful.' },
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
    expect(containsCacheControlDeep(request.body)).toBe(true);

    removeCacheBreakpoints(request);

    expect(containsCacheControlDeep(request.body)).toBe(false);
    expect(request.body.prompt_cache_options).toBeUndefined();
  });

  test('removes top-level and nested cache_control from a messages request', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-sonnet-4-5',
        max_tokens: 1024,
        cache_control: { type: 'ephemeral' },
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

    removeCacheBreakpoints(request);

    expect(request.body.cache_control).toBeUndefined();
    expect(containsCacheControlDeep(request.body.messages)).toBe(false);
  });
});

function containsCacheControlDeep(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCacheControlDeep);
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (
    Object.hasOwn(value, 'cache_control') ||
    Object.hasOwn(value, 'prompt_cache_breakpoint') ||
    Object.hasOwn(value, 'prompt_cache_options')
  ) {
    return true;
  }
  return Object.values(value).some(containsCacheControlDeep);
}
