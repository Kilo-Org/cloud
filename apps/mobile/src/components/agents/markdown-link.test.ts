import { describe, expect, it } from 'vitest';

import { resolveLinkAccessibilityLabel } from './markdown-link';

describe('resolveLinkAccessibilityLabel', () => {
  it('prefers an explicit title', () => {
    expect(resolveLinkAccessibilityLabel('click here', 'https://example.com', 'Example site')).toBe(
      'Example site'
    );
  });

  it('falls back to the visible link text when there is no title', () => {
    expect(resolveLinkAccessibilityLabel('Kilo Code docs', 'https://kilo.ai/docs')).toBe(
      'Kilo Code docs'
    );
  });

  it('falls back to the URL host when the link text is not a plain string', () => {
    expect(resolveLinkAccessibilityLabel([], 'https://kilo.ai/docs/getting-started')).toBe(
      'kilo.ai'
    );
  });

  it('falls back to the raw href when no host can be parsed', () => {
    expect(resolveLinkAccessibilityLabel([], 'mailto:hello@kilo.ai')).toBe('mailto:hello@kilo.ai');
  });
});
