import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearHtmlEmptinessCacheForTests,
  htmlSanitizesToEmpty,
} from './markdown-html-sanitization';

/** All-white nesting `depth` levels deep, with one text leaf inside. */
function nestedEmptyContainers(depth: number): string {
  return `${'<div>'.repeat(depth)}   ${'</div>'.repeat(depth)}`;
}

const replacesOf = (value: string) => {
  const spy = vi.spyOn(String.prototype, 'replace');
  htmlSanitizesToEmpty(value);
  const calls = spy.mock.calls.length;
  spy.mockRestore();
  return calls;
};

/**
 * The characters the emptiness scan reads through `String.prototype.indexOf`:
 * the distance each lookup travels, whether or not it finds its needle. A tail
 * walk is one lookup that reads the whole remainder, so this separates a scan
 * that re-reads the tail per tag from one that reads each region once; the call
 * count alone cannot, because either version makes about one call per tag.
 */
// The native lookup, captured before the spy replaces it. `Reflect.get` reads
// the function value without forming an unbound method reference.
const nativeIndexOf = Reflect.get(String.prototype, 'indexOf') as (
  this: string,
  search: string,
  from?: number
) => number;

function charactersRead(value: string): number {
  let read = 0;
  const spy = vi.spyOn(String.prototype, 'indexOf');
  spy.mockImplementation(function countScan(this: string, search: string, from = 0): number {
    const found = nativeIndexOf.call(this, search, from);
    read += found === -1 ? this.length - from : found - from + 1;
    return found;
  } as never);
  try {
    clearHtmlEmptinessCacheForTests();
    htmlSanitizesToEmpty(value);
  } finally {
    spy.mockRestore();
  }
  return read;
}

beforeEach(() => {
  clearHtmlEmptinessCacheForTests();
});

describe('htmlSanitizesToEmpty', () => {
  it('is true for whitespace-only text with no HTML', () => {
    expect(htmlSanitizesToEmpty('')).toBe(true);
    expect(htmlSanitizesToEmpty('  \n\t ')).toBe(true);
  });

  it('is false for ordinary streamed text with no HTML', () => {
    expect(htmlSanitizesToEmpty('thinking through the plan')).toBe(false);
  });

  it('is true for a removed element holding all the text', () => {
    expect(htmlSanitizesToEmpty('<style>.x{}</style>')).toBe(true);
    expect(htmlSanitizesToEmpty('<script>alert(1)</script>')).toBe(true);
    expect(htmlSanitizesToEmpty('<!-- comment only -->')).toBe(true);
  });

  it('is false when text survives the removals', () => {
    expect(htmlSanitizesToEmpty('<b>bold</b>')).toBe(false);
    expect(htmlSanitizesToEmpty('<style>.x{}</style>visible')).toBe(false);
  });

  it('collapses nested emptied containers', () => {
    expect(htmlSanitizesToEmpty(nestedEmptyContainers(4))).toBe(true);
    expect(htmlSanitizesToEmpty(`<div><span></span></div>`)).toBe(true);
  });

  it('reports nesting past the pass bound as visible instead of looping', () => {
    // Each pass only collapses the innermost emptied element, so a value nests
    // deeper than the bound still changes on its last pass. The answer then has
    // to be "visible": the part renders, which is the direction that cannot hide
    // a message.
    expect(htmlSanitizesToEmpty(nestedEmptyContainers(200))).toBe(false);
  });

  it('bounds the passes over one value independently of its nesting depth', () => {
    // Regression: the loop ran to a fixpoint, so each pass re-replaced the whole
    // value and a deeply nested one cost depth × length on the JS thread — on
    // every streamed publish. The bound is eight passes, and a pass is two
    // whole-value replaces beside the two linear removals, so the count does not
    // grow with the nesting depth past that bound.
    const shallow = replacesOf(nestedEmptyContainers(1));
    const deep = replacesOf(nestedEmptyContainers(200));
    expect(shallow).toBeLessThanOrEqual(16);
    expect(deep).toBeLessThanOrEqual(16);
    expect(deep).toBeGreaterThan(0);
  });

  it('answers a repeated value from the memo', () => {
    // The transcript rebuilds ask about the same part text again on every
    // publish; the answer is pure, so only the first ask pays for the removals.
    const value = '<div><span></span></div>';
    expect(htmlSanitizesToEmpty(value)).toBe(true);
    expect(replacesOf(value)).toBe(0);
  });

  it('memoizes the visible answer too', () => {
    const value = '<b>bold</b>';
    expect(htmlSanitizesToEmpty(value)).toBe(false);
    expect(replacesOf(value)).toBe(0);
  });

  it('agrees with the slow path across mixed streamed chunks', () => {
    const chunks = [
      'plain reasoning',
      '<b>bold reasoning',
      '</b>',
      'ampersand & entity &amp;',
      'trailing <',
      '',
      '   ',
    ];
    // Fast path (no '<') and slow path (with '<') are one function; this
    // pins the streamed no-'<' case against the removal cases.
    for (const chunk of chunks) {
      if (!chunk.includes('<')) {
        expect(htmlSanitizesToEmpty(chunk)).toBe(chunk.trim() === '');
      }
    }
    for (const chunk of chunks) {
      if (chunk.includes('<')) {
        // Every '<'-chunk above keeps non-whitespace text after the removals,
        // so the slow path must report visible content.
        expect(htmlSanitizesToEmpty(chunk)).toBe(false);
      }
    }
  });

  it('scans a value with many void removed tags in linear time', () => {
    // Regression: the container pattern paired `<input>` and `<source>` with a
    // closer that a void element cannot have, so every occurrence walked the
    // rest of the value on every streamed publish. Measured on the Android
    // emulator with the app's own bundle: 20,000 such tags took 14.2 s before
    // and 35 ms after, growing quadratically against linearly. Time the same
    // scaling here; the ratio is wide enough (about 15× for quadratic, about 4×
    // for linear) that a noisy runner cannot flip it, and the absolute bound
    // fails outright on the quadratic shape.
    const timeOf = (tags: number): number => {
      const value = `${'<input><source><link><meta>'.repeat(tags / 4)}visible`;
      clearHtmlEmptinessCacheForTests();
      const start = performance.now();
      expect(htmlSanitizesToEmpty(value)).toBe(false);
      return performance.now() - start;
    };
    // Warm the JIT so the first measurement is not the slow one.
    timeOf(4_000);
    const small = timeOf(5_000);
    const large = timeOf(20_000);
    // Four times the input: linear work stays under about 10×, the quadratic
    // shape lands near 16× and its absolute cost reaches hundreds of
    // milliseconds. Both assertions fail if the tail walk returns.
    expect(large).toBeLessThan(Math.max(small, 0.5) * 10);
    expect(large).toBeLessThan(400);
  });

  it('scans a value whose start tags never complete in one pass', () => {
    // A streaming part can arrive with start tags that have no `>` yet. The
    // scan must not re-read the remainder per tag: characters read stay
    // proportional to the value length, where a tail walk per tag reads
    // occurrences × length.
    const readsOf = (tags: number): number => charactersRead('<input><source>'.repeat(tags / 2));
    const small = readsOf(1_000);
    const large = readsOf(5_000);
    expect(large).toBeLessThan(small * 10);
  });

  it('folds a removed tag name without consulting the device locale', () => {
    // A tag name is an ASCII token, not display text. Folding it with the
    // device locale would make `INPUT` read as `ınput` under Turkish, so the
    // removed element would stop matching there and the answer would change.
    // The runner's own locale is not Turkish, so asserting the answer alone
    // cannot see that: this asserts the locale-aware call is never made, which
    // fails as soon as the fold consults the locale.
    const localeFold = vi.spyOn(String.prototype, 'toLocaleLowerCase');
    try {
      expect(htmlSanitizesToEmpty('<INPUT>hidden</INPUT>')).toBe(true);
      expect(htmlSanitizesToEmpty('<SCRIPT>x</SCRIPT>')).toBe(true);
      expect(htmlSanitizesToEmpty('<Style>.x{}</Style>')).toBe(true);
      // A non-ASCII look-alike is not a removed tag name, and its text stays
      // visible.
      expect(htmlSanitizesToEmpty('<ınput>text</ınput>')).toBe(false);
      expect(localeFold).not.toHaveBeenCalled();
    } finally {
      localeFold.mockRestore();
    }
  });

  it('answers the same as the previous pattern pipeline for generated values', () => {
    // The oracle is the two patterns this module replaced: the lazy
    // backreferenced container pattern and the lazy comment pattern, applied
    // in the same order the pipeline used. The linear scans must answer
    // identically for every value, including the shapes the patterns found
    // surprising: unterminated comments, a void start with no closer, a start
    // with an explicit closer, mixed case, and whitespace before a closer's
    // `>`.
    const container =
      /<(script|style|link|iframe|frame|frameset|object|embed|applet|audio|video|source|track|form|input|button|select|option|optgroup|textarea|label|fieldset|legend|datalist|output|meter|progress|svg|canvas|base|head|meta|title|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
    const removedTag =
      /<\/?(?:script|style|link|iframe|frame|frameset|object|embed|applet|audio|video|source|track|form|input|button|select|option|optgroup|textarea|label|fieldset|legend|datalist|output|meter|progress|svg|canvas|base|head|meta|title|template|noscript)\b[^>]*>/gi;
    const emptyContainer = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>\s*<\/\1\s*>/g;
    const oracleStep = (value: string) =>
      value
        .replaceAll(/<!--[\s\S]*?-->/g, '')
        .replaceAll(container, '')
        .replaceAll(removedTag, '')
        .replaceAll(emptyContainer, '');
    const oracle = (value: string) => {
      let sanitized = value;
      for (let pass = 0; pass < 8; pass += 1) {
        const next = oracleStep(sanitized);
        if (next === sanitized) {
          return next.trim() === '';
        }
        sanitized = next;
      }
      return false;
    };

    const pieces = [
      '<input>',
      '<source>',
      '<link>',
      '<meta>',
      '<base>',
      '<embed>',
      '<track>',
      '<frame>',
      '</input>',
      '</source >',
      '</source\n>',
      '<svg>',
      '</svg>',
      '<script>',
      '</script>',
      '<SCRIPT>x</script>',
      '<!--',
      '-->',
      '<!---->',
      '<div>',
      '</div>',
      '<span>',
      '</span>',
      '<b>',
      '</b>',
      '<input',
      '>',
      '<',
      '/',
      'text',
      ' ',
      '\n',
      '\t',
      'x',
    ];
    // A deterministic generator: a fixed seed keeps the corpus identical on
    // every run, so a failure is reproducible.
    let seed = 1;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const corpus: string[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      let value = '';
      const length = 2 + Math.floor(random() * 12);
      for (let part = 0; part < length; part += 1) {
        value += pieces[Math.floor(random() * pieces.length)];
      }
      corpus.push(value);
    }

    const disagreements = corpus.filter(value => htmlSanitizesToEmpty(value) !== oracle(value));
    expect(disagreements).toEqual([]);
  });
});
