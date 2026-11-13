import { describe, expect, it } from 'vitest';

import { displaySafeText } from './display-text';

describe('displaySafeText', () => {
  it('leaves an ordinary command exactly as it is', () => {
    expect(displaySafeText('rg todo 2>/dev/null')).toBe('rg todo 2>/dev/null');
    expect(displaySafeText('pnpm test --filter @kilocode/app-shared')).toBe(
      'pnpm test --filter @kilocode/app-shared'
    );
    expect(displaySafeText('/var/tmp/scope/**')).toBe('/var/tmp/scope/**');
  });

  it('leaves non-Latin text readable, including joined scripts', () => {
    expect(displaySafeText('echo "مرحبا"')).toBe('echo "مرحبا"');
    expect(displaySafeText('echo שלום')).toBe('echo שלום');
    expect(displaySafeText('echo नमस्ते')).toBe('echo नमस्ते');
    expect(displaySafeText('echo "क्‍ष"')).toBe('echo "क्‍ष"');
    expect(displaySafeText('echo 👋🏽')).toBe('echo 👋🏽');
  });

  it('spells out a format character', () => {
    expect(displaySafeText('echo \u202Erm -rf /\u202C')).toBe('echo \\u202erm -rf /\\u202c');
    expect(displaySafeText('\u2066a\u2069')).toBe('\\u2066a\\u2069');
    expect(displaySafeText('\u2068a\u2069')).toBe('\\u2068a\\u2069');
    expect(displaySafeText('\u200Ea\u200F')).toBe('\\u200ea\\u200f');
    expect(displaySafeText('\u061Ca')).toBe('\\u061ca');
    expect(displaySafeText('a\u200Bb')).toBe('a\\u200bb');
    expect(displaySafeText('a\u2060b')).toBe('a\\u2060b');
    expect(displaySafeText('a\uFEFFb')).toBe('a\\ufeffb');
    expect(displaySafeText('a\u2028b\u2029c')).toBe('a\\u2028b\\u2029c');
  });

  it('spells out a line break and the other control characters', () => {
    expect(displaySafeText('first\nsecond')).toBe('first\\nsecond');
    expect(displaySafeText('a\rb\tc')).toBe('a\\rb\\tc');
    expect(displaySafeText('a\u0000b')).toBe('a\\x00b');
    expect(displaySafeText('a\u0007b')).toBe('a\\x07b');
    expect(displaySafeText('a\u001Bb[31mred')).toBe('a\\x1bb[31mred');
    expect(displaySafeText('a\u007Fb')).toBe('a\\x7fb');
    expect(displaySafeText('a\u0085b')).toBe('a\\x85b');
    expect(displaySafeText('a\u009Fb')).toBe('a\\x9fb');
  });

  it('keeps the joiners that shape a joined script', () => {
    expect(displaySafeText('a\u200Cb')).toBe('a\u200Cb');
    expect(displaySafeText('a\u200Db')).toBe('a\u200Db');
  });

  it('prints a literal backslash as two backslashes', () => {
    expect(displaySafeText('echo \\u202E')).toBe('echo \\\\u202E');
    expect(displaySafeText('C:\\tmp\\n')).toBe('C:\\\\tmp\\\\n');
    expect(displaySafeText('\\')).toBe('\\\\');
  });

  it('spells out a soft hyphen', () => {
    expect(displaySafeText('a\u00ADb')).toBe('a\\u00adb');
    expect(displaySafeText('\u00AD')).toBe('\\u00ad');
  });

  it('spells out a format character above the Basic Multilingual Plane', () => {
    expect(displaySafeText('a\u{E0001}b')).toBe('a\\U000E0001b');
    expect(displaySafeText('a\u{E007F}b')).toBe('a\\U000E007Fb');
  });

  it('spells out an invisible filler', () => {
    expect(displaySafeText('a\u3164b')).toBe('a\\u3164b');
    expect(displaySafeText('\u115F\u1160\u2800\uFFA0')).toBe('\\u115f\\u1160\\u2800\\uffa0');
  });

  it('keeps a combining mark and a variation selector', () => {
    expect(displaySafeText('e\u0301')).toBe('e\u0301');
    expect(displaySafeText('a\u0308\u0304b')).toBe('a\u0308\u0304b');
    expect(displaySafeText('\u2764\uFE0F')).toBe('\u2764\uFE0F');
  });

  it('keeps an astral character whole', () => {
    expect(displaySafeText('\u{1F44B}')).toBe('\u{1F44B}');
  });
});
