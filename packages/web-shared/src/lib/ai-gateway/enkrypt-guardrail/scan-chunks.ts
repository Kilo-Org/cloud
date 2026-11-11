import { ENKRYPT_MAX_SCAN_CHARACTERS } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import {
  joinSegments,
  renderSegment,
  SEGMENT_SEPARATOR,
  segmentHeaderLine,
  type RequestScanParts,
  type RequestSegment,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';

/**
 * Already-scanned text sent ahead of the new text of a scan: ahead of the uncached suffix of a
 * conversation, and ahead of every chunk after the first. Content split across the boundary is
 * still scanned together. Context-dependent detection further back is not re-evaluated.
 */
export const ENKRYPT_SCAN_OVERLAP_CHARACTERS = 4_000;

/** Leads a scan when earlier text of the part is left out of it. */
export const OMITTED_TEXT_MARKERS: Record<keyof RequestScanParts, string> = {
  tools: '[earlier tool definition omitted]',
  system: '[earlier system prompt omitted]',
  conversation: '[earlier conversation omitted]',
};

/**
 * A segment is split, or cut by an overlap, only when its header is at most this long, which every
 * real header is. That bounds the overlap and header ahead of the new text of a chunk, so each chunk
 * has room for plenty of it. A longer header comes from a pathological name, such as a tool or file
 * name; a segment with one that does not fit in a scan whole is sent as an oversized chunk, which
 * `scanRequest` rejects.
 */
export const MAX_SPLIT_HEADER_CHARACTERS = 10_000;

/**
 * One Enkrypt call's text. `through` counts the segments covered in full by this chunk and the text
 * before it: once every chunk up to this one allowed, the part is allowed up to that segment
 * boundary. `reaches` counts the segments the chunk's text reaches into, in full or in part, so a
 * block found in it applies to every request retaining them.
 */
export type ScanChunk = { text: string; through: number; reaches: number };

/** A position in a part: `offset` characters into the body of segment `segment`. */
type Cursor = { segment: number; offset: number };

const ORIGIN: Cursor = { segment: 0, offset: 0 };

function isAfter(a: Cursor, b: Cursor): boolean {
  return a.segment > b.segment || (a.segment === b.segment && a.offset > b.offset);
}

function bodyLength(segment: RequestSegment): number {
  return segment.body?.length ?? 0;
}

function hasShortHeader(segment: RequestSegment): boolean {
  return segment.header.length <= MAX_SPLIT_HEADER_CHARACTERS;
}

/** Whether cutting `text` at `index` would separate the two halves of a surrogate pair. */
function splitsPair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function sliceHeader(segment: RequestSegment, beginning: boolean, ending: boolean): string {
  const omitted =
    beginning && ending
      ? ', beginning and end omitted'
      : beginning
        ? ', beginning omitted'
        : ending
          ? ', end omitted'
          : '';
  return segmentHeaderLine(`${segment.header}${omitted}`);
}

/** A segment with only part of its body, its header marking what is left out. */
function renderSlice(segment: RequestSegment, start: number, end: number): string {
  if (segment.body === null) return renderSegment(segment);
  const header = sliceHeader(segment, start > 0, end < segment.body.length);
  return `${header}\n${segment.body.slice(start, end)}`;
}

function sliceLength(segment: RequestSegment, start: number, end: number): number {
  if (segment.body === null) return renderSegment(segment).length;
  return sliceHeader(segment, start > 0, end < segment.body.length).length + 1 + end - start;
}

/**
 * Where the overlap ahead of `position` starts: up to `ENKRYPT_SCAN_OVERLAP_CHARACTERS` of the text
 * before it. The budget counts bodies: a segment whose body fits is kept whole, even when its header
 * does not, and the segment that does not fit is cut, keeping its end.
 */
function overlapStart(segments: RequestSegment[], position: Cursor): Cursor {
  let remaining = ENKRYPT_SCAN_OVERLAP_CHARACTERS;
  let index = position.segment;
  const current = segments[index];
  if (position.offset > 0 && current?.body) {
    if (position.offset > remaining) {
      const start = position.offset - remaining;
      return { segment: index, offset: splitsPair(current.body, start) ? start + 1 : start };
    }
    remaining -= position.offset;
  }
  while (index > 0 && remaining > 0) {
    const segment = segments[index - 1];
    if (!segment || !hasShortHeader(segment)) break;
    const length = sliceLength(segment, 0, bodyLength(segment));
    if (length > remaining && (segment.body === null || segment.body.length > remaining)) {
      if (segment.body === null) break;
      const start = segment.body.length - remaining;
      return { segment: index - 1, offset: splitsPair(segment.body, start) ? start + 1 : start };
    }
    remaining -= length + SEGMENT_SEPARATOR.length;
    index--;
  }
  return { segment: index, offset: 0 };
}

/** Whether segment `index` fits whole in a chunk of its own, after the overlap ahead of it. */
function fitsInChunkOfItsOwn(segments: RequestSegment[], index: number, marker: string): boolean {
  const from = overlapStart(segments, { segment: index, offset: 0 });
  const end = { segment: index + 1, offset: 0 };
  return renderChunk(segments, from, end, marker).length <= ENKRYPT_MAX_SCAN_CHARACTERS;
}

/**
 * Where the chunk starting with the overlap at `from` and the new text at `position` ends. It takes
 * as many whole segments as fit, and ends at the next segment boundary when the following segment
 * fits whole in the next chunk. Only a segment too long for that is split inside its body, starting
 * in this chunk so its remaining room is not wasted.
 */
function chunkEnd(
  segments: RequestSegment[],
  from: Cursor,
  position: Cursor,
  marker: string
): Cursor {
  const leadsWithMarker = isAfter(from, ORIGIN);
  let length = leadsWithMarker ? marker.length : 0;
  let texts = leadsWithMarker ? 1 : 0;
  const lengthWith = (added: number) => length + (texts > 0 ? SEGMENT_SEPARATOR.length : 0) + added;
  const start = (index: number) => (index === from.segment ? from.offset : 0);
  for (let index = from.segment; index < position.segment; index++) {
    const segment = segments[index];
    if (!segment) break;
    length = lengthWith(sliceLength(segment, start(index), bodyLength(segment)));
    texts++;
  }
  let end = position;
  for (let index = position.segment; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment) break;
    const whole = sliceLength(segment, start(index), bodyLength(segment));
    if (lengthWith(whole) <= ENKRYPT_MAX_SCAN_CHARACTERS) {
      length = lengthWith(whole);
      texts++;
      end = { segment: index + 1, offset: 0 };
      continue;
    }
    const started = isAfter(end, position);
    if (segment.body === null || !hasShortHeader(segment)) {
      return started ? end : { segment: index + 1, offset: 0 };
    }
    if (started && fitsInChunkOfItsOwn(segments, index, marker)) return end;
    const header = sliceHeader(segment, start(index) > 0, true).length;
    const cut = start(index) + ENKRYPT_MAX_SCAN_CHARACTERS - lengthWith(header + 1);
    const offset = splitsPair(segment.body, cut) ? cut - 1 : cut;
    if (offset > (index === position.segment ? position.offset : 0)) {
      return { segment: index, offset };
    }
    return started ? end : { segment: index + 1, offset: 0 };
  }
  return end;
}

function renderChunk(
  segments: RequestSegment[],
  from: Cursor,
  end: Cursor,
  marker: string
): string {
  const texts = isAfter(from, ORIGIN) ? [marker] : [];
  const last = end.offset > 0 ? end.segment : end.segment - 1;
  for (let index = from.segment; index <= last; index++) {
    const segment = segments[index];
    if (!segment) break;
    texts.push(
      renderSlice(
        segment,
        index === from.segment ? from.offset : 0,
        index === end.segment ? end.offset : bodyLength(segment)
      )
    );
  }
  return joinSegments(texts);
}

/**
 * Splits the text of a part from segment `start` on into Enkrypt calls of at most
 * `ENKRYPT_MAX_SCAN_CHARACTERS` characters each, so a long part is scanned in full rather than
 * rejected or truncated. Each chunk, and the first one when `start` is past earlier segments,
 * begins with an overlap of up to `ENKRYPT_SCAN_OVERLAP_CHARACTERS` of the text before it, so
 * content split across a boundary is still scanned together. Chunks end at segment boundaries
 * unless a single segment does not fit, which is then split inside its body, never between the two
 * halves of a surrogate pair, its header marking the beginning or end left out. Returns no chunks
 * when there is nothing from `start` on.
 */
export function scanChunks(segments: RequestSegment[], start: number, marker: string): ScanChunk[] {
  const chunks: ScanChunk[] = [];
  let position: Cursor = { segment: start, offset: 0 };
  while (position.segment < segments.length) {
    const from = overlapStart(segments, position);
    const end = chunkEnd(segments, from, position, marker);
    chunks.push({
      text: renderChunk(segments, from, end, marker),
      through: end.segment,
      reaches: end.offset > 0 ? end.segment + 1 : end.segment,
    });
    position = end;
  }
  return chunks;
}
