import { describe, it, expect } from '@jest/globals';
import { detectContextOverflow, estimateTokenCount } from './context-overflow';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { minimax_m25_free_model } from '@/lib/ai-gateway/providers/minimax';
import { ProxyErrorType } from '@/lib/proxy-error-types';

function chatRequest(body: OpenRouterChatCompletionRequest): GatewayRequest {
  return { kind: 'chat_completions', body };
}

describe('estimateTokenCount', () => {
  it('counts only text content, not JSON keys and punctuation', () => {
    const request = chatRequest({
      model: 'foo',
      messages: [{ role: 'user', content: 'hello world' }],
    });

    // 'foo' (3) + 'user' (4) + 'hello world' (11) = 18 chars / 4 = 4.5 → rounded to 5
    expect(estimateTokenCount(request)).toBe(5);
  });

  it('adds max_tokens to the estimate', () => {
    const request = chatRequest({
      model: '',
      messages: [{ role: 'user', content: 'x'.repeat(400) }],
      max_tokens: 1000,
    });

    // 400 chars from content + 4 chars from 'user' = 404 / 4 = 101, plus 1000 reserved.
    expect(estimateTokenCount(request)).toBe(1101);
  });

  it('recurses into nested structures like tool definitions', () => {
    const request = chatRequest({
      model: '',
      messages: [],
      tools: [
        {
          type: 'function',
          function: { name: 'do_thing', description: 'x'.repeat(100) },
        },
      ],
    });

    // 'function' (8) + 'do_thing' (8) + 'x' * 100 = 116 / 4 = 29
    expect(estimateTokenCount(request)).toBe(29);
  });
});

describe('detectContextOverflow', () => {
  const emptyRequest: GatewayRequest = chatRequest({ model: 'test', messages: [] });

  it('returns null for responses that do not indicate a context overflow', async () => {
    const response = new Response('some unrelated 400', { status: 400 });
    const result = await detectContextOverflow({
      requestedModel: 'anything',
      request: emptyRequest,
      response,
    });
    expect(result).toBeNull();
  });

  it('passes through the upstream context-length error message verbatim', async () => {
    const upstreamMessage =
      "This endpoint's maximum context length is 204800 tokens. However, you requested about 301688 tokens (124054 of text input, 145634 of tool input, 32000 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.";
    const response = new Response(JSON.stringify({ error: { message: upstreamMessage } }), {
      status: 400,
    });

    const result = await detectContextOverflow({
      requestedModel: 'some-unknown-model',
      request: emptyRequest,
      response,
    });

    if (!result) throw new Error('expected a response');
    const json = await result.json();
    expect(json.error_type).toBe(ProxyErrorType.context_length_exceeded);
    // Upstream body is passed through verbatim at the top level; we only
    // attach `error_type` alongside the original `error` field.
    expect(json.error).toEqual({ message: upstreamMessage });
    expect(json.message).toBeUndefined();
  });

  it('preserves unrelated top-level fields from the upstream body', async () => {
    const upstreamMessage = "maximum context length is 128000 tokens. That's too many.";
    const response = new Response(
      JSON.stringify({ error: { message: upstreamMessage, code: 'ctx_overflow' }, foo: 42 }),
      { status: 400 }
    );

    const result = await detectContextOverflow({
      requestedModel: 'some-unknown-model',
      request: emptyRequest,
      response,
    });

    if (!result) throw new Error('expected a response');
    const json = await result.json();
    expect(json).toEqual({
      error: { message: upstreamMessage, code: 'ctx_overflow' },
      foo: 42,
      error_type: ProxyErrorType.context_length_exceeded,
    });
  });

  it('leaves unknown-shape JSON bodies alone', async () => {
    // Valid JSON but no recognized error field — we intentionally do not
    // rewrite, even though the raw text contains the overflow phrase.
    const response = new Response(
      JSON.stringify({ detail: 'maximum context length is 128 tokens exceeded' }),
      { status: 400 }
    );

    const result = await detectContextOverflow({
      requestedModel: 'some-unknown-model',
      request: emptyRequest,
      response,
    });

    expect(result).toBeNull();
  });

  it('leaves plain-text upstream bodies alone', async () => {
    // Only JSON bodies are rewritten; a plain-text body is forwarded as-is
    // by the caller so we return null here.
    const response = new Response('maximum context length is 128 tokens exceeded.', {
      status: 400,
    });

    const result = await detectContextOverflow({
      requestedModel: 'some-unknown-model',
      request: emptyRequest,
      response,
    });

    expect(result).toBeNull();
  });

  it('also recognizes overflow messages where upstream.error is a plain string', async () => {
    const upstreamMessage = 'This endpoint maximum context length is 128000 tokens. too much.';
    const response = new Response(JSON.stringify({ error: upstreamMessage }), { status: 400 });

    const result = await detectContextOverflow({
      requestedModel: 'some-unknown-model',
      request: emptyRequest,
      response,
    });

    if (!result) throw new Error('expected a response');
    const json = await result.json();
    expect(json.error_type).toBe(ProxyErrorType.context_length_exceeded);
    expect(json.error).toBe(upstreamMessage);
    expect(json.message).toBeUndefined();
  });

  it('triggers on a generic 500 when our estimate exceeds the window', async () => {
    // minimax_m25_free_model has context_length 204_800 and max_completion_tokens 131_072.
    // Provide enough text so the estimate (text/4 + max_tokens) exceeds the window.
    const hugeRequest = chatRequest({
      model: minimax_m25_free_model.public_id,
      messages: [{ role: 'user', content: 'x'.repeat(400_000) }],
      max_tokens: 131_072,
    });

    const result = await detectContextOverflow({
      requestedModel: minimax_m25_free_model.public_id,
      request: hugeRequest,
      response: new Response('Internal Server Error', { status: 500 }),
    });

    if (!result) throw new Error('expected a response');
    const json = await result.json();
    expect(json.error_type).toBe(ProxyErrorType.context_length_exceeded);
    expect(String(json.message)).toMatch(/maximum context length/i);
  });

  it('does not trigger on a 500 when the estimate fits the window', async () => {
    const smallRequest = chatRequest({
      model: minimax_m25_free_model.public_id,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const result = await detectContextOverflow({
      requestedModel: minimax_m25_free_model.public_id,
      request: smallRequest,
      response: new Response('Internal Server Error', { status: 500 }),
    });

    expect(result).toBeNull();
  });
});
