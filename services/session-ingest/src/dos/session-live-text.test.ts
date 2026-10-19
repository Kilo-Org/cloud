import { describe, expect, it } from 'vitest';

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

  it('returns null for non-strings and text that draws nothing', () => {
    expect(sessionLiveText(null, 40)).toBeNull();
    expect(sessionLiveText('\u200B\uFEFF\n', 40)).toBeNull();
  });
});
