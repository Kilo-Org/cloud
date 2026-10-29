import { describe, expect, it } from '@jest/globals';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { dropThinkingBlocksOnPrefixMismatch } from '@kilocode/web-shared/lib/ai-gateway/providers/thinking-block-binding';

type MessagesRequest = Extract<GatewayRequest, { kind: 'messages' }>;
type Thinking = MessagesRequest['body']['thinking'];

function apply(model: string, thinking: Thinking, extraHeaders: Record<string, string> = {}) {
  const request: MessagesRequest = {
    kind: 'messages',
    body: {
      model,
      max_tokens: 2_048,
      messages: [{ role: 'user', content: 'hello' }],
      ...(thinking && { thinking }),
    },
  };
  dropThinkingBlocksOnPrefixMismatch({ model, request, extraHeaders });
  return { body: request.body, extraHeaders };
}

describe('dropThinkingBlocksOnPrefixMismatch', () => {
  it.each([
    'anthropic/claude-opus-5.5',
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-haiku-5.5',
    'anthropic/claude-fable-5.1',
    'bedrock-byok/global.anthropic.claude-sonnet-5-5',
    'claude-haiku-5-5@20261005',
    'anthropic/claude-fable-5.2',
    'anthropic/claude-sonnet-5.6',
    'anthropic/claude-opus-6',
    'global.anthropic.claude-haiku-6-1-20270101-v1:0',
    'anthropic/claude-newfamily-6',
  ])('drops mismatched thinking blocks for %s', model => {
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

  it.each([{ prefix_mismatch_behavior: 'error' }, { mismatch_behavior: 'error' }] as const)(
    "keeps the caller's mismatch behavior %o",
    blockBinding => {
      const { body, extraHeaders } = apply('anthropic/claude-opus-5.5', {
        type: 'adaptive',
        block_binding: blockBinding,
      });

      expect(body.thinking).toEqual({ type: 'adaptive', block_binding: blockBinding });
      expect(extraHeaders['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01');
    }
  );

  it('fills in the mismatch behavior of an empty block_binding', () => {
    const { body } = apply('anthropic/claude-opus-5.5', { type: 'adaptive', block_binding: {} });

    expect(body.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
  });

  it.each([
    { name: 'enabled', thinking: { type: 'enabled', budget_tokens: 1_024 } },
    { name: 'disabled', thinking: { type: 'disabled' } },
    { name: 'absent', thinking: undefined },
  ] satisfies { name: string; thinking: Thinking }[])(
    'leaves $name thinking untouched',
    ({ thinking }) => {
      const { body, extraHeaders } = apply('anthropic/claude-opus-5.5', thinking);

      expect(body.thinking).toEqual(thinking);
      expect(extraHeaders).toEqual({});
    }
  );

  it.each([
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-5',
    'anthropic/claude-fable-5',
    'anthropic/claude-mythos-5.1',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'claude-sonnet-5@20260601',
    'anthropic/claude-3.5-sonnet',
    'openai/gpt-5.5',
  ])('leaves %s untouched', model => {
    const { body, extraHeaders } = apply(model, { type: 'adaptive' });

    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(extraHeaders).toEqual({});
  });

  it('leaves other APIs untouched', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'anthropic/claude-opus-5.5', messages: [{ role: 'user', content: 'hello' }] },
    };
    const extraHeaders = {};

    dropThinkingBlocksOnPrefixMismatch({
      model: 'anthropic/claude-opus-5.5',
      request,
      extraHeaders,
    });

    expect(request.body).toEqual({
      model: 'anthropic/claude-opus-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(extraHeaders).toEqual({});
  });
});
