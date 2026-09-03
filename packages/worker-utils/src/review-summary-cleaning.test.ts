import { describe, expect, it } from 'vitest';
import { stripReviewSummaryFooter, stripReviewSummaryHistory } from './review-summary-cleaning.js';

const usage =
  '<!-- kilo-usage -->\n<sub>Reviewed by model · Input: 1K · Output: 200 · Cached: 0</sub>';
const guidance =
  '<!-- kilo-review-guidance -->\n<sub>Review guidance: REVIEW.md from base branch `main`</sub>';
const history = [
  '<!-- kilo-review-history -->',
  '<details>',
  '<summary><b>Previous Review Summary</b></summary>',
  '',
  '_Current summary above is authoritative. Previous snapshots are kept for context only._',
  '',
  '<!-- kilo-review-history-entry -->',
  '### Previous review',
  '',
  'Archived finding',
  '</details>',
  '<!-- /kilo-review-history -->',
].join('\n');

const markers = [
  '<!-- kilo-usage -->',
  '<!-- kilo-review-guidance -->',
  '<!-- kilo-review-history -->',
  '<!-- /kilo-review-history -->',
  '<!-- kilo-review-history-entry -->',
];

describe('stripReviewSummaryFooter', () => {
  it.each([
    ['usage', usage],
    ['guidance', guidance],
    ['combined', `${usage}\n${guidance}`],
  ])(
    'removes a canonical trailing %s footer without changing earlier sections',
    (_name, footer) => {
      const body = 'Current summary\n\n---\n\nFinding after a section separator';
      expect(stripReviewSummaryFooter(`${body}\n\n---\n${footer}`)).toBe(body);
    }
  );

  it.each([
    ['missing separator', `Current summary\n${usage}`],
    ['inline marker', 'Current summary\n\n---\nMentions <!-- kilo-usage -->\nMore findings'],
    ['non-trailing footer', `Current summary\n\n---\n${guidance}\nMore findings`],
    ['unclosed sub block', 'Current summary\n\n---\n<!-- kilo-usage -->\n<sub>More findings'],
    [
      'over-budget footer',
      `Current summary\n\n---\n<!-- kilo-usage -->\n<sub>${'x'.repeat(2_000)}</sub>`,
    ],
  ])('preserves %s content', (_name, body) => {
    expect(stripReviewSummaryFooter(body)).toBe(body);
  });
});

describe('stripReviewSummaryHistory', () => {
  it('removes complete history blocks while preserving findings between and after them', () => {
    const body = `Current summary\n\n${history}\n\nMiddle finding\n\n${history}\n\nFinal finding`;
    expect(stripReviewSummaryHistory(body)).toBe(
      'Current summary\n\n\nMiddle finding\n\n\nFinal finding'
    );
  });

  it.each(['\n', '\r\n'])(
    'recognizes complete standalone history markers with %j line endings',
    newline => {
      const block = history
        .replace('<!-- kilo-review-history -->', ' \t<!-- kilo-review-history -->\t ')
        .replace('<!-- /kilo-review-history -->', '\t<!-- /kilo-review-history --> ')
        .replaceAll('\n', newline);
      expect(stripReviewSummaryHistory(`Current finding${newline}${block}`)).toBe(
        'Current finding'
      );
    }
  );

  it.each(markers)('preserves an unpaired %s marker and later findings', marker => {
    const body = `Current summary\n${marker}\nFinding after a literal marker`;
    expect(stripReviewSummaryFooter(stripReviewSummaryHistory(body))).toBe(body);
  });
});

describe('combined summary cleaning', () => {
  it.each(markers)('preserves a literal %s before real history and footer blocks', marker => {
    const current = `<!-- kilo-review -->\nMentions \`${marker}\` as text.\n\nCurrent finding`;
    const body = `${current}\n\n${history}\n\n---\n${usage}\n${guidance}`;
    const cleaned = stripReviewSummaryFooter(stripReviewSummaryHistory(body));
    expect(cleaned).toBe(current);
    expect(stripReviewSummaryFooter(stripReviewSummaryHistory(cleaned))).toBe(current);
  });
});
