import { type TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import { convertHtmlToMarkdown } from './markdown-html-convert';
import { findMarkdownImages, gateMarkdownImages } from './markdown-image-gate';

// The trusted-image-host store reaches SecureStore, Sentry and the toast
// bridge on import; these cases only convert and rewrite markdown.
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const t = ((key: string) => key) as unknown as TFunction;

const HEAD = '<b>head</b> x< ';
const TAIL = '<b>tail</b>';

describe('convertHtmlToMarkdown generated fixtures', () => {
  it('completes the large fixture within its processing budget', () => {
    const value = `${HEAD}${'`a`b'.repeat(32_000)}${TAIL}`;
    const start = performance.now();
    const converted = convertHtmlToMarkdown(value);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(750);
    expect(converted).toBe(`**head** x< ${'`a`b'.repeat(32_000)}${TAIL}`);
  });

  it('converts the short fixture exactly', () => {
    expect(convertHtmlToMarkdown(`${HEAD}${'`a`b'.repeat(20)}${TAIL}`)).toBe(
      `**head** x< ${'`a`b'.repeat(20)}**tail**`
    );
  });

  it('preserves closing emphasis in the generated fixture', () => {
    const value = `<b>${'`x` '.repeat(4097)}</b>`;
    expect(convertHtmlToMarkdown(value)).toBe(`**${'`x` '.repeat(4097).trimEnd()}** `);
  });

  // The four cases below repeat one construct far past the point where a pass
  // that re-reads the rest of the value per construct stays inside the budget.
  // Each size keeps the earlier implementation well above the budget while
  // leaving this one clear of it on a busy machine. Each case warms its path
  // first, so the timed span measures the pass and not the first call's
  // compilation of it.
  it('joins many sibling emphasis tags within its processing budget', () => {
    const siblings = 24_000;
    const value = `<p>${'<b>t</b>'.repeat(siblings)}</p>`;
    convertHtmlToMarkdown('<p><b>t</b></p>');
    const start = performance.now();
    const converted = convertHtmlToMarkdown(value);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(750);
    expect(converted).toBe('**t**'.repeat(siblings));
  });

  it('decides many root breaks on one line within its processing budget', () => {
    const breaks = 32_000;
    const value = `${'x<br>'.repeat(breaks)}tail`;
    convertHtmlToMarkdown('x<br>tail');
    const start = performance.now();
    const converted = convertHtmlToMarkdown(value);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(750);
    expect(converted).toBe(`${'x\\\n'.repeat(breaks)}tail`);
  });

  it('converts many root-level siblings within its processing budget', () => {
    const siblings = 40_000;
    const value = '<b>t</b>'.repeat(siblings);
    convertHtmlToMarkdown('<b>t</b>');
    const start = performance.now();
    const converted = convertHtmlToMarkdown(value);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(750);
    expect(converted).toBe('**t**'.repeat(siblings));
  });

  it('gates many distinct images within its processing budget', () => {
    const count = 12_000;
    const value = Array.from(
      { length: count },
      (_, index) => `![i${index}](https://evil.example/${index}.png)`
    ).join('\n\n');
    const images = findMarkdownImages(value);
    expect(images).toHaveLength(count);
    const warm = '![i](https://evil.example/i.png)';
    gateMarkdownImages(warm, findMarkdownImages(warm), t);
    // The lex and the lookup above are the caller's work; the gate's own pass is
    // what the budget covers.
    const start = performance.now();
    const gated = gateMarkdownImages(value, images, t);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(750);
    expect(gated).not.toContain('![');
    expect(gated.match(/kilo-image-load:/g)).toHaveLength(count);
  });
});
