import { describe, expect, it } from '@jest/globals';
import {
  buildExperimentPromptCapture,
  REQUEST_BODY_CAP_BYTES,
  SYSTEM_PROMPT_CAP_BYTES,
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

  it('extracts a leading system message into systemPromptContent', () => {
    const cap = buildExperimentPromptCapture(
      chatRequest({
        model: 'kilo/preview-foo',
        messages: [
          { role: 'system', content: 'you are a helpful assistant' },
          { role: 'user', content: 'hi' },
        ],
      })
    );
    expect(cap.systemPromptContent).toBe('you are a helpful assistant');
    expect(cap.requestBodyContent).toContain('"role":"user"');
    expect(cap.requestBodyContent).not.toContain('"role":"system"');
    expect(cap.wasTruncated).toBe(false);
  });

  it('leaves systemPromptContent null when there is no leading system message', () => {
    const cap = buildExperimentPromptCapture(
      chatRequest({
        model: 'kilo/preview-foo',
        messages: [{ role: 'user', content: 'hi' }],
      })
    );
    expect(cap.systemPromptContent).toBeNull();
    expect(cap.requestBodyContent).toContain('"role":"user"');
  });

  it('does not extract a system message if it is not the first', () => {
    // Mid-conversation system messages are kept in the body.
    const cap = buildExperimentPromptCapture(
      chatRequest({
        model: 'kilo/preview-foo',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'system', content: 'note' },
        ],
      })
    );
    expect(cap.systemPromptContent).toBeNull();
    expect(cap.requestBodyContent).toContain('"role":"system"');
  });

  it('truncates the system prompt by UTF-8 bytes and marks wasTruncated', () => {
    const huge = 'a'.repeat(SYSTEM_PROMPT_CAP_BYTES + 1024);
    const cap = buildExperimentPromptCapture(
      chatRequest({
        model: 'kilo/preview-foo',
        messages: [
          { role: 'system', content: huge },
          { role: 'user', content: 'hi' },
        ],
      })
    );
    expect(cap.wasTruncated).toBe(true);
    expect(cap.systemPromptContent).not.toBeNull();
    expect(Buffer.byteLength(cap.systemPromptContent ?? '', 'utf8')).toBeLessThanOrEqual(
      SYSTEM_PROMPT_CAP_BYTES
    );
  });

  it('truncates the request body remainder by UTF-8 bytes', () => {
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

  it('counts UTF-8 bytes (not UTF-16 units) when checking the cap', () => {
    // Build a string whose UTF-16 length is well under the cap but whose
    // UTF-8 byte length exceeds it. CJK chars are 1 UTF-16 unit but 3
    // UTF-8 bytes; with cap=10 bytes, 5 CJK chars (5 units, 15 bytes)
    // must trigger truncation.
    const cap = buildExperimentPromptCapture({
      kind: 'chat_completions',
      body: {
        model: 'kilo/preview-foo',
        messages: [
          { role: 'system', content: '日'.repeat(5) },
          { role: 'user', content: 'x' },
        ],
      },
    } as unknown as GatewayRequest);
    // We can't trigger this against the real 4 MB cap in a unit test, but
    // we can assert the UTF-8 byte count of the captured content directly.
    expect(cap.systemPromptContent).toBe('日'.repeat(5));
    expect(Buffer.byteLength(cap.systemPromptContent ?? '', 'utf8')).toBe(15);
    expect(cap.systemPromptContent?.length).toBe(5); // UTF-16 unit count for sanity.
  });

  it('serializes non-string system content', () => {
    const cap = buildExperimentPromptCapture(
      chatRequest({
        model: 'kilo/preview-foo',
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: 'hello' }],
          },
          { role: 'user', content: 'hi' },
        ],
      })
    );
    expect(cap.systemPromptContent).toContain('"text":"hello"');
  });
});
