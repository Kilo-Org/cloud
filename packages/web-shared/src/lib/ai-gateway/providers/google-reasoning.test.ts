import { describe, expect, it } from '@jest/globals';
import { applyGeminiReasoningRequestTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/google-reasoning';
import type { OpenRouterChatCompletionRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

/**
 * The transform writes `google`, `thoughtSignature` and `extra_content`, which the request types
 * do not declare, so fixture bodies are built as records. The single cast is the test boundary.
 */
function request(body: Record<string, unknown>): OpenRouterChatCompletionRequest {
  return {
    model: 'google/gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hello' }],
    ...body,
  } as OpenRouterChatCompletionRequest;
}

describe('applyGeminiReasoningRequestTransform thinking config', () => {
  it.each(['high', 'medium', 'low'])(
    'carries the %s effort into thinking_config and drops reasoning_effort',
    effort => {
      const body = request({ reasoning_effort: effort });

      applyGeminiReasoningRequestTransform(body);

      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).toMatchObject({
        google: {
          thinking_config: { thinking_level: effort, include_thoughts: true },
          thought_tag_marker: 'think',
        },
      });
    }
  );

  it('asks for thinking without a level when the request names no effort', () => {
    const body = request({});

    applyGeminiReasoningRequestTransform(body);

    expect(body).toMatchObject({
      google: { thinking_config: { include_thoughts: true }, thought_tag_marker: 'think' },
    });
    expect(body).not.toHaveProperty('google.thinking_config.thinking_level');
  });

  it('leaves google untouched when the effort is none', () => {
    const body = request({ reasoning_effort: 'none', google: { existing: true } });

    applyGeminiReasoningRequestTransform(body);

    // The legacy effort field still goes, but no thinking_config is built.
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).toMatchObject({ google: { existing: true } });
    expect(body).not.toHaveProperty('google.thinking_config');
  });

  it.each([
    [false, true],
    [undefined, true],
    [true, false],
  ])('adds the thought tag marker only without streaming (stream: %s)', (stream, tagged) => {
    const body = request({ reasoning_effort: 'high', stream });

    applyGeminiReasoningRequestTransform(body);

    expect(body).toMatchObject({
      google: tagged ? { thought_tag_marker: 'think' } : {},
    });
    if (!tagged) expect(body).not.toHaveProperty('google.thought_tag_marker');
  });

  it('keeps other google fields beside thinking_config', () => {
    const body = request({ reasoning_effort: 'high', google: { other: 'kept' } });

    applyGeminiReasoningRequestTransform(body);

    expect(body).toMatchObject({
      google: { other: 'kept', thinking_config: { thinking_level: 'high' } },
    });
  });
});

describe('applyGeminiReasoningRequestTransform thought signatures', () => {
  it('drops a legacy message signature without migrating it', () => {
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: 'hi',
      thoughtSignature: 'legacy',
    };
    const body = request({ messages: [message] });

    applyGeminiReasoningRequestTransform(body);

    // Only a tool call's legacy signature moves; a message-level one is discarded.
    expect(message).not.toHaveProperty('thoughtSignature');
    expect(message).not.toHaveProperty('extra_content');
  });

  it('moves a legacy tool-call signature and drops the legacy reasoning field', () => {
    const toolCall: Record<string, unknown> = {
      id: 'call-1',
      type: 'function',
      thoughtSignature: 'tool-sig',
    };
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: null,
      reasoning: 'legacy',
      tool_calls: [toolCall],
    };
    const body = request({ messages: [message] });

    applyGeminiReasoningRequestTransform(body);

    expect(message).not.toHaveProperty('reasoning');
    expect(toolCall).not.toHaveProperty('thoughtSignature');
    expect(toolCall).toMatchObject({
      extra_content: { google: { thought_signature: 'tool-sig' } },
    });
  });

  it('writes an encrypted detail on the tool call its id names', () => {
    const toolCall: Record<string, unknown> = {
      id: 'call-1',
      type: 'function',
      function: { name: 'lookup' },
    };
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall],
      reasoning_details: [
        {
          type: 'reasoning.encrypted',
          data: 'detail-sig',
          id: 'call-1',
          format: 'google-gemini-v1',
        },
      ],
    };
    const body = request({ messages: [message] });

    applyGeminiReasoningRequestTransform(body);

    expect(message).not.toHaveProperty('reasoning_details');
    expect(toolCall).toMatchObject({
      extra_content: { google: { thought_signature: 'detail-sig' } },
    });
    expect(message).not.toHaveProperty('extra_content');
  });

  it('falls back to the message when the detail names no tool call', () => {
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: null,
      reasoning_details: [
        { type: 'reasoning.encrypted', data: 'message-sig', format: 'google-gemini-v1' },
      ],
    };
    const body = request({ messages: [message] });

    applyGeminiReasoningRequestTransform(body);

    expect(message).toMatchObject({
      extra_content: { google: { thought_signature: 'message-sig' } },
    });
  });

  it('keeps the earliest tool call when one id appears twice', () => {
    const first: Record<string, unknown> = {
      id: 'call-1',
      type: 'function',
      function: { name: 'first' },
    };
    const second: Record<string, unknown> = {
      id: 'call-1',
      type: 'function',
      function: { name: 'second' },
    };
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: null,
      tool_calls: [first, second],
      reasoning_details: [
        { type: 'reasoning.encrypted', data: 'dup-sig', id: 'call-1', format: 'google-gemini-v1' },
      ],
    };
    const body = request({ messages: [message] });

    applyGeminiReasoningRequestTransform(body);

    expect(first).toMatchObject({ extra_content: { google: { thought_signature: 'dup-sig' } } });
    expect(second).not.toHaveProperty('extra_content');
  });

  it.each([
    [
      'a different format',
      { type: 'reasoning.encrypted', data: 'x', format: 'anthropic-claude-v1' },
    ],
    ['no data', { type: 'reasoning.encrypted', format: 'google-gemini-v1' }],
    ['a text detail', { type: 'reasoning.text', text: 'x', format: 'google-gemini-v1' }],
  ])('ignores a detail carrying %s', (_label, detail) => {
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: null,
      reasoning_details: [detail],
    };
    const body = request({ messages: [message] });

    applyGeminiReasoningRequestTransform(body);

    expect(message).not.toHaveProperty('extra_content');
    expect(message).not.toHaveProperty('reasoning_details');
  });
});
