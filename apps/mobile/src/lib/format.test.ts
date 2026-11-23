/* eslint-disable max-lines -- the format helpers and the device clock probe share one suite, and the probe's CommonJS seam needs its own stub: a second file would duplicate that seam */
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only probe seam: the app's clock probe reaches the native module through Node's own `require`, so the test must write to that cache
import { createRequire } from 'node:module';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only probe seam: the cache entry's `path` field is the resolved module's own directory
import { dirname } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SUPPORTED_LANGUAGES } from '@/i18n/languages';

import {
  firstGrapheme,
  foldDecimalDigits,
  formatCalendarDate,
  formatClockTime,
  formatDate,
  formatDuration,
  formatDurationIncludingZero,
  formatFileSize,
  formatList,
  formatNumber,
  formatPrefixedMoney,
  formatPrefixedUsd,
  formatSignedPrefixedMoney,
  normalizeLocalizedNumber,
  parseLocalizedNumber,
} from './format';

/** The shape `formatPrefixedMoney` pins, and the four-digit shape below it. */
const TWO_DIGITS = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
} satisfies Intl.NumberFormatOptions;
const FOUR_DIGITS = {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
} satisfies Intl.NumberFormatOptions;

const nodeRequire = createRequire(import.meta.url);
const deviceLocalizationPath = nodeRequire.resolve('expo-localization');

/** Where the next case starts the fake clock, always past the probe's last memo stamp. */
let deviceClock = Date.now();

/**
 * Answer the app's device clock probe with `uses24hourClock`.
 *
 * The probe reaches the native module through Node's own `require`, so
 * `vi.mock('expo-localization')` cannot reach it: that mock only intercepts the
 * module graph Vite builds. A test worker also has no native module to answer,
 * so the real `require` throws. Installing an entry in the same CommonJS cache
 * the probe reads is the seam both of those leave open, which is why this
 * reaches through `createRequire` instead of stubbing a global. The probe
 * memoizes for a second, so each case starts the fake clock past the stamp the
 * previous case left in that memo; a fresh `vi.useFakeTimers()` alone starts at
 * the real time and would read the memo instead of the stub.
 */
function stubDeviceCalendars(uses24hourClock: boolean | null): void {
  nodeRequire.cache[deviceLocalizationPath] = {
    children: [],
    exports: { getCalendars: () => [{ uses24hourClock }] },
    filename: deviceLocalizationPath,
    id: deviceLocalizationPath,
    isPreloading: false,
    loaded: true,
    parent: null,
    path: dirname(deviceLocalizationPath),
    paths: [],
    require: nodeRequire,
  } satisfies NodeJS.Module;
  deviceClock += 2000;
  vi.useFakeTimers({ now: deviceClock });
}

describe('formatPrefixedUsd', () => {
  it("leads the prefixed amount with the symbol and the locale's own sign", () => {
    expect(
      formatPrefixedUsd(1234.5, 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    ).toBe('$1,234.50');
    expect(formatPrefixedUsd(1234.5, 'en-US')).toBe('$1,234.5');
    expect(
      formatPrefixedUsd(-5, 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    ).toBe('-$5.00');
    // Several languages write a different minus glyph; the sign is the
    // formatter's own part, not ASCII.
    expect(formatPrefixedUsd(-5, 'sv')[0]).toBe('\u2212');
    // A right-to-left language keeps the digits of its own formatter and no
    // separating space between the symbol and the number.
    const ar = formatPrefixedUsd(0, 'ar');
    expect(ar.startsWith('$')).toBe(true);
    expect(ar).not.toContain('\u00A0');
  });

  it('writes a negative that rounds to zero as the locale’s own unsigned zero', () => {
    // The five inputs the two-decimal shape has to get right, side by side.
    const twoDigits = [
      [0, '$0.00'],
      [-0, '$0.00'],
      [-0.001, '$0.00'],
      [0.004, '$0.00'],
      [-5, '-$5.00'],
    ] as const;
    for (const [amount, expected] of twoDigits) {
      expect(formatPrefixedUsd(amount, 'en-US', TWO_DIGITS)).toBe(expected);
    }
    // The locale's own zero, digits, separators and direction marks included.
    for (const locale of ['de-DE', 'pt-BR', 'hi', 'ar-EG', 'fa']) {
      expect(formatPrefixedUsd(-0.004, locale, TWO_DIGITS)).toBe(
        `$${formatNumber(0, locale, TWO_DIGITS)}`
      );
    }
    // The same input at four digits is a real amount, so it keeps its sign, and
    // below the fourth digit it rounds back to that unsigned zero.
    expect(formatPrefixedUsd(-0.001, 'en-US', FOUR_DIGITS)).toBe('-$0.0010');
    expect(formatPrefixedUsd(-0.00004, 'en-US', FOUR_DIGITS)).toBe('$0.0000');
  });

  it('keeps a visible debit signed and refuses a caller plus', () => {
    // A half cent rounds to a cent at these digits, so the debit is visible.
    expect(formatPrefixedUsd(-0.005, 'en-US', TWO_DIGITS)).toBe('-$0.01');
    expect(formatPrefixedUsd(-0.5, 'de-DE', TWO_DIGITS)).toBe('-$0,50');
    // The plus is the ledger shape's job: a caller asking for one cannot sign
    // an ordinary money figure, and cannot sign a rounded zero back into a plus.
    expect(formatPrefixedUsd(5, 'en-US', { ...TWO_DIGITS, signDisplay: 'always' })).toBe('$5.00');
    expect(formatPrefixedUsd(-0.004, 'en-US', { ...TWO_DIGITS, signDisplay: 'exceptZero' })).toBe(
      '$0.00'
    );
  });
});

describe('formatPrefixedMoney', () => {
  it('leads the symbol in every locale, with that locale’s digits and separators', () => {
    expect(formatPrefixedMoney(1234.5, 'en-US')).toBe('$1,234.50');
    // German writes the same group and decimal separators it writes for the
    // locale money pattern; only the symbol's side changed.
    expect(formatPrefixedMoney(1234.5, 'de-DE')).toBe('$1.234,50');
    // Brazilian Portuguese used to trail its symbol ("1.234,50 $"); the group
    // and decimal separators are still its own.
    expect(formatPrefixedMoney(1234.5, 'pt-BR')).toBe('$1.234,50');
  });

  it('pins two fraction digits on a whole amount', () => {
    expect(formatPrefixedMoney(7, 'en-US')).toBe('$7.00');
    expect(formatPrefixedMoney(0, 'de-DE')).toBe('$0,00');
  });

  it('puts the locale’s minus sign in front of the symbol', () => {
    expect(formatPrefixedMoney(-5, 'en-US')).toBe('-$5.00');
    expect(formatPrefixedMoney(-5, 'sv').startsWith('\u2212$')).toBe(true);
  });

  it('drops the sign from a negative that rounds to zero cents', () => {
    expect(formatPrefixedMoney(-0.004, 'en-US')).toBe('$0.00');
    expect(formatPrefixedMoney(-0.004, 'de-DE')).toBe('$0,00');
    // A half cent still rounds to a cent, and keeps its sign.
    expect(formatPrefixedMoney(-0.005, 'en-US')).toBe('-$0.01');
  });

  it('writes the symbol first and no separating space in a right-to-left language', () => {
    const ar = formatPrefixedMoney(1234.5, 'ar');
    expect(ar.startsWith('$')).toBe(true);
    expect(ar).not.toContain('\u00A0');
  });
});

describe('formatSignedPrefixedMoney', () => {
  it('says the direction of a credit, a debit and a zero', () => {
    expect(formatSignedPrefixedMoney(12.5, 'en-US')).toBe('+$12.50');
    expect(formatSignedPrefixedMoney(-5, 'sv')).toBe('\u2212$5,00');
    // A zero moved nothing, so it takes no direction mark at all — and neither
    // does a debit the formatter rounds to that zero.
    expect(formatSignedPrefixedMoney(0, 'en-US')).toBe('$0.00');
    expect(formatSignedPrefixedMoney(-0, 'en-US')).toBe('$0.00');
    expect(formatSignedPrefixedMoney(-0.004, 'en-US')).toBe('$0.00');
    // A half cent is visible, so it keeps the direction it holds.
    expect(formatSignedPrefixedMoney(-0.005, 'en-US')).toBe('-$0.01');
    expect(formatSignedPrefixedMoney(0.005, 'en-US')).toBe('+$0.01');
  });

  it('keeps each locale’s digits, separators and minus glyph', () => {
    expect(formatSignedPrefixedMoney(1234.5, 'de-DE')).toBe('+$1.234,50');
    expect(formatSignedPrefixedMoney(0, 'ar-EG')).toBe('$٠٫٠٠');
  });

  it('drops the directional literal ICU writes beside a sign', () => {
    // Arabic is where ICU adds it; the caller's isolate already pins the run,
    // and a spoken label reads the bare figure.
    expect(formatSignedPrefixedMoney(12.5, 'ar')).toBe('+$12.50');
    // The ordinary shapes keep their bytes: this shape owns the strip.
    expect(formatPrefixedMoney(12.5, 'ar')).toBe('$12.50');
  });
});

describe('localized format helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    // A fake in the CommonJS cache would answer another file in this worker.
    // oxlint-disable-next-line typescript-eslint/no-dynamic-delete -- the cache is keyed by the resolved module path, so the key is only known at run time
    delete nodeRequire.cache[deviceLocalizationPath];
  });

  it('keeps the padded hour of a twenty-four-hour locale', () => {
    stubDeviceCalendars(null);
    const twoForty = new Date(2026, 0, 1, 2, 40);
    expect(formatDate(twoForty, 'yo', { hour: 'numeric', minute: '2-digit' })).toBe('02:40');
    expect(formatClockTime(twoForty, 'yo')).toBe('02:40');
  });

  it('reads a twenty-four-hour clock on a device set to one', () => {
    stubDeviceCalendars(true);
    expect(formatClockTime(new Date(2026, 0, 1, 13, 45), 'en')).toBe('13:45');
  });

  it('reads a twelve-hour clock on a device set to one', () => {
    stubDeviceCalendars(false);
    expect(formatClockTime(new Date(2026, 0, 1, 13, 45), 'en')).toBe('1:45 PM');
  });

  it('formats a list and preserves one grapheme', () => {
    expect(formatList(['A', 'B'], 'de')).toBe('A und B');
    expect(formatFileSize(1024, 'de')).toBe('1,02 kB');
    expect(firstGrapheme('👨‍👩‍👧‍👦 family', 'en')).toBe('👨‍👩‍👧‍👦');
  });

  it('pluralizes a whole-byte size in the active language', () => {
    expect(formatFileSize(1, 'en')).toBe('1 byte');
    expect(formatFileSize(564, 'en')).toBe('564 bytes');
    expect(formatFileSize(999, 'en')).toBe('999 bytes');
    // A count of 1000 bytes or more reaches the kilobyte unit, which keeps the
    // abbreviated form.
    expect(formatFileSize(1000, 'en')).toBe('1 kB');
    expect(formatFileSize(1024, 'en')).toBe('1.02 kB');
    expect(formatFileSize(1_048_576, 'en')).toBe('1.05 MB');
    expect(formatFileSize(1_073_741_824, 'en')).toBe('1.07 GB');
    // A count that rounds up to the next step takes the next unit's name, so a
    // figure the unit cannot hold is never printed.
    expect(formatFileSize(999_500, 'en')).toBe('999.5 kB');
    expect(formatFileSize(999_999, 'en')).toBe('1 MB');
    expect(formatFileSize(999_999_999, 'en')).toBe('1 GB');
    // The promotion rounds at the digits the unit shows, so a fractional byte
    // count just under the step promotes instead of printing "1,000 bytes", and
    // the top step is the last one, holding any larger count.
    expect(formatFileSize(999.5, 'en')).toBe('1 kB');
    expect(formatFileSize(1_000_000_000_000, 'en')).toBe('1 TB');
    expect(formatFileSize(1_000_000_000_000_000, 'en')).toBe('1,000 TB');
  });

  it('parses localized numbers and rejects other input', () => {
    expect(parseLocalizedNumber('1.234,5', 'de-DE')).toBe(1234.5);
    expect(parseLocalizedNumber('1 234,5', 'ru')).toBe(1234.5);
    expect(parseLocalizedNumber('١٢٣٤', 'ar-EG')).toBe(1234);
    expect(parseLocalizedNumber('twelve', 'en')).toBeNull();
  });

  it('parses the digits a native-script keypad types in any locale', () => {
    expect(parseLocalizedNumber('٢٥', 'ar')).toBe(25);
    expect(parseLocalizedNumber('۲۵', 'ar')).toBe(25);
    expect(parseLocalizedNumber('२५', 'hi')).toBe(25);
    expect(parseLocalizedNumber('২৫', 'bn')).toBe(25);
    expect(parseLocalizedNumber('၂၅', 'my')).toBe(25);
  });

  it('parses ASCII digits typed in a locale that formats with its own digits', () => {
    expect(parseLocalizedNumber('25', 'ar-EG')).toBe(25);
    expect(parseLocalizedNumber('٢٥', 'ar-EG')).toBe(25);
  });

  it('keeps the locale separators around folded digits', () => {
    expect(parseLocalizedNumber('١٬٢٣٤٫٥', 'ar-EG')).toBe(1234.5);
    expect(parseLocalizedNumber('1,234.5', 'ar')).toBe(1234.5);
  });

  it('folds a value whose digits come from two scripts', () => {
    expect(parseLocalizedNumber('٢5', 'ar')).toBe(25);
  });

  it('folds digits whose sets are adjacent in the code chart', () => {
    // Mathematical double-struck digits (U+1D7D8) follow the bold set with no
    // gap, and the Myanmar Pao set (U+116D0) touches the Eastern Pwo Karen one.
    expect(parseLocalizedNumber('𝟚𝟝', 'en')).toBe(25);
    expect(parseLocalizedNumber('𝟘', 'en')).toBe(0);
    expect(parseLocalizedNumber('𑛚𑛟', 'en')).toBe(5);
  });

  it('still rejects a value with a non-digit left in it', () => {
    expect(parseLocalizedNumber('٢٥x', 'ar')).toBeNull();
    expect(parseLocalizedNumber('٢٥٫٥٫٥', 'ar-EG')).toBeNull();
  });

  it.each(SUPPORTED_LANGUAGES)('round-trips its own formatted amount in %s', tag => {
    expect(parseLocalizedNumber(formatNumber(25.5, tag), tag)).toBe(25.5);
    expect(parseLocalizedNumber(formatNumber(1234.5, tag), tag)).toBe(1234.5);
  });

  it('normalizes to an ASCII literal so callers can compare magnitudes', () => {
    expect(normalizeLocalizedNumber('1.234,5', 'de-DE')).toBe('1234.5');
    expect(normalizeLocalizedNumber(' 1 234,5 ', 'ru')).toBe('1234.5');
    expect(normalizeLocalizedNumber('-12', 'en')).toBe('-12');
    expect(normalizeLocalizedNumber('twelve', 'en')).toBeNull();
    expect(normalizeLocalizedNumber('', 'en')).toBeNull();
    // Longer than a JS number can hold: the literal survives, the parse does not.
    expect(normalizeLocalizedNumber('9'.repeat(950), 'en')).toBe('9'.repeat(950));
    expect(parseLocalizedNumber('9'.repeat(950), 'en')).toBeNull();
  });

  it('formats a calendar date without a time-zone shift', () => {
    expect(formatCalendarDate('2026-08-03', 'en-US')).toBe('8/3/2026');
  });
});

describe('formatDurationIncludingZero', () => {
  it('writes the zero duration that formatDuration drops', () => {
    expect(formatDuration(0, 'en')).toBe('');
    expect(formatDurationIncludingZero(0, 'en')).toBe('0 sec');
  });

  it('keeps the plain duration once a second has elapsed', () => {
    expect(formatDurationIncludingZero(1, 'en')).toBe('1 sec');
    expect(formatDurationIncludingZero(59, 'en')).toBe('59 sec');
    expect(formatDurationIncludingZero(60, 'en')).toBe('1 min');
    expect(formatDurationIncludingZero(3725, 'en')).toBe('1 hr, 2 min, 5 sec');
  });

  it.each(SUPPORTED_LANGUAGES)('names the zero in its own digits in %s', tag => {
    expect(formatDurationIncludingZero(0, tag)).toContain(formatNumber(0, tag));
  });
});

describe('parseLocalizedNumber', () => {
  it('parses the forms the active language writes', () => {
    expect(parseLocalizedNumber('1.234,5', 'de-DE')).toBe(1234.5);
    expect(parseLocalizedNumber('1,5', 'de-DE')).toBe(1.5);
    expect(parseLocalizedNumber('1 234,5', 'ru')).toBe(1234.5);
    expect(parseLocalizedNumber('1,234.5', 'en-US')).toBe(1234.5);
    expect(parseLocalizedNumber('1.5', 'en-US')).toBe(1.5);
    expect(parseLocalizedNumber('1234', 'en-US')).toBe(1234);
    expect(parseLocalizedNumber('-2,5', 'de-DE')).toBe(-2.5);
    // The Indian numbering system groups the last three digits, then twos.
    expect(parseLocalizedNumber('1,23,456', 'hi')).toBe(123_456);
  });

  it('round-trips the digits and separators of a non-Latin locale', () => {
    expect(parseLocalizedNumber(formatNumber(1234.5, 'fa'), 'fa')).toBe(1234.5);
    expect(parseLocalizedNumber(formatNumber(1.5, 'bn'), 'bn')).toBe(1.5);
  });

  it('rejects input whose separators do not fit the locale', () => {
    // The field validates against the active language's separators and group
    // positions, so a value shaped for another language is not accepted.
    expect(parseLocalizedNumber('1.5', 'de-DE')).toBeNull();
    expect(parseLocalizedNumber('1,5', 'en-US')).toBeNull();
    expect(parseLocalizedNumber('1,23,456', 'en-US')).toBeNull();
    expect(parseLocalizedNumber('1,234.5', 'de-DE')).toBeNull();
    expect(parseLocalizedNumber('1,234,5', 'en-US')).toBeNull();
    expect(parseLocalizedNumber('1 5', 'en-US')).toBeNull();
    expect(parseLocalizedNumber('18,5', 'ar')).toBeNull();
    expect(parseLocalizedNumber('twelve', 'en')).toBeNull();
  });

  it('keeps accepting a partial decimal the way the field is typed', () => {
    expect(parseLocalizedNumber('1,', 'de-DE')).toBe(1);
    expect(parseLocalizedNumber(',5', 'de-DE')).toBe(0.5);
  });
});

describe('parseLocalizedNumber with the device keypad separator', () => {
  it('reads the decimal the device keypad writes when the language cannot', () => {
    // German app language on a device whose number keyboard writes `.`.
    expect(parseLocalizedNumber('2.5', 'de-DE', '.')).toBe(2.5);
    expect(parseLocalizedNumber('0.05', 'de-DE', '.')).toBe(0.05);
    expect(parseLocalizedNumber('2.', 'de-DE', '.')).toBe(2);
    expect(parseLocalizedNumber('.5', 'de-DE', '.')).toBe(0.5);
    // The mirror case: English app language on a comma keypad.
    expect(parseLocalizedNumber('2,5', 'en-US', ',')).toBe(2.5);
  });

  it('keeps the language reading when the language grammar can read the input', () => {
    expect(parseLocalizedNumber('1.234,5', 'de-DE', '.')).toBe(1234.5);
    expect(parseLocalizedNumber('1.234.567', 'de-DE', '.')).toBe(1_234_567);
    expect(parseLocalizedNumber('1,234.5', 'en-US', ',')).toBe(1234.5);
    // A space-sized group and the device separator sit together.
    expect(parseLocalizedNumber('1.5', 'ru', '.')).toBe(1.5);
    expect(parseLocalizedNumber('1 234,5', 'ru', '.')).toBe(1234.5);
  });

  it('rejects input the two readings disagree on', () => {
    expect(parseLocalizedNumber('1.234', 'de-DE', '.')).toBeNull();
    expect(parseLocalizedNumber('12.345', 'de-DE', '.')).toBeNull();
    expect(parseLocalizedNumber('1,234', 'en-US', ',')).toBeNull();
  });

  it('changes nothing when the device writes the language separator', () => {
    expect(parseLocalizedNumber('2.5', 'en-US', '.')).toBe(2.5);
    expect(parseLocalizedNumber('2,5', 'de-DE', ',')).toBe(2.5);
    expect(parseLocalizedNumber('1,5', 'en-US', '.')).toBeNull();
    expect(parseLocalizedNumber('1.5', 'de-DE', ',')).toBeNull();
  });

  it('returns the ASCII literal of the reading that decides', () => {
    expect(normalizeLocalizedNumber('2.5', 'de-DE', '.')).toBe('2.5');
    expect(normalizeLocalizedNumber('1.234,5', 'de-DE', '.')).toBe('1234.5');
    expect(normalizeLocalizedNumber('1.234', 'de-DE', '.')).toBeNull();
  });
});

describe('foldDecimalDigits', () => {
  it('converts the Arabic-Indic digits a phone keyboard types for a code', () => {
    expect(foldDecimalDigits('٢٤٦٨١٠')).toBe('246810');
  });

  it.each([
    ['Extended Arabic-Indic', '۲۴۶۸۱۰'],
    ['Devanagari', '२४६८१०'],
    ['Bengali', '২৪৬৮১০'],
    ['Myanmar', '၂၄၆၈၁၀'],
  ])('converts %s digits', (_script, digits) => {
    expect(foldDecimalDigits(digits)).toBe('246810');
  });

  it('converts digits a Latin-numbering locale formats as Latin', () => {
    expect(foldDecimalDigits('๒๔๖๘๑๐')).toBe('246810');
    expect(foldDecimalDigits('໒໔໖໘໑໐')).toBe('246810');
    expect(foldDecimalDigits('２４６８１０')).toBe('246810');
  });

  it('reads one digit from a run that holds several digit sets', () => {
    // U+1D7CE–U+1D7FF is one run of five sets: the value is the offset from the
    // run start modulo ten, so double-struck zero reads as 0, not 10.
    expect(foldDecimalDigits('𝟚𝟜𝟞𝟠𝟙𝟘')).toBe('246810');
    expect(foldDecimalDigits('𝟘')).toBe('0');
    expect(foldDecimalDigits('𝟡')).toBe('9');
  });

  it('converts each digit of a mixed-script value and leaves other characters alone', () => {
    expect(foldDecimalDigits('٢٤6٨๑0')).toBe('246810');
    expect(foldDecimalDigits('24a6')).toBe('24a6');
    expect(foldDecimalDigits('')).toBe('');
  });
});
