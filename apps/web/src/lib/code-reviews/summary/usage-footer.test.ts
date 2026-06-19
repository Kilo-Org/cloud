import {
  appendReviewSummaryFooter,
  appendUsageFooter,
  buildReviewGuidanceFooter,
  buildReviewSummaryFooter,
  buildUsageFooter,
  formatTokenCount,
  stripReviewSummaryFooter,
} from './usage-footer';
import { REVIEW_SUMMARY_HISTORY_END, REVIEW_SUMMARY_HISTORY_START } from './history';

describe('formatTokenCount', () => {
  it.each([
    [999, '999'],
    [1100, '1.1K'],
    [1_000_000, '1M'],
  ])('formats %i as %s', (count, expected) => {
    expect(formatTokenCount(count)).toBe(expected);
  });
});

describe('buildUsageFooter', () => {
  it('strips provider prefix from model slug', () => {
    const footer = buildUsageFooter('anthropic/claude-sonnet-4.6', 1000, 200, 300);
    expect(footer).toContain('claude-sonnet-4.6');
    expect(footer).not.toContain('anthropic/');
  });

  it('keeps model name as-is when no provider prefix', () => {
    const footer = buildUsageFooter('gpt-4o', 500, 100, 0);
    expect(footer).toContain('gpt-4o');
  });

  it('renders the exact split token usage', () => {
    const footer = buildUsageFooter('provider/minimax-m3', 64_730, 5_400, 919_981);

    expect(footer).toBe(
      '<!-- kilo-usage -->\n<sub>Reviewed by minimax-m3 · Input: 64.7K · Output: 5.4K · Cached: 920K</sub>'
    );
  });

  it('renders zero cached tokens', () => {
    const footer = buildUsageFooter('provider/minimax-m3', 1000, 200, 0);

    expect(footer).toBe(
      '<!-- kilo-usage -->\n<sub>Reviewed by minimax-m3 · Input: 1K · Output: 200 · Cached: 0</sub>'
    );
  });

  it('includes usage marker comment', () => {
    const footer = buildUsageFooter('model', 1, 2, 3);
    expect(footer).toContain('<!-- kilo-usage -->');
  });
});

describe('buildReviewGuidanceFooter', () => {
  it('renders guidance when REVIEW.md was used', () => {
    const footer = buildReviewGuidanceFooter({ used: true, ref: 'main', truncated: false });

    expect(footer).toContain('<!-- kilo-review-guidance -->');
    expect(footer).toContain('Review guidance: REVIEW.md from base branch `main`');
  });

  it('includes truncated marker when applicable', () => {
    const footer = buildReviewGuidanceFooter({ used: true, ref: 'main', truncated: true });

    expect(footer).toContain('`main` (truncated)');
  });

  it('escapes unusual base refs safely', () => {
    const footer = buildReviewGuidanceFooter({
      used: true,
      ref: 'feat/`tick`-<tag>&',
      truncated: false,
    });

    expect(footer).toContain('&lt;tag&gt;&amp;');
    expect(footer).not.toContain('<tag>');
    expect(footer).toContain('`` feat/`tick`-&lt;tag&gt;&amp; ``');
  });
});

describe('buildReviewSummaryFooter', () => {
  it('returns the exact suffix appended to the summary body', () => {
    const footerData = {
      usage: {
        model: 'anthropic/claude-sonnet-4.6',
        tokensIn: 5000,
        tokensOut: 1000,
        cachedTokens: 2000,
      },
      reviewGuidance: { used: true, ref: 'main', truncated: false },
    };
    const footer = buildReviewSummaryFooter(footerData);

    expect(`body${footer}`).toBe(appendReviewSummaryFooter('body', footerData));
    expect(footer).toMatch(/^\n\n---\n<!-- kilo-usage -->/);
  });

  it('returns an empty suffix when no footer metadata is available', () => {
    expect(buildReviewSummaryFooter({})).toBe('');
  });
});

describe('appendReviewSummaryFooter', () => {
  it('appends usage and guidance in one footer block', () => {
    const body = '## Code Review Summary\n\nLooks good!';
    const result = appendReviewSummaryFooter(body, {
      usage: {
        model: 'anthropic/claude-sonnet-4.6',
        tokensIn: 5000,
        tokensOut: 1000,
        cachedTokens: 2000,
      },
      reviewGuidance: { used: true, ref: 'main', truncated: false },
    });

    expect(result).toMatch(/^## Code Review Summary\n\nLooks good!\n\n---\n<!-- kilo-usage -->/);
    expect(result).toContain('Input: 5K · Output: 1K · Cached: 2K');
    expect(result).toContain('<!-- kilo-review-guidance -->');
    expect(result).toContain('Review guidance: REVIEW.md from base branch `main`');
    expect(result.match(/^---$/gm)?.length).toBe(1);
  });

  it('replaces old footer content with exactly one usage marker and one guidance marker', () => {
    const body = [
      '## Summary',
      '',
      'Content',
      '',
      '---',
      '<!-- kilo-usage -->',
      '<sub>Reviewed by old-model · 100 tokens</sub>',
      '<!-- kilo-review-guidance -->',
      '<sub>Review guidance: REVIEW.md from base branch `develop`</sub>',
    ].join('\n');
    const result = appendReviewSummaryFooter(body, {
      usage: { model: 'new/new-model', tokensIn: 2000, tokensOut: 500, cachedTokens: 1500 },
      reviewGuidance: { used: true, ref: 'main', truncated: true },
    });

    expect(result).toContain('new-model');
    expect(result).toContain('Input: 2K · Output: 500 · Cached: 1.5K');
    expect(result).toContain('`main` (truncated)');
    expect(result).not.toContain('old-model');
    expect(result).not.toContain('develop');
    expect(result.match(/<!-- kilo-usage -->/g)?.length).toBe(1);
    expect(result.match(/<!-- kilo-review-guidance -->/g)?.length).toBe(1);
    expect(result.match(/^---$/gm)?.length).toBe(1);
  });

  it('does not append guidance when metadata says unused', () => {
    const result = appendReviewSummaryFooter('body', {
      reviewGuidance: { used: false, ref: 'main', truncated: false },
    });

    expect(result).toBe('body');
    expect(result).not.toContain('<!-- kilo-review-guidance -->');
  });

  it('preserves unrelated horizontal rules in the body', () => {
    const body = '## Summary\n\n---\n\nSome section\n\nMore content';
    const result = appendReviewSummaryFooter(body, {
      usage: { model: 'x/m', tokensIn: 1, tokensOut: 1, cachedTokens: 0 },
    });

    expect(result).toContain('## Summary\n\n---\n\nSome section\n\nMore content');
    expect(result.match(/^---$/gm)?.length).toBe(2);
  });

  it('does not truncate the body when a marker appears outside the backend footer block', () => {
    const body = [
      '## Summary',
      '',
      'Agent mentioned <!-- kilo-usage --> as text.',
      '',
      'More body content that must stay.',
    ].join('\n');
    const result = appendReviewSummaryFooter(body, {
      reviewGuidance: { used: true, ref: 'main', truncated: false },
    });

    expect(result).toContain('Agent mentioned <!-- kilo-usage --> as text.');
    expect(result).toContain('More body content that must stay.');
    expect(result.match(/<!-- kilo-usage -->/g)?.length).toBe(1);
    expect(result.match(/<!-- kilo-review-guidance -->/g)?.length).toBe(1);
  });

  it('replaces footer when only guidance existed previously', () => {
    const body = [
      'body',
      '',
      '---',
      '<!-- kilo-review-guidance -->',
      '<sub>Review guidance: REVIEW.md from base branch `old`</sub>',
    ].join('\n');
    const result = appendReviewSummaryFooter(body, {
      reviewGuidance: { used: true, ref: 'new', truncated: false },
    });

    expect(result).toContain('`new`');
    expect(result).not.toContain('`old`');
    expect(result.match(/<!-- kilo-review-guidance -->/g)?.length).toBe(1);
  });

  it('preserves summary history before appending a fresh backend footer', () => {
    const body = [
      '## Summary',
      '',
      'Current content',
      '',
      REVIEW_SUMMARY_HISTORY_START,
      '<details>',
      '<summary><b>Previous Review Summary</b></summary>',
      '',
      '**Status:** 1 Issue Found',
      '',
      '</details>',
      REVIEW_SUMMARY_HISTORY_END,
    ].join('\n');
    const result = appendReviewSummaryFooter(body, {
      usage: { model: 'x/m', tokensIn: 1, tokensOut: 2, cachedTokens: 3 },
    });

    expect(result).toContain(REVIEW_SUMMARY_HISTORY_START);
    expect(result).toContain('**Status:** 1 Issue Found');
    expect(result.indexOf(REVIEW_SUMMARY_HISTORY_END)).toBeLessThan(
      result.indexOf('<!-- kilo-usage -->')
    );
    expect(result.match(/<!-- kilo-usage -->/g)?.length).toBe(1);
  });
});

describe('appendUsageFooter', () => {
  it('keeps backward-compatible usage-only footer behavior', () => {
    const result = appendUsageFooter('body', 'provider/org/model-name', 100, 200);

    expect(result).toContain('org/model-name');
    expect(result).toContain('Input: 100 · Output: 200 · Cached: 0');
    expect(result).toContain('<!-- kilo-usage -->');
  });
});

describe('stripReviewSummaryFooter', () => {
  it('removes backend usage and guidance footer', () => {
    const body = [
      'summary body',
      '',
      '---',
      '<!-- kilo-usage -->',
      '<sub>Reviewed by model · 100 tokens</sub>',
      '<!-- kilo-review-guidance -->',
      '<sub>Review guidance: REVIEW.md from base branch `main`</sub>',
    ].join('\n');

    expect(stripReviewSummaryFooter(body)).toBe('summary body');
  });

  it('does not remove marker text without a backend footer block', () => {
    const body = 'summary body\n\n<!-- kilo-review-guidance --> appears in text';

    expect(stripReviewSummaryFooter(body)).toBe(body);
  });
});
