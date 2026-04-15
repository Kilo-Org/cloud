import { describe, expect, it, vi } from 'vitest';
import { resolveRecipient, truncate } from './address';

describe('resolveRecipient', () => {
  it('looks up normalized aliases', async () => {
    const lookupAlias = vi.fn(async () => '22222222-2222-4222-8222-222222222222');

    await expect(
      resolveRecipient('Amber-River-Quiet-Maple@kiloclaw.ai', 'kiloclaw.ai', lookupAlias)
    ).resolves.toEqual({
      instanceId: '22222222-2222-4222-8222-222222222222',
      recipientAlias: 'amber-river-quiet-maple',
    });
    expect(lookupAlias).toHaveBeenCalledWith('amber-river-quiet-maple');
  });

  it('treats legacy addresses as unavailable aliases', async () => {
    const lookupAlias = vi.fn(async () => null);

    await expect(
      resolveRecipient(
        'ki-11111111111141118111111111111111@kiloclaw.ai',
        'kiloclaw.ai',
        lookupAlias
      )
    ).resolves.toBeNull();
    expect(lookupAlias).toHaveBeenCalledWith('ki-11111111111141118111111111111111');
  });

  it('rejects unknown aliases and unexpected domains', async () => {
    const lookupAlias = vi.fn(async () => null);

    await expect(
      resolveRecipient('missing@kiloclaw.ai', 'kiloclaw.ai', lookupAlias)
    ).resolves.toBeNull();
    await expect(
      resolveRecipient('missing@example.com', 'kiloclaw.ai', lookupAlias)
    ).resolves.toBeNull();
    expect(lookupAlias).toHaveBeenCalledTimes(1);
  });
});

describe('truncate', () => {
  it('truncates strings longer than the limit', () => {
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(truncate('abc', 3)).toBe('abc');
  });
});
