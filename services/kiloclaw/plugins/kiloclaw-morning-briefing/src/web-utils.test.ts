import { describe, expect, it } from 'vitest';
import { normalizeWebResults } from './web-utils';

describe('web-utils', () => {
  it('strips external wrapper markers and truncates noisy summaries', () => {
    const results = normalizeWebResults({
      results: [
        {
          title:
            '<<<EXTERNAL_UNTRUSTED_CONTENT id="x">>>\nSource: Web Search\n---\nVercel Flags is now generally available\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="x">>>',
          url: 'https://vercel.com/changelog/vercel-flags-ga',
          description:
            '<<<EXTERNAL_UNTRUSTED_CONTENT id="y">>>\nSource: Web Search\n---\n# Vercel Flags is now generally available\n[...]\nPublished: April 16, 2026\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="y">>>',
        },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Vercel Flags is now generally available');
    expect(results[0].summary.includes('EXTERNAL_UNTRUSTED_CONTENT')).toBe(false);
  });

  it('falls back to hostname when title is empty', () => {
    const results = normalizeWebResults({
      results: [
        {
          url: 'https://example.com/news',
          summary: 'Simple summary',
        },
      ],
    });

    expect(results[0].title).toBe('example.com');
  });
});
