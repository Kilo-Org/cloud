import { describe, expect, it } from '@jest/globals';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { dropThinkingBlocksOnPrefixMismatch } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/thinking-block-binding';

type MessagesRequest = Extract<GatewayRequest, { kind: 'messages' }>;
type Thinking = MessagesRequest['body']['thinking'];
type Messages = MessagesRequest['body']['messages'];

function apply(
  model: string,
  thinking: Thinking,
  extraHeaders: Record<string, string> = {},
  messages: Messages = [{ role: 'user', content: 'hello' }]
) {
  const request: MessagesRequest = {
    kind: 'messages',
    body: {
      model,
      max_tokens: 2_048,
      messages,
      ...(thinking && { thinking }),
    },
  };
  dropThinkingBlocksOnPrefixMismatch({ model, request, extraHeaders });
  return { body: request.body, extraHeaders };
}

function historicalMessages(): Messages {
  return [
    { role: 'user', content: 'Keep the literal words thinking and redacted_thinking.' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Use the tool.', signature: 'FAKE_UNIT_TEST_SIGNATURE_1' },
        { type: 'thinking', thinking: '', signature: 'FAKE_UNIT_TEST_EMPTY_THINKING_SIGNATURE' },
        { type: 'redacted_thinking', data: 'FAKE_UNIT_TEST_REDACTED_DATA_1' },
        { type: 'text', text: 'Reading the file.', cache_control: { type: 'ephemeral' } },
        {
          type: 'tool_use',
          id: 'toolu_unit_test',
          name: 'read',
          input: { type: 'thinking', nested: { type: 'redacted_thinking', data: 'tool input' } },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_unit_test',
          content: [
            {
              type: 'text',
              text: '{"type":"thinking","signature":"FAKE_TOOL_RESULT_DATA"}',
              cache_control: { type: 'ephemeral' },
            },
          ],
          is_error: false,
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Done.', signature: 'FAKE_UNIT_TEST_SIGNATURE_2' },
        { type: 'redacted_thinking', data: 'FAKE_UNIT_TEST_REDACTED_DATA_2' },
        { type: 'text', text: 'The result is ready.' },
      ],
    },
    { role: 'user', content: 'Continue.' },
    { role: 'assistant', content: 'This string assistant message must remain unchanged.' },
    { role: 'user', content: [{ type: 'text', text: 'Next turn.' }] },
  ];
}

const eligibleModels = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-fable-5.1',
  'bedrock-byok/global.anthropic.claude-sonnet-5-5',
  'claude-haiku-5-5@20261005',
  'anthropic/claude-fable-5.2',
  'anthropic/claude-sonnet-5.6',
  'anthropic/claude-opus-5.3',
  'anthropic/claude-opus-6',
  'global.anthropic.claude-haiku-6-1-20270101-v1:0',
  'anthropic/claude-newfamily-6',
  'anthropic/claude-opus-latest',
  '~anthropic/claude-sonnet-latest',
  'bedrock-byok/global.anthropic.claude-sonnet-latest',
  'vertex-byok/claude-sonnet-latest',
];

describe('dropThinkingBlocksOnPrefixMismatch', () => {
  it.each(eligibleModels)('drops mismatched thinking blocks for %s', model => {
    const { body, extraHeaders } = apply(model, { type: 'adaptive' });

    expect(body.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(extraHeaders).toEqual({
      'anthropic-beta': 'thinking-binding-controls-2026-08-01',
      'x-anthropic-beta': 'thinking-binding-controls-2026-08-01',
    });
  });

  it('appends the beta flag to existing ones', () => {
    const { extraHeaders } = apply(
      'anthropic/claude-opus-5.5',
      { type: 'adaptive' },
      {
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
        'x-anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      }
    );

    expect(extraHeaders['anthropic-beta']).toBe(
      'fine-grained-tool-streaming-2025-05-14,thinking-binding-controls-2026-08-01'
    );
    expect(extraHeaders['x-anthropic-beta']).toBe(
      'fine-grained-tool-streaming-2025-05-14,thinking-binding-controls-2026-08-01'
    );
  });

  it.each([
    { prefix_mismatch_behavior: 'error' },
    { prefix_mismatch_behavior: 'drop_block' },
    { mismatch_behavior: 'error' },
    { mismatch_behavior: 'drop_block' },
  ] as const)("keeps the caller's mismatch behavior %o", blockBinding => {
    const { body, extraHeaders } = apply('anthropic/claude-opus-5.5', {
      type: 'adaptive',
      block_binding: blockBinding,
    });

    expect(body.thinking).toEqual({ type: 'adaptive', block_binding: blockBinding });
    expect(extraHeaders['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01');
  });

  it('fills in the mismatch behavior of an empty block_binding', () => {
    const { body } = apply('anthropic/claude-opus-5.5', { type: 'adaptive', block_binding: {} });

    expect(body.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
  });

  it.each(eligibleModels)('normalizes omitted thinking to adaptive for %s', model => {
    const messages = historicalMessages();
    const { body, extraHeaders } = apply(model, undefined, {}, messages);

    expect(body.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(body.messages).toBe(messages);
    expect(extraHeaders).toEqual({
      'anthropic-beta': 'thinking-binding-controls-2026-08-01',
      'x-anthropic-beta': 'thinking-binding-controls-2026-08-01',
    });
  });

  it('keeps complete adaptive thinking history for upstream prefix validation', () => {
    const messages = historicalMessages();
    const before = structuredClone(messages);
    const { body } = apply('anthropic/claude-opus-5.5', { type: 'adaptive' }, {}, messages);

    expect(body.messages).toBe(messages);
    expect(body.messages).toEqual(before);
  });

  // The SDK predates this upstream mode; the runtime branch must still handle it.
  const betweenTools = { type: 'between_tools' };
  it.each([
    { name: 'enabled', thinking: { type: 'enabled', budget_tokens: 1_024 } },
    { name: 'disabled', thinking: { type: 'disabled' } },
    { name: 'between_tools', thinking: betweenTools as Thinking },
  ] satisfies { name: string; thinking: Thinking }[])(
    'strips historical thinking for explicit $name without changing its configuration',
    ({ thinking }) => {
      const messages = historicalMessages();
      const before = structuredClone(messages);
      const { body, extraHeaders } = apply('anthropic/claude-opus-5.5', thinking, {}, messages);

      expect(body.thinking).toBe(thinking);
      expect(body.messages).toEqual([
        before[0],
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading the file.', cache_control: { type: 'ephemeral' } },
            {
              type: 'tool_use',
              id: 'toolu_unit_test',
              name: 'read',
              input: {
                type: 'thinking',
                nested: { type: 'redacted_thinking', data: 'tool input' },
              },
            },
          ],
        },
        before[2],
        { role: 'assistant', content: [{ type: 'text', text: 'The result is ready.' }] },
        ...before.slice(4),
      ]);
      expect(messages).toEqual(before);
      expect(extraHeaders).toEqual({
        'anthropic-beta': 'thinking-binding-controls-2026-08-01',
        'x-anthropic-beta': 'thinking-binding-controls-2026-08-01',
      });
    }
  );

  it.each(eligibleModels)('strips disabled thinking history for %s', model => {
    const { body } = apply(model, { type: 'disabled' }, {}, [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'FAKE_UNIT_TEST_SIGNATURE' },
          { type: 'redacted_thinking', data: 'FAKE_UNIT_TEST_REDACTED_DATA' },
          { type: 'text', text: 'hello' },
        ],
      },
    ]);

    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('removes assistant turns made empty by stripping thinking and redacted thinking', () => {
    const { body } = apply('anthropic/claude-opus-5.5', { type: 'disabled' }, {}, [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'FAKE_UNIT_TEST_SIGNATURE' }],
      },
      { role: 'user', content: 'continue' },
      {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: 'FAKE_UNIT_TEST_REDACTED_DATA' }],
      },
      { role: 'user', content: 'again' },
    ]);

    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'continue' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('does not strip user content blocks', () => {
    const messages: Messages = [
      {
        role: 'user',
        content: [
          { type: 'thinking', thinking: 'user data', signature: 'FAKE_USER_DATA_SIGNATURE' },
          { type: 'redacted_thinking', data: 'FAKE_USER_DATA' },
          { type: 'text', text: 'Keep these blocks.' },
        ],
      },
    ];
    const { body } = apply('anthropic/claude-opus-5.5', { type: 'disabled' }, {}, messages);

    expect(body.messages).toEqual(messages);
    expect(body.messages[0]).toBe(messages[0]);
  });

  it.each(['', '\n\n', ' \t '])(
    'removes assistant turns whose remaining text is only whitespace: %j',
    text => {
      const { body } = apply('anthropic/claude-haiku-5.5', { type: 'disabled' }, {}, [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'FAKE_UNIT_TEST_SIGNATURE' },
            { type: 'text', text },
          ],
        },
        { role: 'user', content: 'continue' },
      ]);

      expect(body.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'continue' },
      ]);
    }
  );

  it('keeps whitespace text alongside a tool call after removing thinking', () => {
    const toolCall = {
      type: 'tool_use',
      id: 'toolu_unit_test',
      name: 'read',
      input: {},
    } as const;
    const { body } = apply('anthropic/claude-haiku-5.5', { type: 'disabled' }, {}, [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'FAKE_UNIT_TEST_SIGNATURE' },
          { type: 'text', text: '\n\n' },
          toolCall,
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: 'ok' }] },
    ]);

    expect(body.messages[1].content).toEqual([{ type: 'text', text: '\n\n' }, toolCall]);
    expect(body.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: toolCall.id, content: 'ok' },
    ]);
  });

  it('leaves malformed non-array content for upstream request validation', () => {
    const malformed = { role: 'assistant', content: null } as unknown as Messages[number];
    const { body } = apply('anthropic/claude-haiku-5.5', { type: 'disabled' }, {}, [malformed]);

    expect(body.messages).toEqual([malformed]);
  });

  it.each([
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-5',
    'anthropic/claude-fable-5',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'claude-sonnet-5@20260601',
    'anthropic/claude-3.5-sonnet',
    'openai/gpt-5.5',
    'openai/gpt-5.5-latest',
    'vendor/model-latest',
  ])('leaves all thinking modes and history untouched for %s', model => {
    for (const thinking of [
      { type: 'adaptive' },
      { type: 'enabled', budget_tokens: 1_024 },
      { type: 'disabled' },
      undefined,
    ] satisfies Thinking[]) {
      const messages = historicalMessages();
      const before = structuredClone(messages);
      const { body, extraHeaders } = apply(model, thinking, {}, messages);

      expect(body.thinking).toEqual(thinking);
      expect(body.messages).toBe(messages);
      expect(body.messages).toEqual(before);
      expect(extraHeaders).toEqual({});
    }
  });

  it.each([
    {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-opus-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'disabled' },
      },
    },
    {
      kind: 'responses',
      body: {
        model: 'anthropic/claude-opus-5.5',
        input: 'hello',
        thinking: { type: 'disabled' },
      },
    },
  ] satisfies GatewayRequest[])('leaves $kind untouched', request => {
    const before = structuredClone(request.body);
    const extraHeaders = {};

    dropThinkingBlocksOnPrefixMismatch({
      model: 'anthropic/claude-opus-5.5',
      request,
      extraHeaders,
    });

    expect(request.body).toEqual(before);
    expect(extraHeaders).toEqual({});
  });
});
