import { describe, expect, it } from 'vitest';
import { normalizeClassifierInput, redactProviderHints } from './normalize';

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
