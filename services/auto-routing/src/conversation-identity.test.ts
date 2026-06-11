import { describe, expect, it } from 'vitest';
import { computeContentHashes } from './conversation-identity';
import type { NormalizedClassifierInput } from './classifier-input';

const baseInput = {
  apiKind: 'responses',
  requestedModel: 'openai/gpt-5-mini',
  systemPromptPrefix: 'You are a classifier.',
  userPromptPrefix: 'Build a migration plan.',
  messageCount: 2,
  hasTools: false,
  stream: false,
  providerHints: {
    provider: null,
    providerOptions: null,
  },
} satisfies NormalizedClassifierInput;

describe('computeContentHashes', () => {
  it('does not collide when prompt fields contain delimiter characters', async () => {
    const left = await computeContentHashes({
      ...baseInput,
      systemPromptPrefix: 'a|b',
      userPromptPrefix: 'c',
    });
    const right = await computeContentHashes({
      ...baseInput,
      systemPromptPrefix: 'a',
      userPromptPrefix: 'b|c',
    });

    expect(left.exact).not.toBe(right.exact);
    expect(left.loose).not.toBe(right.loose);
  });

  it('produces identical hashes for identical inputs', async () => {
    const first = await computeContentHashes(baseInput);
    const second = await computeContentHashes(baseInput);

    expect(first).toEqual(second);
  });

  it('separates exact hashes by message-count bucket while loose hashes match', async () => {
    const shallow = await computeContentHashes({ ...baseInput, messageCount: 2 });
    const deep = await computeContentHashes({ ...baseInput, messageCount: 64 });

    expect(shallow.loose).toBe(deep.loose);
    expect(shallow.exact).not.toBe(deep.exact);
  });
});
