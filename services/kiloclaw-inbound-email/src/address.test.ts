import { describe, expect, it } from 'vitest';
import { instanceIdFromRecipient, truncate } from './address';

describe('instanceIdFromRecipient', () => {
  it('parses ki-prefixed instance recipient addresses', () => {
    expect(
      instanceIdFromRecipient('ki-11111111111141118111111111111111@kiloclaw.ai', 'kiloclaw.ai')
    ).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('rejects unexpected domains and local parts', () => {
    expect(
      instanceIdFromRecipient('ki-11111111111141118111111111111111@example.com', 'kiloclaw.ai')
    ).toBeNull();
    expect(instanceIdFromRecipient('hello@kiloclaw.ai', 'kiloclaw.ai')).toBeNull();
  });
});

describe('truncate', () => {
  it('truncates strings longer than the limit', () => {
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(truncate('abc', 3)).toBe('abc');
  });
});
