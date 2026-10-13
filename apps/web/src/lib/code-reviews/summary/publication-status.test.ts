import {
  COUNCIL_VERDICT_BLOCK_END,
  COUNCIL_VERDICT_BLOCK_START,
} from '@kilocode/worker-utils/code-review-council';
import { classifyCodeReviewPublication } from './publication-status';

const KILO_REVIEW_MARKER = '<!-- kilo-review -->';

const currentSummary = [
  KILO_REVIEW_MARKER,
  '## Code Review Summary',
  '',
  '**Status:** No Issues Found | **Recommendation:** Merge',
].join('\n');

const previousSummaryWithHistoryFooter = [
  KILO_REVIEW_MARKER,
  '## Code Review Summary',
  '',
  '**Status:** No Issues Found | **Recommendation:** Merge',
  '',
  COUNCIL_VERDICT_BLOCK_START,
  'Council decision: merge',
  COUNCIL_VERDICT_BLOCK_END,
  '',
  '<!-- kilo-review-history -->',
  '<details>',
  '<summary><b>Previous Review Summary</b></summary>',
  '',
  '<!-- kilo-review-history-entry -->',
  '### Previous review',
  '',
  'Old findings',
  '',
  '</details>',
  '<!-- /kilo-review-history -->',
  '',
  '---',
  '<!-- kilo-usage -->',
  '<sub>Reviewed by test-model · Input: 1 · Output: 1 · Cached: 0</sub>',
  '<!-- kilo-review-guidance -->',
  '<sub>Review guidance: REVIEW.md from base branch</sub>',
].join('\n');

describe('classifyCodeReviewPublication', () => {
  it('returns unchanged when a legacy null-observed baseline matches the current summary', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: currentSummary,
        previousSummaryBody: previousSummaryWithHistoryFooter,
        previousSummaryObserved: null,
      })
    ).toBe('unchanged');
  });

  it('returns published when the agent text differs under a legacy null-observed baseline', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: currentSummary.replace('No Issues Found', '1 Issue Found'),
        previousSummaryBody: previousSummaryWithHistoryFooter,
        previousSummaryObserved: null,
      })
    ).toBe('published');
  });

  it('returns published when the baseline was observed with no previous body', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: currentSummary,
        previousSummaryBody: null,
        previousSummaryObserved: true,
      })
    ).toBe('published');
  });

  it('returns missing when a marker-only current body has no summary wording', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: '<!-- kilo-review -->',
        previousSummaryBody: null,
        previousSummaryObserved: true,
      })
    ).toBe('missing');
  });

  it('returns missing when the current body is only the marker and reserved sections', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: [
          '<!-- kilo-review -->',
          '<!-- kilo-review-history -->',
          'old',
          '<!-- /kilo-review-history -->',
          '---',
          '<!-- kilo-usage -->',
          '<sub>Reviewed by model</sub>',
        ].join('\n'),
        previousSummaryBody: null,
        previousSummaryObserved: true,
      })
    ).toBe('missing');
  });

  it('returns unknown when the baseline observation failed even with a previous body', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: currentSummary,
        previousSummaryBody: previousSummaryWithHistoryFooter,
        previousSummaryObserved: false,
      })
    ).toBe('unknown');
  });

  it('returns unknown when the baseline was never observed and has no previous body', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: currentSummary,
        previousSummaryBody: null,
        previousSummaryObserved: null,
      })
    ).toBe('unknown');
  });

  it('returns missing for a null completion body even when the baseline is unavailable', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: null,
        previousSummaryBody: previousSummaryWithHistoryFooter,
        previousSummaryObserved: false,
      })
    ).toBe('missing');
  });

  it('returns missing for a completion body without the marker', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: '## Code Review Summary\n\nNo marker here',
        previousSummaryBody: previousSummaryWithHistoryFooter,
        previousSummaryObserved: true,
      })
    ).toBe('missing');
  });

  it('returns missing for a completion body without the marker even when the baseline is unavailable', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: '## Code Review Summary\n\nNo marker',
        previousSummaryBody: null,
        previousSummaryObserved: false,
      })
    ).toBe('missing');
  });

  it('keeps an unmatched council start marker after a complete pair is removed', () => {
    const previousWithOrphan = [
      currentSummary,
      '',
      COUNCIL_VERDICT_BLOCK_START,
      'Council decision: merge',
      COUNCIL_VERDICT_BLOCK_END,
      '',
      COUNCIL_VERDICT_BLOCK_START,
      'orphan without end',
    ].join('\n');

    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: currentSummary,
        previousSummaryBody: previousWithOrphan,
        previousSummaryObserved: true,
      })
    ).toBe('published');
  });

  it('compares internal whitespace literally', () => {
    expect(
      classifyCodeReviewPublication({
        kind: 'summary',
        summaryBody: currentSummary.replace('**Status:** ', '**Status:**  '),
        previousSummaryBody: currentSummary,
        previousSummaryObserved: true,
      })
    ).toBe('published');
  });

  it('passes a not_applicable observation through', () => {
    expect(classifyCodeReviewPublication({ kind: 'not_applicable' })).toBe('not_applicable');
  });

  it('passes an unknown observation through', () => {
    expect(classifyCodeReviewPublication({ kind: 'unknown' })).toBe('unknown');
  });
});
