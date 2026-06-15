import { describe, expect, it } from 'vitest';
import {
  computeContentHashes,
  deriveConversationKey,
  deriveOutboundSessionId,
} from './conversation-identity';
import type { NormalizedClassifierInput } from '@kilocode/auto-routing-contracts';

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

describe('deriveConversationKey', () => {
  const hashes = { exact: 'e'.repeat(16), loose: 'a1b2c3d4e5f60718' };

  it('prefers session id, then machine id, then the content fingerprint', () => {
    expect(deriveConversationKey({ userId: 'u1', sessionId: 's1', machineId: 'm1' }, hashes)).toBe(
      'user:u1:task:s1'
    );
    expect(deriveConversationKey({ userId: 'u1', sessionId: null, machineId: 'm1' }, hashes)).toBe(
      'user:u1:machine:m1'
    );
    expect(deriveConversationKey({ userId: 'u1', sessionId: null, machineId: null }, hashes)).toBe(
      'user:u1:content:a1b2c3d4e5f60718'
    );
  });

  it('keeps equal session ids apart across users', () => {
    const left = deriveConversationKey({ userId: 'u1', sessionId: 's1', machineId: null }, hashes);
    const right = deriveConversationKey({ userId: 'u2', sessionId: 's1', machineId: null }, hashes);

    expect(left).not.toBe(right);
  });
});

describe('deriveOutboundSessionId', () => {
  it('produces a stable hash that does not contain the raw identity', async () => {
    const key = 'user:anon:203.0.113.7:task:s1';
    const first = await deriveOutboundSessionId(key);
    const second = await deriveOutboundSessionId(key);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toContain('203.0.113.7');
  });
});
