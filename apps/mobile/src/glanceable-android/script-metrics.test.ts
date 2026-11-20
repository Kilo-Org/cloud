import { describe, expect, it, vi } from 'vitest';

import {
  baselineAbove,
  boxTop,
  centredBaseline,
  centredLineBaseline,
  centredRowBaseline,
  estimateWidth,
  insideBand,
  lineBox,
} from './active-agents-widget-parts';
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
    // The dropped half-growth term was exactly 0 for Latin: lineBox is
    // ceil(size * 1.32), so these numbers are the pre-change ones.
    expect(boxTop('Working', 11, 100)).toBe(100 - 11.616);
    expect(boxTop('Working', 13, 100)).toBeCloseTo(100 - 13.728, 10);
    expect(boxTop('Working', 20, 92)).toBe(92 - 21.12);
  });

  it('starts a taller script box one padded ascent above the baseline', () => {
    // 13sp Myanmar: hhea ascent 1.324 + 0.128 padding = 1.452em, so 18.876dp;
    // box ceil(13 * 2.184) = 29dp. The box must start at the ascent, not a
    // half-growth above it, or the glyph descent hangs outside the box.
    const size = 13;
    const baseline = 100;
    const ascentEm = 1.452;
    const box = 29;
    expect(ascent('မြန်မာ', size)).toBeCloseTo(ascentEm * size, 10);
    expect(lineBox('မြန်မာ', size)).toBe(box);
    expect(boxTop('မြန်မာ', size, baseline)).toBeCloseTo(baseline - ascentEm * size, 10);
    const bottom = boxTop('မြန်မာ', size, baseline) + lineBox('မြန်မာ', size);
    // baseline - 18.876 + 29 = baseline + 10.124: the descent the box carries.
    expect(bottom).toBeCloseTo(baseline + 10.124, 10);
    expect(bottom).toBeGreaterThanOrEqual(baseline + 0.732 * size);
    // The half-growth version ended at baseline + 4.6, 4.9dp short of the ink.
    expect(boxTop('မြန်မာ', size, baseline)).toBeGreaterThan(
      baseline - ascentEm * size - (box - Math.ceil(size * LATIN_LINE)) / 2
    );
  });

  it('keeps a taller line above the same baseline', () => {
    const tall = boxTop('กำลังทำงาน', 11, 100);
    expect(tall).toBe(100 - ascent('กำลังทำงาน', 11));
    expect(tall).toBeLessThan(boxTop('Working', 11, 100));
  });

  it('anchors the box edges exactly, with the Latin numbers unchanged', () => {
    // Every number below is the pre-change value of the same function, written
    // out: for Latin the dropped half-growth term was exactly 0, so these are
    // the numbers this file shipped before the change.
    expect(boxTop('Working', 11, 100)).toBe(88.384);
    expect(boxTop('Working', 20, 92)).toBe(70.88);
    for (const [size, top, boxTopAt100, aboveAt100, inAt10, centredAt50] of [
      [11, 10, 88.384, 96.616, 21.616, 54.116],
      [13, 10, 86.272, 95.728, 23.728, 54.728],
      [20, 10, 78.88, 94.12, 31.12, 57.62],
    ] as const) {
      expect(boxTop('Working', size, 100)).toBeCloseTo(boxTopAt100, 10);
      expect(baselineAbove('Working', size, 100)).toBeCloseTo(aboveAt100, 10);
      // The top clamp is `baselineIn`, and it puts the box exactly on `top`.
      expect(insideBand({ value: 'Working', size, baseline: 0, top })).toBeCloseTo(inAt10, 10);
      expect(boxTop('Working', size, inAt10)).toBeCloseTo(top, 10);
      expect(centredLineBaseline('Working', size, 50)).toBeCloseTo(centredAt50, 10);
      expect(centredLineBaseline('Working', size, 50)).toBe(centredBaseline(size, 50));
    }
    // A taller script lands on both edges exactly too.
    for (const size of [11, 13, 20]) {
      const above = baselineAbove('မြန်မာ', size, 100);
      expect(boxTop('မြန်မာ', size, above) + lineBox('မြန်မာ', size)).toBeCloseTo(100, 10);
      const inside = insideBand({ value: 'မြန်မာ', size, baseline: 0, top: 7 });
      expect(boxTop('မြန်မာ', size, inside)).toBeCloseTo(7, 10);
    }
  });
});

describe('Centring on an arbitrary line', () => {
  it('gives Latin text exactly the design centred baseline', () => {
    for (const [size, cy] of [
      [11, 100],
      [12, 23],
      [14, 12.5],
      [26, 52.5],
    ] as const) {
      expect(centredLineBaseline('Working', size, cy)).toBe(centredBaseline(size, cy));
      expect(centredRowBaseline(['Checked 8:00 PM'], size, cy)).toBe(centredBaseline(size, cy));
    }
  });

  it('puts a taller script own box centre on cy', () => {
    for (const [value, size, cy] of [
      ['กำลังทำงาน', 12, 50],
      ['အလုပ်လုပ်နေသည်', 11, 23],
      ['جارٍ العمل', 17, 52.5],
      ['काम करत आहे', 14, 62],
    ] as const) {
      const baseline = centredLineBaseline(value, size, cy);
      // The box runs from baseline - ascent to that + lineBox, so its centre is
      // exactly cy once the baseline is cy + ascent - lineBox / 2.
      expect(boxTop(value, size, baseline) + lineBox(value, size) / 2).toBeCloseTo(cy, 10);
      // And the box really holds the ink: it starts at the ascent above the
      // baseline (that is where the glyphs start) and its bottom is the box's.
      expect(boxTop(value, size, baseline)).toBeCloseTo(cy - lineBox(value, size) / 2, 10);
      expect(boxTop(value, size, baseline)).toBeLessThanOrEqual(baseline);
    }
  });

  it('moves a taller script own box centre back onto cy', () => {
    const size = 12;
    const cy = 50;
    // Centring by Roboto's ascent leaves a taller box's centre above cy, so the
    // box-centred baseline has to sit lower than the design's.
    const latin = centredBaseline(size, cy);
    const centre = boxTop('กำลังทำงาน', size, latin) + lineBox('กำลังทำงาน', size) / 2;
    expect(centre).toBeLessThan(cy);
    expect(centredLineBaseline('กำลังทำงาน', size, cy)).toBeGreaterThan(latin);
  });

  it('centres a shared row on its tallest part', () => {
    const size = 12;
    const cy = 30;
    const parts = ['Checked 8:00 PM', '·', 'အလုပ်လုပ်နေသည်'];
    const baseline = centredRowBaseline(parts, size, cy);
    expect(baseline).toBe(centredLineBaseline('အလုပ်လုပ်နေသည်', size, cy));
    expect(boxTop('အလုပ်လုပ်နေသည်', size, baseline) + lineBox('အလုပ်လုပ်နေသည်', size) / 2).toBeCloseTo(
      cy,
      10
    );
    // The shorter parts share that baseline, so the row's box is the tall one's.
    expect(lineBox('အလုပ်လုပ်နေသည်', size)).toBeGreaterThan(lineBox('Checked 8:00 PM', size));
  });
});

describe('Band clamp', () => {
  const MYANMAR = 'အလုပ်လုပ်နေသည်';
  const size = 12;
  const end = (baseline: number) => boxTop(MYANMAR, size, baseline) + lineBox(MYANMAR, size);

  it('returns the given baseline when the box fits, Latin included', () => {
    expect(insideBand({ value: 'Working', size, baseline: 20, top: 0, bottom: 104 })).toBe(20);
    expect(insideBand({ value: MYANMAR, size, baseline: 40, top: 0, bottom: 104 })).toBe(40);
  });

  it('moves a box that rises above the top edge down onto it', () => {
    const baseline = 5;
    const moved = insideBand({ value: MYANMAR, size, baseline, top: 10 });
    expect(moved).toBeGreaterThan(baseline);
    expect(boxTop(MYANMAR, size, moved)).toBeCloseTo(10, 10);
  });

  it('lifts a box that ends below the bottom edge, keeping its top edge', () => {
    const baseline = 40;
    const bottom = 30;
    const moved = insideBand({ value: MYANMAR, size, baseline, top: 0, bottom });
    expect(moved).toBeLessThan(baseline);
    expect(end(moved)).toBeCloseTo(bottom, 10);
    // Corrected off the bottom edge, and the box still starts below the top one.
    expect(boxTop(MYANMAR, size, moved)).toBeCloseTo(bottom - lineBox(MYANMAR, size), 10);
    expect(boxTop(MYANMAR, size, moved)).toBeGreaterThanOrEqual(0);
  });

  it('corrects a line that overflows both edges, preferring the top one', () => {
    // A band shorter than the box, and a baseline above it: both edges overflow.
    // No baseline clears both, so the top edge wins and the bottom overflow stays.
    const top = 0;
    const bottom = 6;
    const baseline = 5;
    expect(lineBox(MYANMAR, size)).toBeGreaterThan(bottom - top);
    expect(boxTop(MYANMAR, size, baseline)).toBeLessThan(top);
    expect(end(baseline)).toBeGreaterThan(bottom);
    const moved = insideBand({ value: MYANMAR, size, baseline, top, bottom });
    // Down off the top edge first, up off the bottom second, then the top edge
    // again: the box starts exactly on the top edge, and only the bottom is over.
    expect(boxTop(MYANMAR, size, moved)).toBeCloseTo(top, 10);
    expect(end(moved)).toBeGreaterThan(bottom);
    expect(moved).toBeGreaterThan(baseline);
  });

  it('never lets the bottom correction push a box above the top edge', () => {
    // The input baseline clears the top edge and overflows only the bottom, but
    // lifting it to the bottom edge raises the box through the top one. The old
    // clamp returned that lift unchanged.
    const top = 0;
    const bottom = 20;
    const baseline = 25;
    const onBottom = insideBand({ value: MYANMAR, size, baseline, bottom });
    expect(boxTop(MYANMAR, size, onBottom)).toBeLessThan(top);
    const moved = insideBand({ value: MYANMAR, size, baseline, top, bottom });
    expect(boxTop(MYANMAR, size, moved)).toBeCloseTo(top, 10);
    expect(moved).not.toBe(onBottom);
  });

  it('counts a second line for the bottom edge only', () => {
    const value = 'Working';
    const baseline = 20;
    const one = insideBand({ value, size, baseline, bottom: 36 });
    const two = insideBand({ value, size, baseline, bottom: 36, lines: 2 });
    expect(one).toBe(baseline);
    expect(two).toBeLessThan(baseline);
    expect(boxTop(value, size, two) + 2 * lineBox(value, size)).toBeCloseTo(36, 10);
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
