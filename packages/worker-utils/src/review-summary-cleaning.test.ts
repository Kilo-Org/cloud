import { describe, expect, it } from 'vitest';
import {
  buildPreviousReviewSummaryHistory,
  stripReviewSummaryFooter,
  stripReviewSummaryHistory,
} from './review-summary-cleaning.js';

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

describe('byte-bounded summary history', () => {
  const encoder = new TextEncoder();
  const byteLength = (value: string) => encoder.encode(value).byteLength;

  it.each(['界', '\u{20000}'])(
    'truncates %s snapshots at complete Unicode boundaries with closed history details',
    character => {
      const previous = `<!-- kilo-review -->\n<details>\n<summary>Findings</summary>\n${character.repeat(23_000)}\n</details>`;
      const result = buildPreviousReviewSummaryHistory(previous, { maxBytes: 24_000 });
      expect(byteLength(result)).toBeLessThanOrEqual(24_000);
      expect(result).toContain(character.repeat(100));
      expect(result).toContain('_[Snapshot truncated.]_');
      expect(result).toContain('Additional previous summary content was truncated');
      expect(result.endsWith('\n</details>\n<!-- /kilo-review-history -->')).toBe(true);
      expect(result.match(/<details>/g)).toHaveLength(2);
      expect(result.match(/<\/details>/g)).toHaveLength(2);
      expect(result).not.toContain('\uFFFD');
      expect(new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(result))).toBe(result);
      expect(stripReviewSummaryHistory(`Current\n\n${result}`)).toBe('Current');
    }
  );

  it('preserves the complete rendering when both character and byte budgets fit', () => {
    const previous = '<!-- kilo-review -->\nA complete 界 snapshot';
    const original = buildPreviousReviewSummaryHistory(previous);
    expect(
      buildPreviousReviewSummaryHistory(previous, {
        maxCharacters: original.length,
        maxBytes: byteLength(original),
      })
    ).toBe(original);
  });

  it('retains recent snapshots first and counts only retained entries', () => {
    const older = buildPreviousReviewSummaryHistory('Old finding\n' + '界'.repeat(5_000));
    const previous = `<!-- kilo-review -->\nRecent finding\n\n${older}`;
    const result = buildPreviousReviewSummaryHistory(previous, { maxBytes: 1_200 });
    expect(result.indexOf('Recent finding')).toBeLessThan(result.indexOf('Old finding'));
    expect(result).toContain('Previous Review Summaries</b> (2 snapshots)');
    expect(result.match(/<!-- kilo-review-history-entry -->/g)).toHaveLength(2);
    expect(byteLength(result)).toBeLessThanOrEqual(1_200);
  });

  it.each([0, 100, 300, 500, 700, 900, 1_200, 24_000])(
    'keeps wrappers and truncation notices within the %i-byte budget',
    maxBytes => {
      const older = buildPreviousReviewSummaryHistory('Old finding\n' + '界'.repeat(5_000));
      const result = buildPreviousReviewSummaryHistory(
        `<!-- kilo-review -->\nRecent finding\n\n${older}`,
        { maxBytes }
      );
      expect(byteLength(result)).toBeLessThanOrEqual(maxBytes);
      if (result) {
        expect(result).toContain('Recent finding');
        expect(result.startsWith('<!-- kilo-review-history -->\n<details>')).toBe(true);
        expect(result.endsWith('</details>\n<!-- /kilo-review-history -->')).toBe(true);
      }
    }
  );

  it('enforces character and byte limits together', () => {
    const result = buildPreviousReviewSummaryHistory('界'.repeat(3_000), {
      maxCharacters: 900,
      maxBytes: 1_200,
    });
    expect(result.length).toBeLessThanOrEqual(900);
    expect(byteLength(result)).toBeLessThanOrEqual(1_200);
    expect(result).toContain('界'.repeat(100));
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
