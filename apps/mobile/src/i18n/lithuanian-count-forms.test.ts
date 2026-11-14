import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Lithuanian takes the nominative singular after one, the nominative plural
 * after two to nine, and the genitive plural after zero and after every count
 * from ten up. A single invariant noun cannot agree with all of them, so the
 * context usage label is a counted family. Both frames that show it are pinned
 * here: the sheet's "84 000 žetonų" and the per-million price line's
 * "už 1 mln. žetonų", which is the genitive plural the earlier fixed string
 * could not produce.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('lt');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Lithuanian token count', () => {
  it('agrees the noun with the count that precedes it', () => {
    expect(i18n.t('agentChat.contextUsage.tokens', { count: 1 })).toBe('žetonas');
    expect(i18n.t('agentChat.contextUsage.tokens', { count: 2 })).toBe('žetonai');
    expect(i18n.t('agentChat.contextUsage.tokens', { count: 9 })).toBe('žetonai');
    expect(i18n.t('agentChat.contextUsage.tokens', { count: 10 })).toBe('žetonų');
    expect(i18n.t('agentChat.contextUsage.tokens', { count: 15 })).toBe('žetonų');
    expect(i18n.t('agentChat.contextUsage.tokens', { count: 21 })).toBe('žetonas');
    expect(i18n.t('agentChat.contextUsage.tokens', { count: 84_000 })).toBe('žetonų');
  });

  it('keeps the per-million price line in the genitive plural', () => {
    expect(
      i18n.t('agentChat.modelCost.perMillion', {
        input: '$1.75',
        inputLabel: 'Įvestis',
        million: '1 mln.',
        output: '$14.00',
        outputLabel: 'Išvestis',
        tokens: i18n.t('agentChat.contextUsage.tokens', { count: 1_000_000 }),
      })
    ).toBe('Įvestis $1.75 · Išvestis $14.00 už 1 mln. žetonų');
  });
});
