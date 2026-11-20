import { describe, expect, it, vi } from 'vitest';

import { boxTop, estimateWidth, lineBox } from './active-agents-widget-parts';
import { ascent } from './script-metrics';

vi.mock('react-native-android-widget', () => ({
  FlexWidget: () => null,
  ImageWidget: () => null,
  OverlapWidget: () => null,
  TextWidget: () => null,
}));

/** Roboto's ascent plus font padding, and Roboto's line box, per unit of font size. */
const BASELINE = 1.056;
const LATIN_LINE = 1.32;
/** The box the shipping layouts were calibrated to for Arabic-Indic and Brahmic scripts. */
const TALL_LINE = 1.62;
/** The metrics are measured per em, so a large size separates scripts the dp sizes merge. */
const EM = 100;

describe('Line box per script', () => {
  it('keeps Roboto for Latin text', () => {
    expect(lineBox('Working', 11)).toBe(Math.ceil(11 * LATIN_LINE));
    expect(lineBox('Working', EM)).toBe(EM * LATIN_LINE);
  });

  it('gives Thai and Myanmar the box of their own fallback font', () => {
    const latin = Math.ceil(11 * LATIN_LINE);
    expect(lineBox('กำลังทำงาน', 11)).toBe(16);
    expect(lineBox('กำลังทำงาน', 11)).toBeGreaterThan(latin);
    expect(lineBox('အလုပ်လုပ်နေသည်', 11)).toBeGreaterThan(lineBox('กำลังทำงาน', 11));
    expect(lineBox('အလုပ်လုပ်နေသည်', EM)).toBe(219);
  });

  it('takes the measured box of every script outside the old range', () => {
    expect(lineBox('עובד', EM)).toBe(137);
    expect(lineBox('ກຳລັງເຮັດວຽກ', EM)).toBe(165);
    expect(lineBox('កំពុងធ្វើការ', EM)).toBe(187);
    expect(lineBox('მუშაობს', EM)).toBe(136);
    expect(lineBox('աշխատում', EM)).toBe(136);
    expect(lineBox('በመስራት ላይ', EM)).toBe(137);
  });

  it('never shrinks a script the old 1.62em box covered', () => {
    expect(lineBox('काम करत आहे', EM)).toBe(EM * TALL_LINE);
    // Arabic measures taller than the floor it shipped with.
    expect(lineBox('جارٍ العمل', EM)).toBe(171);
    expect(lineBox('العمل', 11)).toBe(Math.ceil(11 * 1.703));
  });

  it('takes the tallest box among a mixed line', () => {
    expect(lineBox('Aก', EM)).toBe(Math.ceil(EM * 1.372));
    expect(lineBox('Aအ', EM)).toBe(Math.ceil(EM * 2.184));
  });
});

describe('Ascent per script', () => {
  it('keeps Roboto for Latin text', () => {
    expect(ascent('Working', 11)).toBe(BASELINE * 11);
  });

  it('adds font padding to a fallback font own ascent', () => {
    expect(ascent('กำลังทำงาน', 11)).toBeCloseTo(11 * (1.116 + 0.128));
    expect(ascent('جارٍ العمل', 11)).toBeCloseTo(11 * (1.069 + 0.128));
    expect(ascent('အလုပ်လုပ်နေသည်', 11)).toBeCloseTo(11 * (1.324 + 0.128));
  });
});

describe('Box top', () => {
  it('places a Latin line by Roboto exactly as before', () => {
    expect(boxTop('Working', 11, 100)).toBe(100 - BASELINE * 11);
    expect(boxTop('Working', 20, 92)).toBe(92 - BASELINE * 20);
  });

  it('keeps a taller line centred on the same baseline', () => {
    const tall = boxTop('กำลังทำงาน', 11, 100);
    expect(tall).toBe(
      100 - ascent('กำลังทำงาน', 11) - (lineBox('กำลังทำงาน', 11) - Math.ceil(11 * LATIN_LINE)) / 2
    );
    expect(tall).toBeLessThan(boxTop('Working', 11, 100));
  });
});

describe('Advance width', () => {
  it('gives a wide character one em', () => {
    expect(estimateWidth('\u{20000}', 10)).toBeCloseTo(10);
    expect(estimateWidth('\u{1F600}', 10)).toBeCloseTo(10);
    expect(estimateWidth('\u{FFE5}', 10)).toBeCloseTo(10);
  });

  it('keeps the Latin advances', () => {
    expect(estimateWidth('n', 10)).toBeCloseTo(5.6);
    expect(estimateWidth('l', 10)).toBeCloseTo(2.8);
    expect(estimateWidth(' ', 10)).toBeCloseTo(2.8);
    expect(estimateWidth('A', 10)).toBeCloseTo(6.6);
    expect(estimateWidth('ab', 10)).toBeCloseTo(11.2);
  });
});
