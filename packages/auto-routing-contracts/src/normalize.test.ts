import { describe, expect, it } from 'vitest';
import {
  detectRequiredInputModalities,
  estimateRoutingTokens,
  normalizeClassifierInput,
  redactProviderHints,
} from './normalize';

describe('classifier input normalization', () => {
  it('captures the first and latest user prompt text for long chat completion sessions', () => {
    expect(
      normalizeClassifierInput('chat_completions', {
        model: 'anthropic/claude-sonnet-4',
        messages: [
          { role: 'system', content: 'You are Kilo Code.' },
          { role: 'user', content: '<task>Add tests for the parser.</task>' },
          { role: 'assistant', content: 'I will inspect the repo.' },
          { role: 'user', content: 'Actually focus on latency instead.' },
        ],
      })
    ).toMatchObject({
      userPromptPrefix: 'Add tests for the parser.',
      latestUserPromptPrefix: 'Actually focus on latency instead.',
    });
  });

  it('strips redundant tool result content from prompt prefixes', () => {
    expect(
      normalizeClassifierInput('chat_completions', {
        model: 'anthropic/claude-sonnet-4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '<task>Fix the webhook retry bug.</task>' },
              {
                type: 'tool_result',
                content: 'unneeded file contents and command output',
              },
            ],
          },
          {
            role: 'assistant',
            content: '<read_file><path>src/webhook.ts</path></read_file>',
          },
          {
            role: 'user',
            content:
              'Actually simplify the retry parser. <read_file><path>src/retry.ts</path></read_file> [ERROR] stack trace',
          },
        ],
      })
    ).toMatchObject({
      userPromptPrefix: 'Fix the webhook retry bug.',
      latestUserPromptPrefix: 'Actually simplify the retry parser.',
    });
  });

  it('captures the first and latest user prompt text for responses input arrays', () => {
    expect(
      normalizeClassifierInput('responses', {
        model: 'openai/gpt-5-mini',
        input: [
          { role: 'user', content: 'Draft an implementation plan.' },
          { role: 'assistant', content: 'Here is a plan.' },
          { role: 'user', content: [{ type: 'input_text', text: 'Now implement it.' }] },
        ],
      })
    ).toMatchObject({
      userPromptPrefix: 'Draft an implementation plan.',
      latestUserPromptPrefix: 'Now implement it.',
    });
  });

  it('ignores trailing Anthropic tool results when selecting the latest user prompt', () => {
    expect(
      normalizeClassifierInput('messages', {
        model: 'anthropic/claude-sonnet-4',
        messages: [
          { role: 'user', content: 'Write a migration plan.' },
          { role: 'assistant', content: [{ type: 'text', text: 'I will inspect the repo.' }] },
          { role: 'user', content: 'Actually debug the failing worker test.' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'file contents that should not classify the task',
              },
            ],
          },
        ],
      })
    ).toMatchObject({
      userPromptPrefix: 'Write a migration plan.',
      latestUserPromptPrefix: 'Actually debug the failing worker test.',
    });
  });

  it('returns null when the body does not match the API shape', () => {
    expect(normalizeClassifierInput('chat_completions', { model: 'auto' })).toBeNull();
    expect(normalizeClassifierInput('chat_completions', 'not an object')).toBeNull();
    expect(normalizeClassifierInput('messages', { model: '', messages: [] })).toBeNull();
  });

  it('redacts sensitive keys in provider hints', () => {
    expect(
      redactProviderHints({
        provider: { order: ['openai'], api_key: 'sk-secret' },
        providerOptions: undefined,
      })
    ).toEqual({
      provider: { order: ['openai'], api_key: '[REDACTED]' },
      providerOptions: null,
    });
  });

  it('stops walking pathologically large arrays once the budget is exhausted', () => {
    const huge = Array.from({ length: 10_000 }, (_, index) => `entry-${index}`);

    const hints = redactProviderHints({ provider: huge, providerOptions: undefined });
    const provider = hints.provider as unknown[];

    expect(provider.length).toBeLessThan(600);
    expect(provider.slice(0, 3)).toEqual(['entry-0', 'entry-1', 'entry-2']);
    expect(provider.at(-1)).toBe('[TRUNCATED]');
  });

  it('stops walking pathologically key-dense objects once the budget is exhausted', () => {
    const huge = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`key-${index}`, index])
    );

    const hints = redactProviderHints({ provider: huge, providerOptions: undefined });
    const provider = hints.provider as Record<string, unknown>;

    expect(Object.keys(provider).length).toBeLessThan(600);
    expect(provider['key-0']).toBe(0);
    expect(provider['[truncated]']).toBe('[TRUNCATED]');
  });

  it('uses caller-captured requestedModel and providerHints over the body values', () => {
    expect(
      normalizeClassifierInput(
        'chat_completions',
        {
          model: 'anthropic/claude-sonnet-4',
          provider: { order: ['google'] },
          messages: [{ role: 'user', content: 'Fix the bug.' }],
        },
        {
          requestedModel: 'kilo-auto/free',
          providerHints: { provider: { order: ['anthropic'] }, providerOptions: null },
        }
      )
    ).toMatchObject({
      requestedModel: 'kilo-auto/free',
      providerHints: { provider: { order: ['anthropic'] }, providerOptions: null },
    });
  });
});

describe('detectRequiredInputModalities', () => {
  it('returns [] for text-only bodies', () => {
    expect(
      detectRequiredInputModalities({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      })
    ).toEqual([]);
  });

  it('returns [] for malformed or non-object input without throwing', () => {
    expect(detectRequiredInputModalities(null)).toEqual([]);
    expect(detectRequiredInputModalities(undefined)).toEqual([]);
    expect(detectRequiredInputModalities('garbage')).toEqual([]);
    expect(detectRequiredInputModalities(42)).toEqual([]);
    expect(detectRequiredInputModalities({})).toEqual([]);
  });

  it('detects image_url in OpenAI chat completions', () => {
    expect(
      detectRequiredInputModalities({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
            ],
          },
        ],
      })
    ).toEqual(['image']);
  });

  it('detects image and document parts in Anthropic messages', () => {
    expect(
      detectRequiredInputModalities({
        model: 'claude-sonnet-4-20250514',
        system: 'You analyze images.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', data: 'aGVsbG8=' } },
              { type: 'text', text: 'Describe it.' },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'document', source: { type: 'base64', data: 'ZG9j' } }],
          },
        ],
      })
    ).toEqual(['file', 'image']);
  });

  it('detects input_image and input_file in OpenAI Responses API', () => {
    expect(
      detectRequiredInputModalities({
        model: 'gpt-4o',
        input: [
          { role: 'user', content: 'Look at this' },
          {
            role: 'user',
            content: [
              { type: 'input_image', image_url: 'https://example.com/x.png' },
              { type: 'input_file', file_data: 'data:application/pdf;base64,AAA' },
            ],
          },
        ],
      })
    ).toEqual(['file', 'image']);
  });

  it('deduplicates repeated modalities across messages', () => {
    expect(
      detectRequiredInputModalities({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'a' } }] },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'b' } }] },
        ],
      })
    ).toEqual(['image']);
  });

  it('does not treat a bare `file` key in tool output as a file request', () => {
    // A `read_file`-style tool result whose `content` is a structured object
    // with a `file` property must not be misdetected as a document request.
    expect(
      detectRequiredInputModalities({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'Read src/webhook.ts' },
          {
            role: 'tool',
            content: [{ type: 'tool_result', content: { file: 'src/webhook.ts', lines: 42 } }],
          },
        ],
      })
    ).toEqual([]);
  });

  it('does not claim support for Gemini native contents[].parts[] bodies', () => {
    // Native Gemini request bodies never reach this helper: the gateway only
    // invokes auto-routing for chat_completions / responses / messages shapes,
    // and normalizeClassifierInput rejects any other top-level structure. The
    // doc comment therefore does not advertise Gemini-style support.
    expect(
      detectRequiredInputModalities({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } },
              { text: 'What is this?' },
            ],
          },
        ],
      })
    ).toEqual([]);
  });
});

describe('estimateRoutingTokens', () => {
  it('returns 0 for non-object input', () => {
    expect(estimateRoutingTokens(null)).toBe(0);
    expect(estimateRoutingTokens(undefined)).toBe(0);
    expect(estimateRoutingTokens('not an object')).toBe(0);
  });

  it('estimates text-only chat completion bodies via chars/4', () => {
    // "Hello world, this is a test." = 28 chars => 28/4 = 7
    expect(
      estimateRoutingTokens({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello world, this is a test.' }],
      })
    ).toBe(7);
  });

  it('excludes remote image URL strings from the estimate', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2000) + '.png';
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image_url', image_url: { url: longUrl } },
          ],
        },
      ],
    });
    // Only "Describe this image." (20 chars) / 4 = 5
    expect(estimate).toBe(5);
  });

  it('excludes large base64 image payloads from the estimate', () => {
    const base64 = 'B'.repeat(50_000);
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        },
      ],
    });
    expect(estimate).toBe(1); // "What?" is 5 chars => 5/4 = 1.25 => round = 1
  });

  it('counts tool_calls function arguments as text', () => {
    const args = JSON.stringify({
      path: '/tmp/foo.ts',
      content: 'x'.repeat(2000),
    });
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Edit file' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'write_file', arguments: args },
            },
          ],
        },
      ],
    });
    // "Edit file" (9) + args length (2000+ chars) / 4
    const expected = Math.round((9 + args.length) / 4);
    expect(estimate).toBe(expected);
  });

  it('counts Anthropic tool_use input serialized as text', () => {
    const toolUse = {
      type: 'tool_use',
      id: 'tool-1',
      name: 'read_file',
      input: { path: '/tmp/foo.ts', offset: 'x'.repeat(2000) },
    };
    const estimate = estimateRoutingTokens({
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: 'Read the file' },
        { role: 'assistant', content: [toolUse] },
      ],
    });
    // "Read the file" (13) + JSON.stringify(toolUse.input) length / 4
    const inputJsonLen = JSON.stringify(toolUse.input).length;
    const expected = Math.round((13 + inputJsonLen) / 4);
    expect(estimate).toBe(expected);
  });

  it('counts Responses API function_call arguments as text', () => {
    const args = 'x'.repeat(4000);
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      input: [{ type: 'function_call', name: 'do_thing', arguments: args }],
    });
    expect(estimate).toBe(Math.round(args.length / 4));
  });

  it('adds max_tokens to the estimate', () => {
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 500,
    });
    // "hi" = 2 chars => 0.5, + 500 => 500.5 => round = 501
    expect(estimate).toBe(501);
  });

  it('adds max_completion_tokens to the estimate', () => {
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 1000,
    });
    expect(estimate).toBe(1001);
  });

  it('adds max_output_tokens to the estimate', () => {
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_output_tokens: 256,
    });
    expect(estimate).toBe(257);
  });

  it('returns 0 for a completely empty body with no reservation', () => {
    expect(estimateRoutingTokens({})).toBe(0);
  });

  it('counts Responses API function_call_output output field, not content', () => {
    const output = 'x'.repeat(1000);
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      input: [{ type: 'function_call_output', call_id: 'call-1', output }],
    });
    expect(estimate).toBe(Math.round(output.length / 4));
  });

  it('does not zero-count a large Responses function_call_output output', () => {
    const output = 'x'.repeat(100_000);
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      input: [{ type: 'function_call_output', call_id: 'call-1', output }],
    });
    expect(estimate).toBe(Math.round(output.length / 4));
  });

  it('counts Anthropic tool_result content as before', () => {
    const content = 'x'.repeat(1000);
    const estimate = estimateRoutingTokens({
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: 'Read file' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content }] },
      ],
    });
    expect(estimate).toBe(Math.round((9 + content.length) / 4));
  });

  it('returns a positive integer (never fractional, never 0 when text exists)', () => {
    // 1 char / 4 = 0.25 => would round to 0, must floor to 1
    const estimate = estimateRoutingTokens({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'a' }],
    });
    expect(Number.isInteger(estimate)).toBe(true);
    expect(estimate).toBeGreaterThanOrEqual(1);
  });
});
