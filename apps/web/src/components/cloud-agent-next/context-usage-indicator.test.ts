import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextUsageIndicator, formatContextUsageTooltip } from './ContextUsageIndicator';

function renderIndicator(contextTokens?: number, contextWindow?: number) {
  return renderToStaticMarkup(
    React.createElement(ContextUsageIndicator, { contextTokens, contextWindow })
  );
}

describe('ContextUsageIndicator', () => {
  it('renders a visible integer percentage in a named button trigger', () => {
    const html = renderIndicator(32_418, 80_000);

    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>32.4K \(41%\)<\/button>/);
    expect(html).toContain('aria-label="41% of context used. 32,418 of 80,000 tokens used."');
  });

  it('matches the CLI compact token-count label', () => {
    expect(renderIndicator(239_100, 1_000_000)).toContain('239.1K (24%)');
  });

  it('preserves rendered percentages above one hundred', () => {
    expect(renderIndicator(101, 100)).toContain('101 (101%)');
  });

  it.each([undefined, 0, -1])('omits markup for invalid context window %s', contextWindow => {
    expect(renderIndicator(32_418, contextWindow)).toBe('');
  });

  it('does not announce streaming updates as live status changes', () => {
    const html = renderIndicator(32_418, 80_000);

    expect(html).not.toContain('aria-live');
    expect(html).not.toContain('role="status"');
  });
});

describe('formatContextUsageTooltip', () => {
  it('formats exact token counts with stable grouping', () => {
    expect(formatContextUsageTooltip(32_418, 80_000)).toBe('32,418 / 80,000 tokens used');
  });
});
