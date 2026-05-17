import {
  appendReviewSummaryFooter,
  appendUsageFooter,
  buildReviewGuidanceFooter,
  buildUsageFooter,
  stripReviewSummaryFooter,
} from './usage-footer';

describe('buildUsageFooter', () => {
  it('strips provider prefix from model slug', () => {
    const footer = buildUsageFooter('anthropic/claude-sonnet-4.6', 1000, 200);
    expect(footer).toContain('claude-sonnet-4.6');
    expect(footer).not.toContain('anthropic/');
  });

  it('keeps model name as-is when no provider prefix', () => {
    const footer = buildUsageFooter('gpt-4o', 500, 100);
    expect(footer).toContain('gpt-4o');
  });

  it('sums input and output tokens', () => {
    const footer = buildUsageFooter('model', 10000, 2345);
    expect(footer).toContain('12,345 tokens');
  });

  it('includes usage marker comment', () => {
    const footer = buildUsageFooter('model', 1, 2);
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

describe('appendReviewSummaryFooter', () => {
  it('appends usage and guidance in one footer block', () => {
    const body = '## Code Review Summary\n\nLooks good!';
    const result = appendReviewSummaryFooter(body, {
      usage: { model: 'anthropic/claude-sonnet-4.6', tokensIn: 5000, tokensOut: 1000 },
      reviewGuidance: { used: true, ref: 'main', truncated: false },
    });

    expect(result).toMatch(/^## Code Review Summary\n\nLooks good!\n\n---\n<!-- kilo-usage -->/);
    expect(result).toContain('6,000 tokens');
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
      usage: { model: 'new/new-model', tokensIn: 2000, tokensOut: 500 },
      reviewGuidance: { used: true, ref: 'main', truncated: true },
    });

    expect(result).toContain('new-model');
    expect(result).toContain('2,500 tokens');
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
      usage: { model: 'x/m', tokensIn: 1, tokensOut: 1 },
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
});

describe('appendUsageFooter', () => {
  it('keeps backward-compatible usage-only footer behavior', () => {
    const result = appendUsageFooter('body', 'provider/org/model-name', 100, 200);

    expect(result).toContain('org/model-name');
    expect(result).toContain('300 tokens');
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
