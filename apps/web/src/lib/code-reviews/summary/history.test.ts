import {
  REVIEW_SUMMARY_HISTORY_END,
  REVIEW_SUMMARY_HISTORY_ENTRY,
  REVIEW_SUMMARY_HISTORY_START,
  appendPreviousReviewSummaryHistory,
  buildPreviousReviewSummaryHistory,
  getCurrentReviewSummaryForContext,
  stripReviewSummaryHistory,
} from './history';

function countOccurrences(value: string, needle: string): number {
  return value.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length ?? 0;
}

const summaryWithIssues = [
  '<!-- kilo-review -->',
  '## Code Review Summary',
  '',
  '**Status:** 2 Issues Found | **Recommendation:** Address before merge',
  '',
  '### Overview',
  '| Severity | Count |',
  '|----------|-------|',
  '| CRITICAL | 0 |',
  '| WARNING | 2 |',
  '| SUGGESTION | 0 |',
  '',
  '<details>',
  '<summary><b>Issue Details (click to expand)</b></summary>',
  '',
  '#### WARNING',
  '| File | Line | Issue |',
  '|------|------|-------|',
  '| `src/file.ts` | 42 | Something regressed |',
  '',
  '</details>',
  '',
  '<details>',
  '<summary><b>Files Reviewed (1 file)</b></summary>',
  '',
  '- `src/file.ts` - 2 issues',
  '',
  '</details>',
  '',
  '---',
  '<!-- kilo-usage -->',
  '<sub>Reviewed by old-model - 1,234 tokens</sub>',
  '<!-- kilo-review-guidance -->',
  '<sub>Review guidance: REVIEW.md from base branch `main`</sub>',
].join('\n');

const cleanSummary = [
  '<!-- kilo-review -->',
  '## Code Review Summary',
  '',
  '**Status:** No Issues Found | **Recommendation:** Merge',
  '',
  '<details>',
  '<summary><b>Files Reviewed (1 file)</b></summary>',
  '',
  '- `src/file.ts`',
  '',
  '</details>',
].join('\n');

describe('buildPreviousReviewSummaryHistory', () => {
  it('builds one collapsed previous summary block without old top-level markers or footer', () => {
    const result = buildPreviousReviewSummaryHistory(summaryWithIssues, {
      previousHeadSha: 'abcdef1234567890',
    });

    expect(result).toContain(REVIEW_SUMMARY_HISTORY_START);
    expect(result).toContain(REVIEW_SUMMARY_HISTORY_END);
    expect(result).toContain('<summary><b>Previous Review Summary</b> (commit abcdef1)</summary>');
    expect(result).toContain(
      `${REVIEW_SUMMARY_HISTORY_ENTRY}\n### Previous review (commit abcdef1)`
    );
    expect(result).toContain('**Status:** 2 Issues Found');
    expect(result).toContain('<summary><b>Issue Details (click to expand)</b></summary>');
    expect(result).not.toContain('<!-- kilo-review -->');
    expect(result).not.toContain('## Code Review Summary');
    expect(result).not.toContain('<!-- kilo-usage -->');
    expect(result).not.toContain('<!-- kilo-review-guidance -->');
    expect(countOccurrences(result, REVIEW_SUMMARY_HISTORY_ENTRY)).toBe(1);
  });

  it('removes stale Fix Link sections from archived summaries', () => {
    const summaryWithFixLink = [
      summaryWithIssues,
      '',
      '[Keep this context link](https://example.com/context)',
      '',
      '## Fix Link (include if issues found)',
      '',
      '[Fix these issues in Kilo Cloud](https://kilo.ai/cloud-agent-fork/review/old-review)',
      '',
      '## Follow-up',
      '',
      'Content after the Fix Link section.',
    ].join('\n');

    const result = buildPreviousReviewSummaryHistory(summaryWithFixLink);

    expect(result).toContain('[Keep this context link](https://example.com/context)');
    expect(result).toContain('## Follow-up');
    expect(result).toContain('Content after the Fix Link section.');
    expect(result).not.toContain('## Fix Link');
    expect(result).not.toContain('old-review');
  });

  it('removes stale Fix Link sections from existing history entries', () => {
    const staleHistory = [
      REVIEW_SUMMARY_HISTORY_START,
      '<details>',
      '<summary><b>Previous Review Summary</b> (commit oldsha1)</summary>',
      '',
      '_Current summary above is authoritative. Previous snapshots are kept for context only._',
      '',
      REVIEW_SUMMARY_HISTORY_ENTRY,
      '### Previous review (commit oldsha1)',
      '',
      '**Status:** 1 Issue Found',
      '',
      '## Fix Link (include if issues found)',
      '',
      '[Fix these issues in Kilo Cloud](https://kilo.ai/cloud-agent-fork/review/stale-review)',
      '',
      '</details>',
      REVIEW_SUMMARY_HISTORY_END,
    ].join('\n');

    const result = buildPreviousReviewSummaryHistory([cleanSummary, staleHistory].join('\n\n'));

    expect(result).toContain('**Status:** 1 Issue Found');
    expect(result).not.toContain('## Fix Link');
    expect(result).not.toContain('stale-review');
  });

  it('does not render null or undefined commit labels when no previous SHA is available', () => {
    const result = buildPreviousReviewSummaryHistory(cleanSummary);

    expect(result).toContain('<summary><b>Previous Review Summary</b></summary>');
    expect(result).toContain('### Previous review\n');
    expect(result).not.toContain('commit null');
    expect(result).not.toContain('commit undefined');
    expect(result).not.toContain('(commit )');
  });

  it('flattens an existing history block instead of nesting it', () => {
    const firstHistory = buildPreviousReviewSummaryHistory(summaryWithIssues, {
      previousHeadSha: '1111111aaaaaaa',
    });
    const currentBody = [cleanSummary, '', firstHistory].join('\n');
    const result = buildPreviousReviewSummaryHistory(currentBody, {
      previousHeadSha: '2222222bbbbbbb',
    });

    expect(countOccurrences(result, REVIEW_SUMMARY_HISTORY_START)).toBe(1);
    expect(countOccurrences(result, REVIEW_SUMMARY_HISTORY_END)).toBe(1);
    expect(countOccurrences(result, REVIEW_SUMMARY_HISTORY_ENTRY)).toBe(2);
    expect(result).toContain(
      '<summary><b>Previous Review Summaries</b> (2 snapshots, latest commit 2222222)</summary>'
    );
    expect(result).toContain('### Previous review (commit 2222222)');
    expect(result).toContain('### Previous review (commit 1111111)');
  });

  it('removes roast summary headings while preserving roast-specific content', () => {
    const roastSummary = [
      '<!-- kilo-review -->',
      '## Code Review Roast',
      '',
      '**Verdict:** 1 Issue Found | **Recommendation:** Address before merge',
      '',
      '| Severity | Count |',
      '|----------|-------|',
      '| warning | 1 |',
      '',
      '**Worst part**: A bug wearing sunglasses.',
    ].join('\n');

    const result = buildPreviousReviewSummaryHistory(roastSummary, {
      previousHeadSha: '3333333ccccccc',
    });

    expect(result).not.toContain('## Code Review Roast');
    expect(result).toContain('**Verdict:** 1 Issue Found');
    expect(result).toContain('**Worst part**');
  });

  it('counts only snapshots rendered within the character limit', () => {
    const shortArchivedSummary = '<!-- kilo-review -->\n## Code Review Summary\n\nShort snapshot.';
    const oneOldSnapshot = buildPreviousReviewSummaryHistory(shortArchivedSummary);
    const twoSnapshotBody = [cleanSummary, oneOldSnapshot].join('\n\n');
    const twoSnapshotHistory = buildPreviousReviewSummaryHistory(twoSnapshotBody);
    const twoOldSnapshots = buildPreviousReviewSummaryHistory(
      [shortArchivedSummary, buildPreviousReviewSummaryHistory(summaryWithIssues)].join('\n\n')
    );
    const threeSnapshotBody = [cleanSummary, twoOldSnapshots].join('\n\n');

    const result = buildPreviousReviewSummaryHistory(threeSnapshotBody, {
      previousHeadSha: 'abcdef1234567890',
      maxCharacters: twoSnapshotHistory.length + 150,
    });

    expect(countOccurrences(result, REVIEW_SUMMARY_HISTORY_ENTRY)).toBe(2);
    expect(result).toContain(
      '<summary><b>Previous Review Summaries</b> (2 snapshots, latest commit abcdef1)</summary>'
    );
    expect(result).not.toContain('(3 snapshots');
  });

  it('truncates long archived content while preserving the history wrapper', () => {
    const longSummary = [
      '<!-- kilo-review -->',
      '## Code Review Summary',
      '',
      '**Status:** 1 Issue Found',
      '',
      '<details>',
      '<summary><b>Issue Details (click to expand)</b></summary>',
      '',
      'x'.repeat(3_000),
    ].join('\n');

    const result = buildPreviousReviewSummaryHistory(longSummary, {
      maxCharacters: 900,
    });

    expect(result.length).toBeLessThanOrEqual(900);
    expect(result).toContain(REVIEW_SUMMARY_HISTORY_START);
    expect(result).toContain(REVIEW_SUMMARY_HISTORY_END);
    expect(result).toContain('_[Snapshot truncated.]_');
    expect(result).toContain('Additional previous summary content was truncated');
    expect(result).toContain('</details>');
  });
});

describe('appendPreviousReviewSummaryHistory', () => {
  it('replaces model-supplied history with history built from the captured summary', () => {
    const modelHistory = buildPreviousReviewSummaryHistory('model supplied history');
    const currentBody = [cleanSummary, modelHistory, '', '---', '<!-- kilo-usage -->'].join('\n\n');

    const result = appendPreviousReviewSummaryHistory(
      currentBody,
      summaryWithIssues,
      'abcdef1234567890'
    );

    expect(result).toContain('**Status:** No Issues Found');
    expect(result).toContain('**Status:** 2 Issues Found');
    expect(result).not.toContain('model supplied history');
    expect(result).not.toContain('<!-- kilo-usage -->');
    expect(countOccurrences(result, REVIEW_SUMMARY_HISTORY_START)).toBe(1);
    expect(result).toContain('### Previous review (commit abcdef1)');
  });

  it('reserves space for the current summary and backend footer', () => {
    const maxBodyCharacters = 1_200;
    const reservedCharacters = 180;

    const result = appendPreviousReviewSummaryHistory(
      cleanSummary,
      `${summaryWithIssues}\n${'x'.repeat(3_000)}`,
      'abcdef1234567890',
      { maxBodyCharacters, reservedCharacters }
    );

    expect(result).toContain(REVIEW_SUMMARY_HISTORY_START);
    expect(result.length + reservedCharacters).toBeLessThanOrEqual(maxBodyCharacters);
  });

  it('omits history when the complete body leaves no room for an entry', () => {
    const result = appendPreviousReviewSummaryHistory(
      cleanSummary,
      summaryWithIssues,
      'abcdef1234567890',
      { maxBodyCharacters: cleanSummary.length + 100, reservedCharacters: 100 }
    );

    expect(result).toBe(cleanSummary);
    expect(result).not.toContain(REVIEW_SUMMARY_HISTORY_START);
  });

  it('leaves the current body unchanged when no previous summary was captured', () => {
    expect(appendPreviousReviewSummaryHistory(cleanSummary, null, null)).toBe(cleanSummary);
  });
});

describe('getCurrentReviewSummaryForContext', () => {
  it('strips history and backend footer from the current visible summary', () => {
    const history = buildPreviousReviewSummaryHistory(summaryWithIssues, {
      previousHeadSha: '9999999ddddddd',
    });
    const body = [
      cleanSummary,
      '',
      history,
      '',
      '---',
      '<!-- kilo-usage -->',
      '<sub>Reviewed by stale-model - 100 tokens</sub>',
    ].join('\n');

    const result = getCurrentReviewSummaryForContext(body);

    expect(result).toContain('No Issues Found');
    expect(result).toContain('## Code Review Summary');
    expect(result).not.toContain('<!-- kilo-review -->');
    expect(result).not.toContain('WARNING');
    expect(result).not.toContain(REVIEW_SUMMARY_HISTORY_START);
    expect(result).not.toContain('stale-model');
  });
});

describe('stripReviewSummaryHistory', () => {
  it('removes multiple complete history blocks', () => {
    const firstHistory = buildPreviousReviewSummaryHistory(summaryWithIssues, {
      previousHeadSha: 'aaaaaaa1111111',
    });
    const secondHistory = buildPreviousReviewSummaryHistory(cleanSummary, {
      previousHeadSha: 'bbbbbbb2222222',
    });
    const body = ['current summary', firstHistory, 'middle', secondHistory, 'tail'].join('\n\n');

    const result = stripReviewSummaryHistory(body);

    expect(result).toContain('current summary');
    expect(result).toContain('middle');
    expect(result).toContain('tail');
    expect(result).not.toContain(REVIEW_SUMMARY_HISTORY_START);
    expect(result).not.toContain('WARNING');
  });

  it('preserves malformed marker combinations and inline marker text', () => {
    const startOnly = `body\n${REVIEW_SUMMARY_HISTORY_START}\nold summary`;
    const endOnly = `body\n${REVIEW_SUMMARY_HISTORY_END}\nold summary`;
    const inlineMarkers = `body mentions ${REVIEW_SUMMARY_HISTORY_START} and ${REVIEW_SUMMARY_HISTORY_END} inline`;

    expect(stripReviewSummaryHistory(startOnly)).toBe(startOnly);
    expect(stripReviewSummaryHistory(endOnly)).toBe(endOnly);
    expect(stripReviewSummaryHistory(inlineMarkers)).toBe(inlineMarkers);
  });
});
