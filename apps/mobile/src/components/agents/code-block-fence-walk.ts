import { highlightLine, type HighlightToken } from '@/lib/pr-review/diff/highlight';

import { CharacterBoundedCache } from './character-bounded-cache';

/**
 * The resumable walk of one fence's source lines into render chunks, and the
 * bounded cache that keeps those walks across mount batches and streamed
 * appends. `code-block-model.ts` owns the fence's language and its per-line
 * tokenization; this module owns the chunk caps the walk enforces and the
 * walk's own retained-token budget.
 */

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
 *
 * A walk also remembers the source it walks, so a streamed append can extend
 * it instead of starting over: `findExtendableFenceWalk` finds the cached walk
 * whose source is the longest prefix of the new text and clones it at
 * `pullSnapshot` — the walk state right before the last line it pulled. An
 * append can change the tokens of that one line (its text grew past the pull,
 * or it was the blank phantom a trailing newline produced), so rewinding
 * exactly that line keeps the resumed output identical to a fresh walk of
 * the extended source while every earlier line keeps its highlight.
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
  // The source the walk walks, its split lines, and the index of the next line
  // to pull. A `chunkTokenLines` walk of an in-memory line list leaves these
  // at their defaults: it is never resumed or extended.
  source: string;
  language: string | null;
  lines: string[];
  lineIndex: number;
  // The walk state right before the last successful pull: the restore point an
  // extension rewinds to. `null` while nothing has been pulled yet.
  pullSnapshot: WalkSnapshot | null;
};

/**
 * The walk state before one pull: what the extension rewind restores. The
 * pending segments are empty at this point — a pull happens only after the
 * previous line's segments were all placed — so they need no field.
 */
type WalkSnapshot = {
  lineIndex: number;
  chunkCount: number;
  chunkSegments: number;
  tagged: number;
  retainedTokens: number;
  retainedCharacters: number;
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
    source: '',
    language: null,
    lines: [],
    lineIndex: 0,
    pullSnapshot: null,
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
      const snapshot = snapshotOf(walk);
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
      // The pull placed something: the snapshot becomes the restore point the
      // next extension rewinds to. A pull that found nothing changes nothing
      // except `done`, so its snapshot is not committed.
      walk.pullSnapshot = snapshot;
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

/**
 * One fence's resumable walk, in the one place it can be.
 *
 * `held` while a mounted block renders that fence: the cache's pinned predicate
 * protects it, because the block's next mount batch continues from this walk.
 * `cached` once no block holds it: it is kept only to make a remount cheap, and
 * the weight budget may evict it. A separate holder map could name a key the
 * cache had already dropped; one entry cannot.
 */
type FenceWalkEntry =
  | { readonly kind: 'held'; readonly walk: ChunkWalk; readonly holders: number }
  | { readonly kind: 'cached'; readonly walk: ChunkWalk };

const fenceWalkCache = new CharacterBoundedCache<FenceWalkEntry>(
  CODE_FENCE_WALK_CACHE_CHARACTERS,
  entry => entry.kind === 'held'
);

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

/** A fresh walk from line zero of one fence, highlighting a line as it is pulled. */
function createFenceChunkWalk(code: string, language: string | null): ChunkWalk {
  const walk = createChunkWalk(() => {
    const line = walk.lines[walk.lineIndex];
    if (line === undefined) {
      return undefined;
    }
    walk.lineIndex += 1;
    return highlightLine(line, language);
  });
  walk.source = code;
  walk.language = language;
  walk.lines = code.split('\n');
  return walk;
}

/**
 * The walk state right before the last line a successful pull started: the
 * restore point an extension rebuilds from.
 */
function snapshotOf(walk: ChunkWalk): WalkSnapshot {
  return {
    lineIndex: walk.lineIndex,
    chunkCount: walk.chunks.length,
    chunkSegments: walk.chunk.length,
    tagged: walk.tagged,
    retainedTokens: walk.retainedTokens,
    retainedCharacters: walk.retainedCharacters,
  };
}

/**
 * Clone `walk` for the extended source `code` (a strict extension of
 * `walk.source` with the same language): restore the boundary state, merge the
 * appended text into the line list, and return a fresh walk. The source walk
 * is untouched — another block can still be rendering the shorter text — and
 * the clone shares the completed chunk arrays, so already-mounted chunks keep
 * their token identities and their render work.
 */
function extendFenceChunkWalk(walk: ChunkWalk, code: string): ChunkWalk {
  const snapshot = walk.pullSnapshot;
  // An append changes the tokens of exactly one already-pulled line: the
  // source's last line, when the walk pulled it — its text grew past the
  // pull, or it was the blank phantom a trailing newline produced. Rewind to
  // right before that pull. A walk that stopped at a mount front before the
  // source's end placed only final lines — the appended text goes after the
  // whole old source — so it carries its state unchanged and only its line
  // list grows.
  const rewind = snapshot?.lineIndex === walk.lines.length - 1;
  const clone: ChunkWalk = {
    pullLine: () => {
      const line = clone.lines[clone.lineIndex];
      if (line === undefined) {
        return undefined;
      }
      clone.lineIndex += 1;
      return highlightLine(line, clone.language);
    },
    pendingSegments: rewind ? [] : [...walk.pendingSegments],
    pendingIndex: rewind ? 0 : walk.pendingIndex,
    // Completed chunks are shared by reference: their lines are final, and
    // sharing is what lets the memoized chunk views skip already-mounted work.
    chunks: rewind ? walk.chunks.slice(0, snapshot.chunkCount) : [...walk.chunks],
    // A rewind whose tail line completed the partial chunk (the 32-line cap
    // or the run-cap flush pushed it into `chunks`) finds the pre-pull partial
    // at `chunks[snapshot.chunkCount]`, its own segments before the tail's;
    // otherwise that read is past the end and the partial is still `walk.chunk`.
    // A carried walk restores nothing: its partial belongs to lines no append
    // can change.
    chunk: rewind
      ? (walk.chunks[snapshot.chunkCount] ?? walk.chunk).slice(0, snapshot.chunkSegments)
      : [...walk.chunk],
    tagged: rewind ? snapshot.tagged : walk.tagged,
    retainedTokens: rewind ? snapshot.retainedTokens : walk.retainedTokens,
    retainedCharacters: rewind ? snapshot.retainedCharacters : walk.retainedCharacters,
    done: false,
    source: code,
    language: walk.language,
    lines: [...walk.lines],
    lineIndex: rewind ? snapshot.lineIndex : walk.lineIndex,
    pullSnapshot: null,
  };
  const parts = code.slice(walk.source.length).split('\n');
  // The old source's last line grows by the appended text's first run; the
  // appended lines follow it. The list then matches `code.split('\n')` exactly.
  const last = clone.lines.length - 1;
  clone.lines[last] = (clone.lines[last] ?? '') + (parts[0] ?? '');
  clone.lines.push(...parts.slice(1));
  return clone;
}

/**
 * Find the cached fence walk the source extends: a walk of the same language
 * whose source is a strict prefix of `code`. The longest such source wins, so
 * the resumed walk highlights only the appended lines past it (plus its one
 * provisional tail line). Scanning the values costs a `startsWith` per cached
 * walk — bounded by the walk cache's character budget — and the probe must not
 * refresh recency, or the fences the user scrolled past would be pinned by a
 * fence that happens to extend one of them.
 */
function findExtendableFenceWalk(code: string, language: string | null): ChunkWalk | undefined {
  let best: ChunkWalk | undefined = undefined;
  for (const entry of fenceWalkCache.values()) {
    const walk = entry.walk;
    if (
      walk.language === language &&
      walk.source.length < code.length &&
      code.startsWith(walk.source) &&
      (best === undefined || walk.source.length > best.source.length)
    ) {
      best = walk;
    }
  }
  return best;
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
 * walk per batch produced. The walk is resumed per fence value across mount
 * batches AND across streamed appends of the same fence: a fence whose source
 * extends the walked prefix continues that walk — only the appended lines and
 * the one provisional tail line are highlighted again — while a genuinely
 * replaced source starts a new walk.
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
  const existing = fenceWalkCache.get(key);
  const found = existing === undefined ? findExtendableFenceWalk(code, language) : undefined;
  const walk =
    existing?.walk ??
    (found !== undefined
      ? extendFenceChunkWalk(found, code)
      : createFenceChunkWalk(code, language));
  advanceChunkWalk(walk, maxChunks);
  // Charge the cache for what the walk now retains, keeping its ownership: a
  // held walk stays pinned, a cached one stays evictable. `set` also moves the
  // entry to the most-recent end, which is what keeps the fence being mounted
  // ahead of the walks of the fences the user scrolled past.
  const entry: FenceWalkEntry =
    existing?.kind === 'held'
      ? { kind: 'held', walk, holders: existing.holders }
      : { kind: 'cached', walk };
  fenceWalkCache.set(key, entry, fenceWalkWeight(key, walk));
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
  const entry = fenceWalkCache.get(key);
  const walk = entry?.walk ?? createFenceChunkWalk(code, language);
  const next: FenceWalkEntry = {
    kind: 'held',
    walk,
    holders: entry?.kind === 'held' ? entry.holders + 1 : 1,
  };
  fenceWalkCache.set(key, next, fenceWalkWeight(key, walk));
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
  const entry = fenceWalkCache.peek(key);
  if (entry === undefined) {
    return;
  }
  if (entry.kind === 'held' && entry.holders > 1) {
    const walk = entry.walk;
    fenceWalkCache.update(
      key,
      { kind: 'held', walk, holders: entry.holders - 1 },
      fenceWalkWeight(key, walk)
    );
    return;
  }
  // In place, so the released walk keeps its place in the eviction order: it is
  // dropped on the next task, and making it the newest would push out a walk
  // another fence still resumes from.
  fenceWalkCache.update(
    key,
    { kind: 'cached', walk: entry.walk },
    fenceWalkWeight(key, entry.walk)
  );
  // A block that renders the same fence can mount in the same commit as this
  // release, and React runs a commit's effect cleanups before its effect
  // creates: that new block's retain has not landed yet. Drop the entry on the
  // next task instead, once the commit's creates have run, and keep it if one
  // of them retained it.
  queueMicrotask(() => {
    if (fenceWalkCache.peek(key)?.kind === 'cached') {
      fenceWalkCache.delete(key);
    }
  });
}

/** For tests: drop the resumable fence walks so a suite starts cold. */
export function clearFenceWalkCacheForTests(): void {
  fenceWalkCache.clear();
}

/** For tests: the walks currently cached, the total weight they are charged, and how many are held. */
export function fenceWalkCacheStatsForTests() {
  return {
    entries: fenceWalkCache.size,
    weight: fenceWalkCache.weight,
    held: fenceWalkCache.pinnedCount,
  };
}
