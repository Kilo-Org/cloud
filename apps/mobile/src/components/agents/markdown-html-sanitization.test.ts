import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearHtmlEmptinessCacheForTests,
  htmlRemovalPassesForTests,
  htmlSanitizedForTests,
  htmlSanitizesToEmpty,
} from './markdown-html-sanitization';

/** All-white nesting `depth` levels deep, with one text leaf inside. */
function nestedEmptyContainers(depth: number): string {
  return `${'<div>'.repeat(depth)}   ${'</div>'.repeat(depth)}`;
}

/**
 * The characters the emptiness scan reads through `String.prototype.indexOf`
 * and through a sticky or global regex `exec`: the distance each lookup
 * travels, whether or not it finds its needle, plus the length of every sticky
 * or global match. A tail walk is one lookup that reads the whole remainder, so
 * this separates a scan that re-reads the tail per tag from one that reads each
 * region once; the call count alone cannot, because either version makes about
 * one call per tag.
 *
 * A whole-value regex replace is invisible to that model: the engine scans
 * inside `RegExp.prototype[Symbol.replace]`, so a `[^>]*` rescan reads no
 * countable characters. {@link countScans} counts those replaces separately, so
 * a pipeline that rebuilds the whole value per pass cannot look like a scan.
 */
// The natives, captured before the spies replace them. `Reflect.get` reads the
// function value without forming an unbound method reference.
const nativeIndexOf = Reflect.get(String.prototype, 'indexOf') as (
  this: string,
  search: string,
  from?: number
) => number;
const nativeExec = Reflect.get(RegExp.prototype, 'exec') as (
  this: RegExp,
  value: string
) => RegExpExecArray | null;
const nativeReplace = Reflect.get(RegExp.prototype, Symbol.replace) as (
  this: RegExp,
  value: string,
  replaceValue: unknown
) => string;

/** What one cold scan of a value costs, under the spy model above. */
type ScanCost = { readonly reads: number; readonly wholeValueReplaces: number };

/** Runs `run` with both scans and whole-value regex replaces counted. */
function countScans(run: () => void): ScanCost {
  let read = 0;
  let wholeValueReplaces = 0;
  const indexSpy = vi.spyOn(String.prototype, 'indexOf');
  indexSpy.mockImplementation(function countScan(this: string, search: string, from = 0): number {
    const found = nativeIndexOf.call(this, search, from);
    read += found === -1 ? this.length - from : found - from + 1;
    return found;
  } as never);
  const execSpy = vi.spyOn(RegExp.prototype, 'exec');
  execSpy.mockImplementation(function countMatch(this: RegExp, value: string) {
    // Only a sticky or global pattern starts from `lastIndex`, so only those
    // read forward; the distance to the match, or to the end on a miss, is what
    // the engine scanned.
    const start = this.lastIndex;
    const match = nativeExec.call(this, value);
    if (this.sticky || this.global) {
      read +=
        match === null ? Math.max(value.length - start, 0) : match.index - start + match[0].length;
    }
    return match;
  } as never);
  // `String.prototype.replace` and `replaceAll` dispatch here with a regex
  // pattern, so this sees every whole-value rebuild, including the inner
  // rescan of a `[^>]*` that the character model cannot.
  const replaceSpy = vi.spyOn(RegExp.prototype, Symbol.replace);
  replaceSpy.mockImplementation(function countReplace(
    this: RegExp,
    value: string,
    replaceValue: unknown
  ) {
    wholeValueReplaces += 1;
    return nativeReplace.call(this, value, replaceValue);
  } as never);
  try {
    run();
  } finally {
    indexSpy.mockRestore();
    execSpy.mockRestore();
    replaceSpy.mockRestore();
  }
  return { reads: read, wholeValueReplaces };
}

/** What one cold scan of `value` costs. */
function scanCost(value: string): ScanCost {
  return countScans(() => {
    clearHtmlEmptinessCacheForTests();
    htmlSanitizesToEmpty(value);
  });
}

/** The characters one cold scan of `value` reads. */
function charactersRead(value: string): number {
  return scanCost(value).reads;
}

/** The characters a warm ask about `value` reads: zero once it is memoized. */
function readsOnWarmCache(value: string): number {
  return countScans(() => {
    htmlSanitizesToEmpty(value);
  }).reads;
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

  it('does not call a value empty when the bound ran out before it settled', () => {
    // The exact boundary: eight levels still change on the eighth pass, so the
    // loop never proved a fixpoint and the value must report visible content
    // even though that last pass left an empty string. Seven levels converge on
    // the eighth pass and stay empty. Reading the last pass's string as an
    // answer instead of its outcome would flip eight levels to "empty" and
    // silently drop a part the renderer draws.
    expect(htmlSanitizedForTests(nestedEmptyContainers(8))).toBeUndefined();
    expect(htmlSanitizesToEmpty(nestedEmptyContainers(8))).toBe(false);
    expect(htmlSanitizedForTests(nestedEmptyContainers(7))).toBe('');
    expect(htmlSanitizesToEmpty(nestedEmptyContainers(7))).toBe(true);
  });

  it('bounds the passes over one value independently of its nesting depth', () => {
    // Regression: the loop ran to a fixpoint, so each pass re-scanned the whole
    // value and a deeply nested one cost depth × length on the JS thread — on
    // every streamed publish. The bound is eight passes.
    // One level of nesting converges on the second pass: one collapse, then a
    // pass that changes nothing (2 passes). Two hundred levels still change on
    // the eighth pass and spend the whole bound (8 passes). Both counts are
    // exact, so a raised bound or a lost removal step fails here.
    expect(htmlRemovalPassesForTests(nestedEmptyContainers(1))).toBe(2);
    expect(htmlRemovalPassesForTests(nestedEmptyContainers(200))).toBe(8);
  });

  it('answers a repeated value from the memo', () => {
    // The transcript rebuilds ask about the same part text again on every
    // publish; the answer is pure, so only the first ask pays for the removals.
    const value = '<div><span></span></div>';
    expect(htmlSanitizesToEmpty(value)).toBe(true);
    expect(readsOnWarmCache(value)).toBe(0);
  });

  it('memoizes the visible answer too', () => {
    const value = '<b>bold</b>';
    expect(htmlSanitizesToEmpty(value)).toBe(false);
    expect(readsOnWarmCache(value)).toBe(0);
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
    // Regression: the removal pipeline rebuilt the whole value once per pattern,
    // per pass, and the container pattern paired `<input>` and `<source>` with a
    // closer a void element cannot have, so every occurrence walked the rest of
    // the value; 20,000 such tags took 14.2 s on the Android emulator with the
    // app's own bundle, and 35 ms with the linear scans.
    // Two properties are asserted because no single metric sees both:
    //  - no whole-value regex replace happens. A pattern's own `[^>]*` rescan
    //    runs inside `RegExp.prototype[Symbol.replace]`, so the characters-read
    //    model counts nothing for it, and a pipeline of whole-value replaces
    //    scores exactly like one linear scan (measured: ratio 4.00 on the old
    //    pipeline, which is why this test passed on it). Zero replaces is the
    //    property a rewrite must keep.
    //  - the characters read through `indexOf`/`exec` grow with the value, not
    //    per tag: a scan that re-reads the tail per tag reads occurrences ×
    //    length, while one that reads each region once reads the value about
    //    twice. A wall-clock sample on a shared runner cannot tell those apart.
    // The corpus is the four void removed elements repeated, then visible text,
    // so no tag can ever close.
    const costOf = (tags: number) =>
      scanCost(`${'<input><source><link><meta>'.repeat(tags / 4)}visible`);
    const small = costOf(5_000);
    const large = costOf(20_000);
    expect(small.wholeValueReplaces).toBe(0);
    expect(large.wholeValueReplaces).toBe(0);
    // Four times the input: the linear scan reads about 4×, the per-tag tail
    // walk about 16×.
    expect(large.reads).toBeLessThan(small.reads * 5);
  });

  it('reads a whitespace tail after a start tag once, not once per candidate', () => {
    // The shape a streamed frame produces mid-tag: many start tags, then the
    // only `>`, then a whitespace run. Every candidate `<` before that `>` looks
    // for its closer after the same `>`, so a scan that re-searches the `\s*`
    // tail per candidate reads candidates × tail. At 8,000 candidates and 14,000
    // more tail characters the head revision read 112,070,000 extra characters
    // (16,138,005 at m=2,000 against 128,208,005 at m=16,000); a scan that
    // answers the tail once per `>` read 84,000 (132,005 and 216,005).
    const readsOf = (tail: number): number =>
      charactersRead(`${'<a'.repeat(8_000)}>${' '.repeat(tail)}`);
    const small = readsOf(2_000);
    const large = readsOf(16_000);
    // At the measured 6 reads per tail character, 14,000 more characters cost
    // 84,000. The bound allows 20 per character, 3× the measurement and still
    // 400× below the per-candidate product.
    expect(large - small).toBeLessThan(14_000 * 20);
  });

  it('scans a value whose start tags never complete in one pass', () => {
    // A streaming part can arrive with start tags that have no `>` yet. The
    // scan must not re-read the remainder per tag: characters read stay
    // proportional to the value length, where a tail walk per tag reads
    // occurrences × length.
    const readsOf = (tags: number): number => charactersRead('<input><source>'.repeat(tags / 2));
    const small = readsOf(1_000);
    const large = readsOf(4_000);
    expect(large).toBeLessThan(small * 5);
  });

  it('scans a value with unterminated start tags in linear cost', () => {
    // The shape a streamed frame produces mid-tag: `n` unterminated `<input`
    // start tags, then a single `>`, then `n` more `<input` tags with no `>` of
    // their own. Both old whole-value patterns walked the remainder at every
    // candidate `<`, so this read n² characters. The `>` belongs to none of the
    // leading tags, so a lookup started at each tag's own name end reads the run
    // once per tag; one forwarding cursor reads it once, and the first tag past
    // the `>` finds no terminator at all and ends the scan.
    const readsOf = (n: number): number =>
      charactersRead(`${'<input'.repeat(n)}>${'<input'.repeat(n)}`);
    const small = readsOf(1_000);
    const large = readsOf(4_000);
    expect(large).toBeLessThan(small * 5);
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
          return { empty: next.trim() === '', settled: sanitized };
        }
        sanitized = next;
      }
      // The bound ran out while the value still changed, so the pipeline never
      // proved a fixpoint: it reports visible content, and no settled string
      // exists to compare.
      return { empty: false, settled: undefined };
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
      // Hyphenated and word-boundary names: the container name run continues
      // past a `-`, while the old pattern's `\b` let the name group backtrack to
      // a shorter prefix that still ends at a word boundary. `</a>` closing
      // `<a->` is the case only that backtracking matches.
      '<div-x>',
      '</div-x>',
      '<a-b>',
      '</a-b>',
      '<ab>',
      '</ab>',
      '<a->',
      '</a>',
      // A closer name strictly longer than the open run. The backreference can
      // only reach a closer's name when the common prefix spans that whole
      // closer, and nothing shorter is reachable, so `<a></a-bc>` must keep its
      // text; the scan's length guard is the line that enforces it, and this
      // piece is what makes dropping that guard fail.
      '<a></a-bc>',
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

    const expected = corpus.map(value => oracle(value));
    const booleanDisagreements = corpus.filter(
      (value, index) => htmlSanitizesToEmpty(value) !== expected[index]?.empty
    );
    expect(booleanDisagreements).toEqual([]);
    // Identical emptiness alone would hide a scan that keeps a different
    // substring: where the pipeline proved a fixpoint, the settled string must
    // match the pattern pipeline's. A value that exhausted the bound has no
    // settled string on either side, and its answer is already compared above.
    const stringDisagreements = corpus.filter(
      (value, index) => htmlSanitizedForTests(value) !== expected[index]?.settled
    );
    expect(stringDisagreements).toEqual([]);
  });
});
