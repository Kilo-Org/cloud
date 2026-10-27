import { describe, expect, it, vi } from 'vitest';

import { sessionLiveText } from '@kilocode/session-ingest-contracts';

describe('sessionLiveText', () => {
  it('keeps only the characters it draws', () => {
    expect(sessionLiveText('report\u202Efdp.exe', 40)).toBe('reportfdp.exe');
    expect(sessionLiveText('\u2066ls -la\u2069', 40)).toBe('ls -la');
    expect(
      sessionLiveText(
        'a\u061Cb\u200Ec\u200Fd\u202Ae\u202Bf\u202Cg\u202Dh\u202Ei\u2066j\u2067k\u2068l\u2069m',
        40
      )
    ).toBe('abcdefghijklm');
    expect(sessionLiveText('a\u200Bb\u200Ec\u200Fd', 40)).toBe('abcd');
    expect(sessionLiveText('a\u200Bb\u2060c\uFEFFd', 40)).toBe('abcd');
    expect(sessionLiveText('pnpm\u200B install\uFEFF --frozen-lockfile', 40)).toBe(
      'pnpm install --frozen-lockfile'
    );
  });

  it('keeps the zero-width joiners that shape adjacent characters', () => {
    expect(sessionLiveText('a\u200Cb\u200Dc', 40)).toBe('a\u200Cb\u200Dc');
    expect(sessionLiveText('می\u200Cشود', 40)).toBe('می\u200Cشود');
    expect(sessionLiveText('👨\u200D👩\u200D👧', 40)).toBe('👨\u200D👩\u200D👧');
  });

  it('counts only the characters that draw toward the limit', () => {
    const visible = `${'x'.repeat(10)}${'y'.repeat(30)}`;
    expect(sessionLiveText(`${'x'.repeat(10)}\u200B${'y'.repeat(30)}`, 40)).toBe(visible);
    expect(sessionLiveText(`${'x'.repeat(10)}\u200B${'y'.repeat(31)}`, 40)).toBe(
      `${'x'.repeat(10)}${'y'.repeat(29)}…`
    );
  });

  it('leaves right-to-left letters and ordinary text unchanged', () => {
    expect(sessionLiveText('مرحبا بالعالم', 40)).toBe('مرحبا بالعالم');
    expect(sessionLiveText('Fix the login bug', 40)).toBe('Fix the login bug');
  });

  it('still maps line breaks and control characters to one space', () => {
    expect(sessionLiveText('a\u0000b\nc', 40)).toBe('a b c');
    expect(sessionLiveText('  a\u2028\u2029b  ', 40)).toBe('a b');
  });

  it('cuts on character boundaries, not inside a drawn sequence', () => {
    // A family emoji is four people and three joiners: one drawn character.
    expect(sessionLiveText('abc👨‍👩‍👧def', 8)).toBe('abc…');
    expect(sessionLiveText('abc👨‍👩‍👧def', 12)).toBe('abc👨‍👩‍👧…');
    // A flag is two regional indicators, one drawn character.
    expect(sessionLiveText('abc🇷🇸def', 6)).toBe('abc…');
    expect(sessionLiveText('abc🇷🇸def', 8)).toBe('abc🇷🇸…');
    // A letter and its combining mark are one drawn character.
    expect(sessionLiveText('abe\u0301cd', 4)).toBe('ab…');
    expect(sessionLiveText('abe\u0301cd', 5)).toBe('abe\u0301…');
    // A skin-tone modifier and a keycap belong to the character they modify.
    expect(sessionLiveText('abc👍🏽def', 7)).toBe('abc…');
    expect(sessionLiveText('abc👍🏽def', 8)).toBe('abc👍🏽…');
    expect(sessionLiveText('abc4\u20e3def', 5)).toBe('abc…');
    expect(sessionLiveText('abc4\u20e3def', 6)).toBe('abc4\u20e3…');
  });

  it('keeps every cut inside the limit and on a drawn character boundary', () => {
    const line = `run ${'👨‍👩‍👧'.repeat(6)} now`;
    const boundaries = new Set([
      ...[...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].map(
        ({ index }) => index
      ),
      // The last segment ends at the end of the line, which a segment does not report.
      line.length,
    ]);
    for (let limit = 1; limit <= line.length; limit += 1) {
      const cut = sessionLiveText(line, limit);
      expect(cut).not.toBeNull();
      expect(cut!.length).toBeLessThanOrEqual(limit);
      const body = cut!.endsWith('…') ? cut!.slice(0, -1) : cut!;
      expect(line.startsWith(body)).toBe(true);
      expect(boundaries.has(body.length)).toBe(true);
    }
  });

  it('falls back to a code unit boundary when the runtime has no segmenter', async () => {
    const actual = globalThis.Intl;
    try {
      vi.stubGlobal('Intl', { Segmenter: undefined });
      vi.resetModules();
      // A dynamic import re-evaluates the module, which is the only way to reach
      // the absent-segmenter branch once the module has cached its segmenter.
      const { sessionLiveText: withoutSegmenter } =
        await import('@kilocode/session-ingest-contracts/session-live-summary');
      // The fallback keeps a code unit boundary, so it can stop between a flag's
      // two indicators, while it never splits a surrogate pair.
      expect(withoutSegmenter('ab🇷🇸cd', 5)).toBe('ab🇷…');
      expect(withoutSegmenter('ab😀cd', 4)).toBe('ab…');
      vi.stubGlobal('Intl', actual);
      vi.resetModules();
      // The same fresh module with segmentation in place drops the whole flag.
      const { sessionLiveText: withSegmenter } =
        await import('@kilocode/session-ingest-contracts/session-live-summary');
      expect(withSegmenter('ab🇷🇸cd', 5)).toBe('ab…');
    } finally {
      vi.stubGlobal('Intl', actual);
      vi.resetModules();
    }
  });

  it('reads a segmenter that arrives after an earlier cut', async () => {
    const actual = globalThis.Intl;
    try {
      vi.stubGlobal('Intl', { Segmenter: undefined });
      vi.resetModules();
      // A dynamic import re-evaluates the module, which is the only way to give
      // this case a process that has not built a segmenter yet.
      const { sessionLiveText: cut } =
        await import('@kilocode/session-ingest-contracts/session-live-summary');
      // The first cut runs before the runtime has a segmenter, so it keeps code
      // units: the app installs that polyfill into the same process it draws in.
      expect(cut('ab🇷🇸cd', 5)).toBe('ab🇷…');
      vi.stubGlobal('Intl', actual);
      // Same module instance, so only a fresh look at `Intl` can see it.
      expect(cut('ab🇷🇸cd', 5)).toBe('ab…');
    } finally {
      vi.stubGlobal('Intl', actual);
      vi.resetModules();
    }
  });

  it('returns null for non-strings, blanks, and joiner-only text', () => {
    expect(sessionLiveText(null, 40)).toBeNull();
    expect(sessionLiveText('\u200B\uFEFF\n', 40)).toBeNull();
    expect(sessionLiveText('\u200C\u200D', 40)).toBeNull();
  });
});
