import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { joinSentences } from './join-sentences';

// Every case starts from the language the app boots in, so a catalog switched
// here never leaks into the suites that share this worker.
afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('joinSentences', () => {
  it('writes the English stop once when both sentences end with it', () => {
    expect(joinSentences(['A.', 'B.'])).toBe('A. B.');
  });

  it('gives a first sentence without a stop the joiner’s stop', () => {
    expect(joinSentences(['A', 'B.'])).toBe('A. B.');
  });

  it('keeps the closing stop the last sentence brought and adds none when it brought none', () => {
    expect(joinSentences(['A.', 'B.'])).toBe('A. B.');
    expect(joinSentences(['A.', 'B'])).toBe('A. B');
  });

  it('does not double the Japanese stop, which needs no space after it', async () => {
    await i18n.changeLanguage('ja');

    expect(joinSentences(['A。', 'B。'])).toBe('A。B。');
  });

  it('joins Thai with its space and strips nothing', async () => {
    await i18n.changeLanguage('th');

    expect(joinSentences(['A', 'B'])).toBe('A B');
    // Thai writes no sentence terminator, so the catalog's joiner is the whole
    // separator and the sentences pass through as they came.
    expect(joinSentences(['A.', 'B.'])).toBe('A. B.');
  });
});
