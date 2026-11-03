import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { CATALOG_LOADERS } from '@/i18n/catalogs';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';

import { providerPrMergeTitles } from './pr-merge-titles';

const t = i18n.getFixedT('en');

/**
 * The merge sheet names the action, and on GitLab the merge request's own noun
 * carries the merge word: interpolating that noun into a verb template repeated
 * it ("Merge merge request"), and in a catalog whose verb or particle lands on
 * an edge of the translated noun the repeat happened there instead
 * ("… درخواست ادغام ادغام …"). The merge-request arm therefore renders the
 * action alone, and these two strings are what every catalog has to word
 * without doubling the merge word.
 */
describe('providerPrMergeTitles', () => {
  it('names the GitLab merge action without restating the merge request', () => {
    expect(providerPrMergeTitles(t, 'gitlab')).toEqual({ action: 'Merge', confirm: 'Merge?' });
  });

  it('keeps the pull-request titles on the GitHub and Bitbucket arms', () => {
    expect(providerPrMergeTitles(t, 'github')).toEqual({
      action: 'Merge pull request',
      confirm: 'Merge pull request?',
    });
    expect(providerPrMergeTitles(t, 'bitbucket')).toEqual({
      action: 'Merge pull request',
      confirm: 'Merge pull request?',
    });
  });
});

function repeatedWord(value: string): string | undefined {
  const words = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const adjacent = words.find((word, index) => word === words[index - 1]);
  if (adjacent !== undefined) {
    return adjacent;
  }
  // Chinese, Japanese, Thai, Lao, Khmer and Burmese join their words without a
  // space, so the verb and the noun meet with nothing between them. There, any
  // repeated run of characters is the same defect.
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(
    value
  )
    ? repeatedRun(value.toLowerCase().replaceAll(/[\s\p{P}\p{S}]/gu, ''))
    : undefined;
}

function repeatedRun(compact: string): string | undefined {
  for (let start = 0; start < compact.length; start += 1) {
    for (let end = start + 1; end <= compact.length; end += 1) {
      const run = compact.slice(start, end);
      if (compact.startsWith(run + run, start)) {
        return run;
      }
    }
  }
  return undefined;
}

describe('the merge request titles in every catalog', () => {
  it.each(SUPPORTED_LANGUAGES)('%s names the merge action without repeating a word', tag => {
    const copy = CATALOG_LOADERS[tag]() as {
      prReview: { merge: { merge: string; confirmMergeTitle: string } };
    };
    const titles = [copy.prReview.merge.merge, copy.prReview.merge.confirmMergeTitle];
    expect(titles.map(title => repeatedWord(title))).toEqual([undefined, undefined]);
  });
});
