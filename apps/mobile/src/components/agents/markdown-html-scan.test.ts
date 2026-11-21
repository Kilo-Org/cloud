import { type TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import { convertHtmlToMarkdown } from './markdown-html-convert';
import { findMarkdownImages, gateMarkdownImages } from './markdown-image-gate';
import { countMarkdownWork } from './markdown-work-counter.test-helpers';

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

  // The four cases below bound deterministic work, not wall clock: a shared
  // runner cannot separate the old shape from a busy machine. Measured on one
  // VM, the earlier implementation ran the emphasis, root-break, root-sibling
  // and image fixtures in 1259 ms, 3217 ms, 1537 ms and 1088 ms against 138 ms,
  // 42 ms, 255 ms and 176 ms here. This branch's slowest case was therefore only
  // 4.3x under the earlier implementation's fastest, and a suite-wide run on a
  // loaded machine already pushed two of these fixtures past the clock twice, so
  // no clock value both failed the old shape and passed this one.
  //
  // Each case measures the same pass on a quarter of the value and on all of
  // it. A per-construct tail walk grows about 16x at 4x input, while one pass
  // over each construct grows about 4x, so a bound of six times the quarter-size
  // work separates them with room for either shape's constant factor. The
  // `4 * value.length` allowance is there so an implementation that stops
  // copying entirely still passes; it cannot mask a quadratic shape, which
  // spends thousands of units per character. Every case warms its path with one
  // small call first, so the first call's compilation sits outside the
  // measurement.
  //
  // For the three convert cases the counter proves the conversion pass, not the
  // tokenizer: the shared `scanMarkdownCode` is quadratic on every revision, so
  // these cases compare copied work rather than characters read.
  it('joins many sibling emphasis tags in work linear in the input', () => {
    const siblings = 24_000;
    const small = `<p>${'<b>t</b>'.repeat(siblings / 4)}</p>`;
    const value = `<p>${'<b>t</b>'.repeat(siblings)}</p>`;
    convertHtmlToMarkdown('<p><b>t</b></p>');
    const smallWork = countMarkdownWork(() => void convertHtmlToMarkdown(small)).copiedUnits;
    let converted = '';
    const largeWork = countMarkdownWork(() => {
      converted = convertHtmlToMarkdown(value);
    }).copiedUnits;
    expect(largeWork).toBeLessThan(smallWork * 6 + value.length * 4);
    expect(converted).toBe('**t**'.repeat(siblings));
  });

  it('decides many root breaks in work linear in the input', () => {
    const breaks = 32_000;
    const small = `${'x<br>'.repeat(breaks / 4)}tail`;
    const value = `${'x<br>'.repeat(breaks)}tail`;
    convertHtmlToMarkdown('x<br>tail');
    const smallWork = countMarkdownWork(() => void convertHtmlToMarkdown(small)).copiedUnits;
    let converted = '';
    const largeWork = countMarkdownWork(() => {
      converted = convertHtmlToMarkdown(value);
    }).copiedUnits;
    expect(largeWork).toBeLessThan(smallWork * 6 + value.length * 4);
    expect(converted).toBe(`${'x\\\n'.repeat(breaks)}tail`);
  });

  it('converts many root-level siblings in work linear in the input', () => {
    const siblings = 40_000;
    const small = '<b>t</b>'.repeat(siblings / 4);
    const value = '<b>t</b>'.repeat(siblings);
    convertHtmlToMarkdown('<b>t</b>');
    const smallWork = countMarkdownWork(() => void convertHtmlToMarkdown(small)).copiedUnits;
    let converted = '';
    const largeWork = countMarkdownWork(() => {
      converted = convertHtmlToMarkdown(value);
    }).copiedUnits;
    expect(largeWork).toBeLessThan(smallWork * 6 + value.length * 4);
    expect(converted).toBe('**t**'.repeat(siblings));
  });

  it('gates many distinct images in work linear in the input', () => {
    const count = 12_000;
    const imageMarkdown = (images: number): string =>
      Array.from(
        { length: images },
        (_, index) => `![i${index}](https://evil.example/${index}.png)`
      ).join('\n\n');
    const smallValue = imageMarkdown(count / 4);
    const smallImages = findMarkdownImages(smallValue);
    expect(smallImages).toHaveLength(count / 4);
    const value = imageMarkdown(count);
    const images = findMarkdownImages(value);
    expect(images).toHaveLength(count);
    const warm = '![i](https://evil.example/i.png)';
    gateMarkdownImages(warm, findMarkdownImages(warm), t);
    // The lex and the lookup above are the caller's work; the gate's own pass is
    // what the counter covers, so each lex runs outside its measurement.
    const smallWork = countMarkdownWork(() => {
      gateMarkdownImages(smallValue, smallImages, t);
    }).readUnits;
    let gated = '';
    const largeWork = countMarkdownWork(() => {
      gated = gateMarkdownImages(value, images, t);
    }).readUnits;
    expect(largeWork).toBeLessThan(smallWork * 6 + value.length * 4);
    expect(gated).not.toContain('![');
    expect(gated.match(/kilo-image-load:/g)).toHaveLength(count);
  });
});
