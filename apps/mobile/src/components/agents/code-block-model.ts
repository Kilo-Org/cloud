import { highlightLine, type HighlightToken } from '@/lib/pr-review/diff/highlight';

import { CharacterBoundedCache } from './character-bounded-cache';

/**
 * Resolve a markdown fence info string to the language name used by the
 * highlighter, or `null` for no language. Only the first word counts
 * (`'TS extra'` → `'ts'`); alias resolution is left to lowlight, and unknown
 * names fall back to plain text inside `highlightLine`. `undefined`, empty,
 * and whitespace-only info strings all return `null`.
 */
export function normalizeFenceLanguage(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const first = raw.trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}

/**
 * Source lines per code `RNText`.
 *
 * A code fence's Android cost has two shapes, and they pull in opposite
 * directions: a `Text` is one native `ReactTextView` (a view, a yoga node, and
 * a measure/draw pass), and `SetSpanOperation.execute` runs once per span
 * packed into one `Text` — RN applies the span operations of a whole
 * `SpannableStringBuilder` in one frame, and the insertion cost of that
 * builder grows with the spans it already holds. One `Text` for the whole
 * fence gives all of its spans to a single view; one `Text` per source line
 * gives the fence one native view per line (a 1,300-line read tool card became
 * 1,300 views). A chunk bounds both: every `Text` holds at most this many
 * lines and `CODE_CHUNK_TOKENS` tagged runs, and a fence needs one view per
 * chunk.
 *
 * A selectable fence uses the same cap. Android only selects inside one
 * `ReactTextView`, so a selection spans the chunk the gesture starts in rather
 * than the whole fence — 32 lines, far more than a press-hold-drag selects —
 * and the tool detail sheet's 50,000-character selectable body is bounded to
 * this many lines of spans per `Text` like every other fence (see
 * `code-block.tsx`).
 */
const CODE_CHUNK_LINES = 32;

/**
 * Tagged runs one chunk `Text` may hold.
 *
 * The line cap does not bound a `Text`'s spans on its own: `tokenizeCodeLines`
 * highlights a line at a time, so a single source line can carry thousands of
 * tagged runs — a minified bundle or lockfile pasted as one line — and that
 * whole run set still landed on one `Text` in one frame, the
 * `SetSpanOperation.execute` cost the line cap exists to bound. A line denser
 * than this budget is split at token boundaries into as many segments
 * (see `chunkTokenLines`), so no `Text` ever holds more tags than this.
 * Ordinary code stays far under the budget — a TypeScript `const x = 1;` line
 * carries four tagged runs — so a chunk still holds `CODE_CHUNK_LINES` lines
 * for everything but a run-dense line.
 */
export const CODE_CHUNK_TOKENS = 512;

/**
 * Chunks a fence mounts in its first render.
 *
 * The chunk cap bounds the spans one `Text` holds, but RN still applies every
 * mounted `Text`'s spans in the frame that mounts them: the tool detail sheet's
 * 50,000-character read body is ~1,500 lines, and mounting all of its chunks in
 * one commit held the UI thread for seconds while the sheet showed nothing but
 * its backdrop. The first render mounts this many chunks — 128 lines, about a
 * screen at the mono leading — so the sheet paints its header and the front of
 * the code at once, and `nextChunkMountCount` adds the rest in bounded batches
 * (see `code-block.tsx`). A fence whose text only grows keeps its mounts;
 * only a replaced fence starts over from this first paint.
 */
export const CODE_FIRST_PAINT_CHUNKS = 4;

/** Chunks added per bounded batch after the first paint. */
export const CODE_CHUNK_MOUNT_BATCH = 4;

/**
 * The mount count after one more bounded batch: `mounted + CODE_CHUNK_MOUNT_BATCH`,
 * never past the fence's own chunk count.
 */
export function nextChunkMountCount(mounted: number, totalChunks: number): number {
  return Math.min(mounted + CODE_CHUNK_MOUNT_BATCH, totalChunks);
}

/**
 * What one placed segment costs: the tagged runs that become Android spans, and
 * the characters its token texts hold, which is what the walk cache retains.
 */
function segmentCost(tokens: readonly HighlightToken[]) {
  let tags = 0;
  let characters = 0;
  for (const token of tokens) {
    if (token.className !== null) {
      tags += 1;
    }
    characters += token.text.length;
  }
  return { tags, characters };
}

/**
 * Split one highlighted line into segments of at most `CODE_CHUNK_TOKENS`
 * tagged runs. A line at or under the budget — every ordinary line — comes
 * back whole, so only a run-dense line is ever broken, and its break falls at
 * a token boundary. The renderer treats each segment as a line of its chunk,
 * so a broken line continues below the segment before it. An empty line keeps
 * one empty segment so its line box survives.
 */
function splitLineTokens(line: readonly HighlightToken[]): HighlightToken[][] {
  if (line.length === 0) {
    return [[]];
  }
  const segments: HighlightToken[][] = [];
  let segment: HighlightToken[] = [];
  let tagged = 0;
  for (const token of line) {
    const cost = token.className === null ? 0 : 1;
    if (segment.length > 0 && tagged + cost > CODE_CHUNK_TOKENS) {
      segments.push(segment);
      segment = [];
      tagged = 0;
    }
    segment.push(token);
    tagged += cost;
  }
  segments.push(segment);
  return segments;
}

/**
 * One page of lazily chunked fence: the chunks computed so far and whether the
 * fence has at least one more chunk past them.
 */
export type CodeChunkPage = {
  chunks: HighlightToken[][][];
  hasMore: boolean;
};

/**
 * An in-progress walk of a fence's source lines into render chunks.
 *
 * The walk is stepped rather than run to completion: a caller that mounts one
 * bounded batch at a time resumes where its previous batch stopped instead of
 * re-walking — and re-highlighting — the lines before it. `pullLine` returns
 * the next already-highlighted line, or `undefined` at the end. A run-dense
 * line is split at token boundaries, so the walk keeps the segments it has not
 * placed yet in `pendingSegments`.
 */
type ChunkWalk = {
  pullLine: () => HighlightToken[] | undefined;
  pendingSegments: HighlightToken[][];
  pendingIndex: number;
  chunks: HighlightToken[][][];
  chunk: HighlightToken[][];
  tagged: number;
  // What the placed chunks retain: the cache budget is charged by these, so a
  // walk is weighed by the highlighted tokens it holds and not only by its key.
  retainedTokens: number;
  retainedCharacters: number;
  done: boolean;
};

function createChunkWalk(pullLine: () => HighlightToken[] | undefined): ChunkWalk {
  return {
    pullLine,
    pendingSegments: [],
    pendingIndex: 0,
    chunks: [],
    chunk: [],
    tagged: 0,
    retainedTokens: 0,
    retainedCharacters: 0,
    done: false,
  };
}

/**
 * Advance `walk` until it holds `maxChunks` complete chunks or the source is
 * exhausted, keeping the partial chunk and any unplaced segment of a split line
 * in the walk. The line and run caps and the dense-line split match the
 * whole-file walk, so the chunk boundaries are unchanged; only the point at
 * which the walk stops moves.
 */
function advanceChunkWalk(walk: ChunkWalk, maxChunks: number): void {
  while (!walk.done && walk.chunks.length < maxChunks) {
    let segment: HighlightToken[] = [];
    if (walk.pendingIndex < walk.pendingSegments.length) {
      segment = walk.pendingSegments[walk.pendingIndex] ?? [];
      walk.pendingIndex += 1;
    } else {
      const line = walk.pullLine();
      if (line === undefined) {
        if (walk.chunk.length > 0) {
          walk.chunks.push(walk.chunk);
          walk.chunk = [];
          walk.tagged = 0;
        }
        walk.done = true;
        break;
      }
      const segments = splitLineTokens(line);
      walk.pendingSegments = segments;
      walk.pendingIndex = 1;
      segment = segments[0] ?? [];
    }
    const { tags, characters } = segmentCost(segment);
    if (walk.chunk.length > 0 && walk.tagged + tags > CODE_CHUNK_TOKENS) {
      walk.chunks.push(walk.chunk);
      walk.chunk = [];
      walk.tagged = 0;
    }
    walk.chunk.push(segment);
    walk.tagged += tags;
    walk.retainedTokens += segment.length;
    walk.retainedCharacters += characters;
    if (walk.chunk.length >= CODE_CHUNK_LINES) {
      walk.chunks.push(walk.chunk);
      walk.chunk = [];
      walk.tagged = 0;
    }
  }
}

/**
 * Group highlighted lines into render chunks of at most `CODE_CHUNK_LINES`
 * lines and `CODE_CHUNK_TOKENS` tagged runs. A line denser than the run budget
 * is split at token boundaries first, and each segment then counts as a line
 * of the chunk it lands in, so one `Text` never holds the whole run set of a
 * single-line fence. The last chunk holds the remainder.
 */
export function chunkTokenLines(lines: readonly HighlightToken[][]): HighlightToken[][][] {
  let index = 0;
  const walk = createChunkWalk(() => {
    const line = lines[index];
    index += 1;
    return line;
  });
  advanceChunkWalk(walk, Number.POSITIVE_INFINITY);
  return walk.chunks;
}

// Bound the resumable fence walks by total source characters, the same budget
// the markdown parse caches use. One entry per fence value is what lets a mount
// batch continue the previous walk instead of re-highlighting its prefix.
const CODE_FENCE_WALK_CACHE_CHARACTERS = 2_000_000;

// Characters charged per retained highlight token on top of its own text: a
// token is a two-property object (its text and its class), about 32 bytes, so
// sixteen source characters stand in for its own overhead. The budget then
// bounds the highlighted copies of message text a walk keeps, which the fence
// source alone does not account for.
const FENCE_WALK_TOKEN_CHARGE = 16;

const fenceWalkCache = new CharacterBoundedCache<ChunkWalk>(CODE_FENCE_WALK_CACHE_CHARACTERS);

// Mounted blocks per walk key. The cache is keyed by the fence's value, not by
// an instance, so two blocks rendering the same fence share one walk; a block
// that goes away may only drop the walk once no other mounted block holds it.
const fenceWalkHolders = new Map<string, number>();

function fenceWalkKey(code: string, language: string | null): string {
  return `${language ?? ''}\u0000${code}`;
}

/**
 * What one cached walk retains: its key, which holds the fence's whole source,
 * plus the highlighted token text and token objects the walk has placed.
 */
function fenceWalkWeight(key: string, walk: ChunkWalk): number {
  return key.length + walk.retainedCharacters + walk.retainedTokens * FENCE_WALK_TOKEN_CHARGE;
}

/**
 * The resumable walk for one fence, keyed by its language and full source.
 * Repeated calls with a larger `maxChunks` continue the same walk, so each
 * source line is highlighted once no matter how many mount batches it takes.
 * A new walk is not cached here: `chunkCodeLines` caches it once it knows what
 * the walk retains.
 */
function getFenceChunkWalk(code: string, language: string | null): ChunkWalk {
  const cached = fenceWalkCache.get(fenceWalkKey(code, language));
  if (cached !== undefined) {
    return cached;
  }
  const lines = code.split('\n');
  let index = 0;
  return createChunkWalk(() => {
    const line = lines[index];
    index += 1;
    return line === undefined ? undefined : highlightLine(line, language);
  });
}

/**
 * Chunk a fence without highlighting the lines below the mounted front.
 *
 * `chunkTokenLines(tokenizeCodeLines(code, language))` highlights every line of
 * the fence before the first commit renders a chunk of it. A 200 KB fenced
 * block is thousands of `highlightLine` runs — paid again on a remount, when a
 * FlashList row re-enters the window — even though the first commit mounts only
 * `CODE_FIRST_PAINT_CHUNKS` chunks. This walks the source lines in order,
 * highlighting each line only as it is placed into a chunk, and stops once
 * `maxChunks` chunks are complete.
 *
 * The walk is kept per fence value, so a later mount batch continues where the
 * previous one stopped: a fence costs one `highlightLine` per source line
 * across all batches, never the quadratic prefix re-walk a fresh, index-zero
 * walk per batch produced. A fence whose source is replaced starts a new walk.
 *
 * The chunk boundaries are exactly those of `chunkTokenLines` — the same line
 * and run caps, and the same dense-line split — so the split fence renders
 * identically. Only the time the highlighting happens changes.
 */
export function chunkCodeLines(
  code: string,
  language: string | null,
  maxChunks: number
): CodeChunkPage {
  const key = fenceWalkKey(code, language);
  const walk = getFenceChunkWalk(code, language);
  advanceChunkWalk(walk, maxChunks);
  // Charge the cache for what the walk now retains. `set` also moves the entry
  // to the most-recent end, which is what keeps the fence being mounted ahead
  // of the walks of the fences the user scrolled past.
  fenceWalkCache.set(key, walk, fenceWalkWeight(key, walk));
  // Return a snapshot capped at `maxChunks`: the walk's array grows on the next
  // batch (and may already hold more if another instance sharing the same
  // source advanced it first), and a caller memoized on the array's identity
  // must see a new value when it does.
  const limit = Number.isFinite(maxChunks)
    ? Math.max(0, Math.floor(maxChunks))
    : walk.chunks.length;
  const chunks = walk.chunks.slice(0, limit);
  return { chunks, hasMore: !walk.done || walk.chunks.length > chunks.length };
}

/**
 * Record that a mounted fence is using its walk. Paired with
 * `releaseFenceChunkWalk` for the same language and source; the walk survives
 * one holder leaving while another still renders the same fence.
 */
export function retainFenceChunkWalk(code: string, language: string | null): void {
  const key = fenceWalkKey(code, language);
  fenceWalkHolders.set(key, (fenceWalkHolders.get(key) ?? 0) + 1);
}

/**
 * Release the walk of one fence. `CodeBlock` calls this when the fence it
 * rendered is gone or its text was replaced, so a transcript the user scrolled
 * past keeps no highlighted copy of its code. The walk is dropped only once no
 * mounted block holds it: a fence still on screen keeps its walk (a FlashList
 * remount then mounts without re-highlighting its lines), and its retained
 * tokens are what the cache budget is charged for.
 */
export function releaseFenceChunkWalk(code: string, language: string | null): void {
  const key = fenceWalkKey(code, language);
  const holders = fenceWalkHolders.get(key) ?? 0;
  if (holders > 1) {
    fenceWalkHolders.set(key, holders - 1);
    return;
  }
  fenceWalkHolders.delete(key);
  // A block that renders the same fence can mount in the same commit as this
  // release, and React runs a commit's effect cleanups before its effect
  // creates: that new block's retain has not landed yet. Drop the entry on the
  // next task instead, once the commit's creates have run, and keep it if one
  // of them retained it.
  queueMicrotask(() => {
    if (!fenceWalkHolders.has(key)) {
      fenceWalkCache.delete(key);
    }
  });
}

/** For tests: drop the resumable fence walks so a suite starts cold. */
export function clearFenceWalkCacheForTests(): void {
  fenceWalkCache.clear();
  fenceWalkHolders.clear();
}

/** For tests: the walks currently retained and the total weight they are charged. */
export function fenceWalkCacheStatsForTests() {
  return { entries: fenceWalkCache.size, weight: fenceWalkCache.weight };
}

/**
 * Tokenize source line by line for the CodeBlock renderer. One token list per
 * line, each line highlighted independently (the per-line ceiling documented
 * in `highlight.ts` — multi-line tokens may mis-color on continuation lines).
 */
export function tokenizeCodeLines(code: string, language: string | null): HighlightToken[][] {
  return code.split('\n').map(line => highlightLine(line, language));
}
