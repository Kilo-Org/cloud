import { ENKRYPT_MAX_SCAN_CHARACTERS } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import {
  renderSegment,
  SEGMENT_SEPARATOR,
  segmentHeaderLine,
  type RequestSegment,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';

/**
 * A segment is split only when its header is at most this long, which every real header is, so
 * each slice has room for plenty of its body. A longer header comes from a pathological name, such
 * as a tool or file name; a segment with one that does not fit in a scan whole is sent as an
 * oversized unit, which `scanRequest` rejects.
 */
export const MAX_SPLIT_HEADER_CHARACTERS = 10_000;

/**
 * Text whose verdict is cached on its own: a whole segment, or a slice of a segment too long for
 * one Enkrypt call. `segment` is the index of the segment it belongs to.
 */
export type ScanUnit = { text: string; segment: number };

/** Whether cutting `text` at `index` would separate the two halves of a surrogate pair. */
function splitsPair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function sliceHeader(header: string, beginning: boolean, ending: boolean): string {
  const omitted =
    beginning && ending
      ? ', beginning and end omitted'
      : beginning
        ? ', beginning omitted'
        : ending
          ? ', end omitted'
          : '';
  return segmentHeaderLine(`${header}${omitted}`);
}

/**
 * Text repeated from the end of a slice at the start of the next slice of the same segment, so
 * content of up to this length that straddles a cut is still scanned whole in one slice. Keeping a
 * surrogate pair whole can shorten the overlap by up to two characters.
 */
export const ENKRYPT_SLICE_OVERLAP_CHARACTERS = 4_000;

/**
 * The units of one segment: the whole segment when it fits in one Enkrypt call, and otherwise
 * slices of its body, each at most `ENKRYPT_MAX_SCAN_CHARACTERS` long, its header marking the
 * beginning or end left out. Cuts fall at fixed positions from the start of the body, so a slice's
 * text, and its cache key, stay the same however the request around it changes. Each slice after
 * the first also repeats the last `ENKRYPT_SLICE_OVERLAP_CHARACTERS` of the text before its cut.
 * No slice starts or ends between the two halves of a surrogate pair.
 */
function segmentUnits(segment: RequestSegment): string[] {
  const whole = renderSegment(segment);
  const { header, body } = segment;
  if (
    whole.length <= ENKRYPT_MAX_SCAN_CHARACTERS ||
    body === null ||
    header.length > MAX_SPLIT_HEADER_CHARACTERS
  ) {
    return [whole];
  }
  const longestHeader = sliceHeader(header, true, true).length;
  const step = ENKRYPT_MAX_SCAN_CHARACTERS - longestHeader - 1 - ENKRYPT_SLICE_OVERLAP_CHARACTERS;
  const units: string[] = [];
  for (let cut = 0; cut < body.length; cut += step) {
    const overlapStart = Math.max(0, cut - ENKRYPT_SLICE_OVERLAP_CHARACTERS);
    const start = splitsPair(body, overlapStart) ? overlapStart + 1 : overlapStart;
    const next = cut + step;
    const end = next >= body.length ? body.length : splitsPair(body, next) ? next - 1 : next;
    const sliced = sliceHeader(header, start > 0, end < body.length);
    units.push(`${sliced}\n${body.slice(start, end)}`);
  }
  return units;
}

/**
 * Splits a part into the units whose verdicts are cached individually: one per segment, or several
 * for a segment too long for one Enkrypt call. Enkrypt splits its input into chunks and judges each
 * on its own, so a unit's verdict does not depend on the text around it.
 */
export function scanUnits(segments: RequestSegment[]): ScanUnit[] {
  return segments.flatMap((segment, index) =>
    segmentUnits(segment).map(text => ({ text, segment: index }))
  );
}

/**
 * Packs units, in order, into as few Enkrypt calls of at most `ENKRYPT_MAX_SCAN_CHARACTERS` as
 * fit, joined like segments, since each call pays Enkrypt's per-call minimum. An oversized unit is
 * a call of its own.
 */
export function packUnits<T extends { text: string }>(units: T[]): T[][] {
  const calls: T[][] = [];
  let current: T[] = [];
  let length = 0;
  for (const unit of units) {
    const joined = length + SEGMENT_SEPARATOR.length + unit.text.length;
    if (current.length > 0 && joined <= ENKRYPT_MAX_SCAN_CHARACTERS) {
      current.push(unit);
      length = joined;
      continue;
    }
    if (current.length > 0) calls.push(current);
    current = [unit];
    length = unit.text.length;
  }
  if (current.length > 0) calls.push(current);
  return calls;
}
