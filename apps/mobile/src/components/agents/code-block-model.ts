import { highlightLine, type HighlightToken } from '@/lib/pr-review/diff/highlight';

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

/** Tagged runs in one line or segment: the runs that cost an Android span. */
function taggedRunCount(tokens: readonly HighlightToken[]): number {
  let tagged = 0;
  for (const token of tokens) {
    if (token.className !== null) {
      tagged += 1;
    }
  }
  return tagged;
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
    const runs = taggedRunCount(segment);
    if (walk.chunk.length > 0 && walk.tagged + runs > CODE_CHUNK_TOKENS) {
      walk.chunks.push(walk.chunk);
      walk.chunk = [];
      walk.tagged = 0;
    }
    walk.chunk.push(segment);
    walk.tagged += runs;
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
const fenceWalkCache = new Map<string, { walk: ChunkWalk; weight: number }>();
let fenceWalkCacheWeight = 0;

function evictFenceWalks(): void {
  // Keep the newest entry even when it alone outweighs the budget. The key is
  // the fence's whole source, so at 10x the audit's 200 KB fence the key is
  // over 2,000,000 characters and the entry is heavier than the cache. Evicting
  // it the instant it was inserted dropped the walk the current mount batch had
  // just built, so the next batch rebuilt it from line 0 and re-highlighted the
  // whole prefix — quadratic in the fence's line count. The newest entry is the
  // active fence, so it must survive; dropping older entries first still bounds
  // the cache to one oversized fence plus whatever fits beside it.
  while (fenceWalkCacheWeight > CODE_FENCE_WALK_CACHE_CHARACTERS && fenceWalkCache.size > 1) {
    const oldest = fenceWalkCache.keys().next();
    if (oldest.done) {
      return;
    }
    const entry = fenceWalkCache.get(oldest.value);
    fenceWalkCache.delete(oldest.value);
    fenceWalkCacheWeight -= entry?.weight ?? 0;
  }
}

/**
 * The resumable walk for one fence, keyed by its language and full source.
 * Repeated calls with a larger `maxChunks` continue the same walk, so each
 * source line is highlighted once no matter how many mount batches it takes.
 * The key holds the whole source, so the character budget bounds the cache.
 */
function getFenceChunkWalk(code: string, language: string | null): ChunkWalk {
  const key = `${language ?? ''}\u0000${code}`;
  const cached = fenceWalkCache.get(key);
  if (cached !== undefined) {
    // Refresh recency: a Map iterates in insertion order.
    fenceWalkCache.delete(key);
    fenceWalkCache.set(key, cached);
    return cached.walk;
  }
  const lines = code.split('\n');
  let index = 0;
  const walk = createChunkWalk(() => {
    const line = lines[index];
    index += 1;
    return line === undefined ? undefined : highlightLine(line, language);
  });
  const weight = key.length;
  fenceWalkCache.set(key, { walk, weight });
  fenceWalkCacheWeight += weight;
  evictFenceWalks();
  return walk;
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
  const walk = getFenceChunkWalk(code, language);
  advanceChunkWalk(walk, maxChunks);
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

/** For tests: drop the resumable fence walks so a suite starts cold. */
export function clearFenceWalkCacheForTests(): void {
  fenceWalkCache.clear();
  fenceWalkCacheWeight = 0;
}

/**
 * Tokenize source line by line for the CodeBlock renderer. One token list per
 * line, each line highlighted independently (the per-line ceiling documented
 * in `highlight.ts` — multi-line tokens may mis-color on continuation lines).
 */
export function tokenizeCodeLines(code: string, language: string | null): HighlightToken[][] {
  return code.split('\n').map(line => highlightLine(line, language));
}
