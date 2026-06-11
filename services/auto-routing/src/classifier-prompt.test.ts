import { describe, expect, it } from 'vitest';
import { buildClassifierMessages, DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';
import type { NormalizedClassifierInput } from './classifier-input';

const input = {
  apiKind: 'chat_completions',
  requestedModel: 'anthropic/claude-sonnet-4',
  systemPromptPrefix: 'You are a coding agent.',
  userPromptPrefix: 'Fix the failing worker test and commit the change.',
  messageCount: 4,
  hasTools: true,
  stream: true,
  providerHints: {
    provider: { order: ['anthropic'] },
    providerOptions: { openrouter: { sort: 'price', apiKey: '[REDACTED]' } },
  },
} satisfies NormalizedClassifierInput;

describe('classifier prompt', () => {
  it('defaults to Gemini Flash Lite as the classifier model', () => {
    expect(DEFAULT_CLASSIFIER_MODEL).toBe('google/gemini-2.5-flash-lite');
  });

  it('builds compact taxonomy and request-summary messages', () => {
    const messages = buildClassifierMessages(input);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0].content).toContain('"taskTypes"');
    expect(messages[0].content).toContain('"implementation"');
    expect(messages[0].content).toContain('Return exactly one minified JSON object');
    expect(messages[0].content).toContain('allowedOutputValues');
    expect(messages[0].content).not.toContain('"examples"');
    expect(messages[0].content.length).toBeLessThan(12_000);
    expect(messages[1]).toEqual({
      role: 'user',
      content: `Request summary:\n${JSON.stringify(input)}`,
    });
  });
});
