import { afterEach, describe, expect, it } from '@jest/globals';
import type Anthropic from '@anthropic-ai/sdk';
import { removeWhitespaceOnlyMessages } from '@kilocode/web-shared/lib/ai-gateway/providers/remove-whitespace-only-messages';
import type { GatewayMessagesRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

function makeBody(messages: Anthropic.MessageParam[]): GatewayMessagesRequest {
  return { model: 'anthropic/claude-opus-5.5', max_tokens: 1_024, messages };
}

const toolUse: Anthropic.ToolUseBlockParam = {
  type: 'tool_use',
  id: 'toolu_1',
  name: 'read',
  input: { path: 'a.txt' },
};

const toolResult: Anthropic.ToolResultBlockParam = {
  type: 'tool_result',
  tool_use_id: 'toolu_1',
  content: 'file contents',
};

const thinking: Anthropic.ThinkingBlockParam = {
  type: 'thinking',
  thinking: 'Considering the request.',
  signature: 'sig-1',
};

describe('removeWhitespaceOnlyMessages', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('removes a whitespace-only assistant turn and keeps whitespace text next to other blocks', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = makeBody([
      { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading.' }, { type: 'text', text: '\n\n' }, toolUse],
      },
      { role: 'user', content: [toolResult] },
      { role: 'assistant', content: [{ type: 'text', text: '\n\n' }] },
      { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
    ]);

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading.' }, { type: 'text', text: '\n\n' }, toolUse],
      },
      { role: 'user', content: [toolResult] },
      { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[removeWhitespaceOnlyMessages] removed whitespace-only messages',
      {
        model: 'anthropic/claude-opus-5.5',
        removedAssistantMessageCount: 1,
        removedUserMessageCount: 0,
      }
    );
  });

  it.each<[string, Anthropic.MessageParam['content']]>([
    ['whitespace string content', ' \n\t'],
    ['empty string content', ''],
    [
      'several whitespace text blocks',
      [
        { type: 'text', text: '\n\n' },
        { type: 'text', text: '  ' },
      ],
    ],
    ['an empty text block', [{ type: 'text', text: '' }]],
    ['empty content', []],
  ])('removes a non-final message with %s', (_label, content) => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = makeBody([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content },
      { role: 'assistant', content: 'Yes?' },
      { role: 'user', content: 'Say ok.' },
    ]);

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'assistant', content: 'Yes?' },
      { role: 'user', content: 'Say ok.' },
    ]);
  });

  it.each<[string, Anthropic.MessageParam]>([
    [
      'a thinking block',
      { role: 'assistant', content: [thinking, { type: 'text', text: '\n\n' }] },
    ],
    [
      'a redacted thinking block',
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: '\n\n' },
        ],
      },
    ],
    ['a tool use block', { role: 'assistant', content: [{ type: 'text', text: '\n\n' }, toolUse] }],
    [
      'a tool result block',
      { role: 'user', content: [toolResult, { type: 'text', text: '\n\n' }] },
    ],
    [
      'an image block',
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          { type: 'text', text: '\n\n' },
        ],
      },
    ],
  ])('keeps whitespace text that accompanies %s', (_label, message) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Hello' },
      message,
      { role: 'user', content: 'Say ok.' },
    ];
    const body = makeBody(structuredClone(messages));

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual(messages);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a whitespace-only final user message', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: [{ type: 'text', text: '\n\n' }] },
    ];
    const body = makeBody(structuredClone(messages));

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual(messages);
  });

  it('removes a whitespace-only final assistant prefill', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = makeBody([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: '\n\n' }] },
    ]);

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it.each<Anthropic.MessageParam['role']>(['user', 'assistant'])(
    'keeps a lone whitespace-only %s message',
    role => {
      const messages: Anthropic.MessageParam[] = [{ role, content: '\n\n' }];
      const body = makeBody(structuredClone(messages));

      removeWhitespaceOnlyMessages(body);

      expect(body.messages).toEqual(messages);
    }
  );

  it('removes a whitespace-only first message', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = makeBody([
      {
        role: 'user',
        content: [{ type: 'text', text: '\n', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Say ok.' },
    ]);

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual([
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Say ok.' },
    ]);
  });

  it('moves the cache breakpoint of a removed message to the last cacheable block before it', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = makeBody([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }, thinking] },
      {
        role: 'user',
        content: [{ type: 'text', text: '\n\n', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      },
      { role: 'user', content: 'Say ok.' },
    ]);

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual([
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi', cache_control: { type: 'ephemeral', ttl: '1h' } },
          thinking,
        ],
      },
      { role: 'user', content: 'Say ok.' },
    ]);
  });

  it('carries the cache breakpoint past consecutive removed messages onto string content', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = makeBody([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: '\n\n' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: ' ', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: 'Say ok.' },
    ]);

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: 'Say ok.' },
    ]);
  });

  it('keeps the existing cache breakpoint of the preceding message', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = makeBody([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '\n\n', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: 'Say ok.' },
    ]);

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      },
      { role: 'user', content: 'Say ok.' },
    ]);
  });

  it.each<Anthropic.MessageParam['content']>([
    'Hello',
    [{ type: 'text', text: 'Hello' }],
    [toolResult],
    [toolUse, thinking, { type: 'redacted_thinking', data: 'opaque' }],
  ])('does not mutate original history when moving a cache breakpoint onto %j', content => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '\n', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: 'Continue.' },
    ];
    const before = structuredClone(messages);
    const body = makeBody(messages);

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).not.toBe(messages[0]);
    expect(body.messages[1]).toBe(messages[2]);
    expect(messages).toEqual(before);
    if (Array.isArray(content)) {
      const targetIndex = content.findLastIndex(
        block => block.type !== 'thinking' && block.type !== 'redacted_thinking'
      );
      expect(body.messages[0].content).toEqual(
        content.map((block, index) =>
          index === targetIndex ? { ...block, cache_control: { type: 'ephemeral' } } : block
        )
      );
    } else {
      expect(body.messages[0].content).toEqual([
        { type: 'text', text: content, cache_control: { type: 'ephemeral' } },
      ]);
    }
  });

  it('does not attach a moved cache breakpoint to a thinking-only message', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const messages: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [thinking, { type: 'redacted_thinking', data: 'opaque' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '\n', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: 'Continue.' },
    ];
    const before = structuredClone(messages);
    const body = makeBody(messages);

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toEqual([before[0], before[2]]);
    expect(body.messages[0]).toBe(messages[0]);
    expect(messages).toEqual(before);
  });

  it('leaves a request without whitespace-only messages unchanged', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = makeBody([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: ' Hi ' }] },
      { role: 'user', content: 'Say ok.' },
    ]);
    const messages = body.messages;

    removeWhitespaceOnlyMessages(body);

    expect(body.messages).toBe(messages);
    expect(warn).not.toHaveBeenCalled();
  });
});
