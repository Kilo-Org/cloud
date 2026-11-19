import { ENKRYPT_MAX_SCAN_CHARACTERS } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import {
  renderSegment,
  type RequestSegment,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import {
  ENKRYPT_SLICE_OVERLAP_CHARACTERS,
  MAX_SPLIT_HEADER_CHARACTERS,
  scanUnits,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/scan-chunks';

function segment(header: string, body: string | null): RequestSegment {
  return { header, body };
}

/** Distinct, ordered content, so any window of it is unique within the part. */
function numbered(prefix: string, length: number): string {
  let text = '';
  for (let index = 0; text.length < length; index++) text += `${prefix}${index} `;
  return text.slice(0, length);
}

/** The body of a rendered unit, which follows its header line. */
function bodyOf(text: string): string {
  return text.slice(text.indexOf('\n') + 1);
}

const SPLIT_PAIR = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('scanUnits', () => {
  it('is one unit per segment when each fits, with the segment index', () => {
    const segments = [segment('user', 'hello'), segment('user image', null)];
    expect(scanUnits(segments)).toEqual([
      { text: renderSegment(segments[0]!), segment: 0 },
      { text: '[user image omitted]', segment: 1 },
    ]);
  });

  it('is empty for no segments', () => {
    expect(scanUnits([])).toEqual([]);
  });

  it('is one unit for an omitted attachment, however the other segments are', () => {
    const segments = [segment('user image', null), segment('user', 'a'.repeat(150_000))];
    const units = scanUnits(segments);
    expect(units[0]).toEqual({ text: '[user image omitted]', segment: 0 });
    expect(units.slice(1).every(unit => unit.segment === 1)).toBe(true);
  });

  it('fills a unit exactly up to the scan limit', () => {
    const header = '[user]\n';
    const segments = [segment('user', 'a'.repeat(ENKRYPT_MAX_SCAN_CHARACTERS - header.length))];
    expect(scanUnits(segments)).toEqual([{ text: renderSegment(segments[0]!), segment: 0 }]);
  });

  describe('a segment longer than one scan', () => {
    const body = numbered('w', 250_000);
    const units = scanUnits([segment('tool result', body)]);
    const bodies = units.map(({ text }) => bodyOf(text));

    it('splits it into units each within the scan limit', () => {
      expect(units.length).toBeGreaterThan(2);
      expect(units.every(unit => unit.segment === 0)).toBe(true);
      for (const { text } of units) {
        expect(text.length).toBeLessThanOrEqual(ENKRYPT_MAX_SCAN_CHARACTERS);
      }
      // A slice with both ends omitted has the longest header, and fills the scan exactly.
      expect(units[1]?.text.length).toBe(ENKRYPT_MAX_SCAN_CHARACTERS);
    });

    it('marks the beginning and end each unit leaves out in its header', () => {
      const headers = units.map(({ text }) => text.split('\n')[0]);
      expect(headers[0]).toBe('[tool result, end omitted]');
      for (const header of headers.slice(1, -1)) {
        expect(header).toBe('[tool result, beginning and end omitted]');
      }
      expect(headers.at(-1)).toBe('[tool result, beginning omitted]');
    });

    it('has consecutive bodies that share exactly the overlap', () => {
      for (let index = 1; index < bodies.length; index++) {
        const shared = bodies[index]!.slice(0, ENKRYPT_SLICE_OVERLAP_CHARACTERS);
        expect(shared).toHaveLength(ENKRYPT_SLICE_OVERLAP_CHARACTERS);
        expect(bodies[index - 1]!.endsWith(shared)).toBe(true);
      }
    });

    it('gives each slice the range of the body it holds, and a whole segment none', () => {
      const ranges = units.map(unit => unit.bodyRange);
      expect(ranges.every(range => range !== undefined)).toBe(true);
      expect(ranges[0]?.start).toBe(0);
      expect(ranges.at(-1)?.end).toBe(body.length);
      units.forEach(({ text, bodyRange }) => {
        expect(body.slice(bodyRange!.start, bodyRange!.end) === bodyOf(text)).toBe(true);
      });
      expect(scanUnits([segment('user', 'hello'), segment('user image', null)])).toEqual([
        { text: '[user]\nhello', segment: 0 },
        { text: '[user image omitted]', segment: 1 },
      ]);
    });

    it('has bodies that, without the overlap, concatenate back to the original body', () => {
      const rebuilt = bodies
        .map((text, index) => (index === 0 ? text : text.slice(ENKRYPT_SLICE_OVERLAP_CHARACTERS)))
        .join('');
      expect(rebuilt === body).toBe(true);
    });

    it.each([
      ['ending just past the cut', 1],
      ['straddling the cut', 1_500],
      ['starting just before the cut', 2_999],
    ])('scans whole an injection %s in one of its units', (_name, afterCut) => {
      const injection = numbered('INJECT', 3_000);
      const cut = bodies[0]!.length;
      const start = cut + afterCut - injection.length;
      const injected = `${body.slice(0, start)}${injection}${body.slice(start + injection.length)}`;
      const injectedUnits = scanUnits([segment('tool result', injected)]);
      expect(injectedUnits.some(({ text }) => text.includes(injection))).toBe(true);
    });

    it('scans whole an injection as long as the overlap that ends just past the cut', () => {
      const injection = numbered('INJECT', ENKRYPT_SLICE_OVERLAP_CHARACTERS);
      const start = bodies[0]!.length + 1 - injection.length;
      const injected = `${body.slice(0, start)}${injection}${body.slice(start + injection.length)}`;
      const injectedUnits = scanUnits([segment('tool result', injected)]);
      expect(injectedUnits.map(({ text }) => text.includes(injection))).toEqual([
        false,
        true,
        false,
      ]);
    });

    it('keeps every unit but the last when the body grows', () => {
      const grown = scanUnits([segment('tool result', `${body}${numbered('v', 60_000)}`)]);
      const texts = units.map(({ text }) => text);
      expect(grown.length).toBeGreaterThan(units.length);
      expect(grown.slice(0, units.length - 1).map(({ text }) => text)).toEqual(texts.slice(0, -1));
      expect(grown[units.length - 1]?.text).not.toBe(texts.at(-1));
    });
  });

  /** A body of distinct astral characters after `prefix`, so any window of it is unique. */
  function astral(prefix: string, count: number): string {
    let text = prefix;
    for (let index = 0; index < count; index++) text += String.fromCodePoint(0x10000 + index);
    return text;
  }

  /** Where each unit's body starts and ends in `body`. */
  function bounds(body: string, units: { text: string }[]): { start: number; end: number }[] {
    return units.map(({ text }) => {
      const slice = bodyOf(text);
      const start = body.indexOf(slice);
      return { start, end: start + slice.length };
    });
  }

  it('never splits a surrogate pair, with or without a prefix', () => {
    for (const prefix of ['', 'x']) {
      const body = astral(prefix, 120_000);
      const units = scanUnits([segment('user', body)]);
      expect(units.length).toBeGreaterThan(2);
      expect(units.map(unit => unit.bodyRange)).toEqual(bounds(body, units));
      for (const { text } of units) {
        expect(text).not.toMatch(SPLIT_PAIR);
        expect(text.length).toBeLessThanOrEqual(ENKRYPT_MAX_SCAN_CHARACTERS);
      }
      const slices = bounds(body, units);
      expect(slices[0]?.start).toBe(0);
      expect(slices.at(-1)?.end).toBe(body.length);
      for (let index = 1; index < slices.length; index++) {
        const overlap = slices[index - 1]!.end - slices[index]!.start;
        expect(overlap).toBeGreaterThanOrEqual(ENKRYPT_SLICE_OVERLAP_CHARACTERS - 2);
        expect(overlap).toBeLessThanOrEqual(ENKRYPT_SLICE_OVERLAP_CHARACTERS);
      }
    }
  });

  it('shortens a unit by one character at each end that would split a surrogate pair', () => {
    // Without a prefix every cut falls between two pairs; with one, every cut falls inside a pair.
    const aligned = scanUnits([segment('user', astral('', 120_000))]);
    const shifted = scanUnits([segment('user', astral('x', 120_000))]);
    expect(aligned[1]?.text.length).toBe(ENKRYPT_MAX_SCAN_CHARACTERS);
    expect(shifted[0]?.text.length).toBe(aligned[0]!.text.length - 1);
    expect(shifted[1]?.text.length).toBe(ENKRYPT_MAX_SCAN_CHARACTERS - 2);
    const slices = bounds(astral('x', 120_000), shifted);
    expect(slices[0]!.end - slices[1]!.start).toBe(ENKRYPT_SLICE_OVERLAP_CHARACTERS - 2);
  });

  it('keeps a segment whose header is too long to split as one oversized unit', () => {
    const long = segment('h'.repeat(MAX_SPLIT_HEADER_CHARACTERS + 1), 'a'.repeat(95_000));
    const units = scanUnits([segment('user', 'first'), long, segment('user', 'after')]);
    expect(units).toEqual([
      { text: '[user]\nfirst', segment: 0 },
      { text: renderSegment(long), segment: 1 },
      { text: '[user]\nafter', segment: 2 },
    ]);
    expect(units[1]?.text.length).toBeGreaterThan(ENKRYPT_MAX_SCAN_CHARACTERS);
  });

  it('slices a segment the same whatever segments come before it', () => {
    const long = segment('tool result', numbered('w', 250_000));
    const alone = scanUnits([long]).map(({ text }) => text);
    const after = scanUnits([segment('user', 'read it'), long, segment('user', 'after')]);
    expect(after.filter(unit => unit.segment === 1).map(({ text }) => text)).toEqual(alone);
  });
});
