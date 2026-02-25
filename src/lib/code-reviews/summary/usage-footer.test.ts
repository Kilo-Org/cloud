import { buildUsageFooter, appendUsageFooter } from './usage-footer';

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

  it('includes horizontal rule and marker comment', () => {
    const footer = buildUsageFooter('model', 1, 2);
    expect(footer).toContain('---');
    expect(footer).toContain('<!-- kilo-usage -->');
  });
});

describe('appendUsageFooter', () => {
  it('appends footer to body with no existing footer', () => {
    const body = '## Code Review Summary\n\nLooks good!';
    const result = appendUsageFooter(body, 'anthropic/claude-sonnet-4.6', 5000, 1000);
    expect(result).toMatch(/^## Code Review Summary\n\nLooks good!\n\n---\n<!-- kilo-usage -->/);
    expect(result).toContain('6,000 tokens');
  });

  it('replaces existing footer (exact pattern match)', () => {
    const body =
      '## Summary\n\nContent\n\n---\n<!-- kilo-usage -->\n<sub>Reviewed by old-model · 100 tokens</sub>';
    const result = appendUsageFooter(body, 'new/new-model', 2000, 500);
    expect(result).toContain('new-model');
    expect(result).toContain('2,500 tokens');
    expect(result).not.toContain('old-model');
    // Should only have one marker
    expect(result.match(/<!-- kilo-usage -->/g)?.length).toBe(1);
  });

  it('replaces footer with different leading whitespace', () => {
    // Simulate a case where the marker exists but with extra newlines before ---
    const body = '## Summary\n\nContent\n\n\n---\n\n<!-- kilo-usage -->\n<sub>old footer</sub>';
    const result = appendUsageFooter(body, 'x/model', 100, 50);
    expect(result).toContain('model');
    expect(result).toContain('150 tokens');
    expect(result).not.toContain('old footer');
    expect(result.match(/<!-- kilo-usage -->/g)?.length).toBe(1);
  });

  it('handles empty body', () => {
    const result = appendUsageFooter('', 'provider/model', 10, 5);
    expect(result).toContain('<!-- kilo-usage -->');
    expect(result).toContain('15 tokens');
  });

  it('preserves unrelated horizontal rules in the body', () => {
    const body = '## Summary\n\n---\n\nSome section\n\nMore content';
    const result = appendUsageFooter(body, 'x/m', 1, 1);
    // The original --- should still be present
    expect(result).toContain('## Summary\n\n---\n\nSome section\n\nMore content');
  });

  it('handles model slug with multiple slashes', () => {
    const result = appendUsageFooter('body', 'provider/org/model-name', 100, 200);
    expect(result).toContain('org/model-name');
  });
});
