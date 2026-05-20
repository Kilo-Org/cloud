import { describe, expect, it } from '@jest/globals';
import {
  buildExperimentPromptCapture,
  REQUEST_BODY_CAP_BYTES,
  truncateToUtf8Bytes,
} from './persist';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

describe('truncateToUtf8Bytes', () => {
  it('returns the input unchanged when already within the cap', () => {
    expect(truncateToUtf8Bytes('hello', 100)).toBe('hello');
  });

  it('returns valid UTF-8 with length <= maxBytes for ASCII', () => {
    const out = truncateToUtf8Bytes('a'.repeat(1000), 16);
    expect(Buffer.byteLength(out, 'utf8')).toBe(16);
    expect(out).toBe('a'.repeat(16));
  });

  it('does not split a multi-byte UTF-8 codepoint', () => {
    // '日' is 3 bytes in UTF-8 (0xE6 0x97 0xA5). With maxBytes=4 the cut
    // would otherwise land mid-codepoint and produce invalid UTF-8.
    const input = '日日日'; // 9 UTF-8 bytes
    const out = truncateToUtf8Bytes(input, 4);
    // Result must be valid UTF-8 and <= 4 bytes. The only valid prefixes
    // here are '' (0 bytes) and '日' (3 bytes).
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4);
    expect(out).toBe('日');
  });

  it('handles 4-byte emoji codepoints correctly', () => {
    // '😀' is 4 bytes in UTF-8 (a surrogate pair in UTF-16).
    const input = '😀😀😀';
    const out = truncateToUtf8Bytes(input, 6);
    // Only '😀' (4 bytes) fits cleanly; cutting at byte 6 would split
    // the second emoji.
    expect(out).toBe('😀');
    expect(Buffer.byteLength(out, 'utf8')).toBe(4);
  });

  it('produces deterministic output across calls', () => {
    const input = 'hello 日本語 world 🎉 こんにちは';
    const a = truncateToUtf8Bytes(input, 12);
    const b = truncateToUtf8Bytes(input, 12);
    expect(a).toBe(b);
    expect(Buffer.byteLength(a, 'utf8')).toBeLessThanOrEqual(12);
  });

  it('cuts cleanly when the cap exactly aligns with a codepoint boundary', () => {
    const input = '日日'; // 6 bytes
    const out = truncateToUtf8Bytes(input, 3);
    expect(out).toBe('日');
  });

  it('handles maxBytes of 0', () => {
    expect(truncateToUtf8Bytes('hello', 0)).toBe('');
  });
});

describe('buildExperimentPromptCapture', () => {
  function chatRequest(body: Record<string, unknown>): GatewayRequest {
    // Tests may pass synthetic message shapes that don't fully match
    // the production OpenAI types; double-cast through unknown is the
    // pragmatic test-only escape hatch.
    return { kind: 'chat_completions', body } as unknown as GatewayRequest;
  }

  it('captures the full serialized body and records the request kind', () => {
    const cap = buildExperimentPromptCapture(
      chatRequest({
        model: 'kilo/preview-foo',
        messages: [
          { role: 'system', content: 'you are a helpful assistant' },
          { role: 'user', content: 'hi' },
        ],
      })
    );
    expect(cap.requestKind).toBe('chat_completions');
    expect(cap.requestBodyContent).toContain('"role":"system"');
    expect(cap.requestBodyContent).toContain('"role":"user"');
    expect(cap.wasTruncated).toBe(false);
  });

  it('records `messages` for an Anthropic-shape request', () => {
    const cap = buildExperimentPromptCapture({
      kind: 'messages',
      body: {
        model: 'kilo/preview-foo',
        system: 'you are a helpful assistant',
        messages: [{ role: 'user', content: 'hi' }],
      },
    } as unknown as GatewayRequest);
    expect(cap.requestKind).toBe('messages');
    expect(cap.requestBodyContent).toContain('"system":"you are a helpful assistant"');
  });

  it('records `responses` for a Responses-API request', () => {
    const cap = buildExperimentPromptCapture({
      kind: 'responses',
      body: { model: 'kilo/preview-foo', input: 'hi' },
    } as unknown as GatewayRequest);
    expect(cap.requestKind).toBe('responses');
    expect(cap.requestBodyContent).toContain('"input":"hi"');
  });

  it('truncates the body by UTF-8 bytes and marks wasTruncated', () => {
    const huge = 'a'.repeat(REQUEST_BODY_CAP_BYTES + 1024);
    const cap = buildExperimentPromptCapture(
      chatRequest({
        model: 'kilo/preview-foo',
        messages: [{ role: 'user', content: huge }],
      })
    );
    expect(cap.wasTruncated).toBe(true);
    expect(Buffer.byteLength(cap.requestBodyContent, 'utf8')).toBeLessThanOrEqual(
      REQUEST_BODY_CAP_BYTES
    );
  });

  it('produces deterministic output for identical inputs', () => {
    // Content addressing on top of this capture relies on byte-for-byte
    // determinism; a JSON.stringify implementation that reordered keys
    // would silently break dedup.
    const body = {
      model: 'kilo/preview-foo',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const a = buildExperimentPromptCapture(chatRequest({ ...body }));
    const b = buildExperimentPromptCapture(chatRequest({ ...body }));
    expect(a.requestBodyContent).toBe(b.requestBodyContent);
  });
});
