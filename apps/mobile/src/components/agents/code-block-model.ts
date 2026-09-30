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
 * the code at once, and each later commit adds `CODE_CHUNK_MOUNT_BATCH` more
 * chunks until the fence is fully consumed (see `code-block.tsx`). A fence
 * whose text only grows keeps its mounts; only a replaced fence starts over
 * from this first paint.
 */
export const CODE_FIRST_PAINT_CHUNKS = 4;

/** Chunks added per bounded batch after the first paint. */
export const CODE_CHUNK_MOUNT_BATCH = 4;

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
 * The result of chunking highlighted lines: the chunks, and whether the input
 * was consumed within `maxChunks`.
 */
type ChunkSourceLinesResult = {
  chunks: HighlightToken[][][];
  consumed: boolean;
};

/**
 * Group highlighted lines into render chunks of at most `CODE_CHUNK_LINES`
 * lines and `CODE_CHUNK_TOKENS` tagged runs. A line denser than the run budget
 * is split at token boundaries first, and each segment then counts as a line
 * of the chunk it lands in, so one `Text` never holds the whole run set of a
 * single-line fence. The last chunk holds the remainder.
 *
 * The lines are consumed on demand, so a caller that highlights each line as
 * it arrives only pays for the lines a chunk actually needs. Chunking stops as
 * soon as `maxChunks` chunks are complete; `consumed` is false when the input
 * has more lines beyond that point, and true when it ran out first. Stopping
 * only ever happens at a chunk boundary, so the last chunk of a stopped run is
 * complete. `chunkTokenLines` passes every line and no cap, so it always
 * consumes its input.
 */
function groupChunks(
  lines: Iterable<readonly HighlightToken[]>,
  maxChunks: number
): ChunkSourceLinesResult {
  const chunks: HighlightToken[][][] = [];
  let chunk: HighlightToken[][] = [];
  let tagged = 0;
  for (const line of lines) {
    for (const segment of splitLineTokens(line)) {
      const runs = taggedRunCount(segment);
      if (
        chunk.length > 0 &&
        (chunk.length >= CODE_CHUNK_LINES || tagged + runs > CODE_CHUNK_TOKENS)
      ) {
        chunks.push(chunk);
        chunk = [];
        tagged = 0;
        if (chunks.length >= maxChunks) {
          return { chunks, consumed: false };
        }
      }
      chunk.push(segment);
      tagged += runs;
    }
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return { chunks, consumed: true };
}

/**
 * Chunk already-tokenized lines into the render chunks a fence mounts, with
 * every line consumed (see `groupChunks` for the line and run rules).
 */
export function chunkTokenLines(lines: readonly HighlightToken[][]): HighlightToken[][][] {
  return groupChunks(lines, Number.POSITIVE_INFINITY).chunks;
}

/**
 * Tokenize source line by line for the CodeBlock renderer. One token list per
 * line, each line highlighted independently (the per-line ceiling documented
 * in `highlight.ts` — multi-line tokens may mis-color on continuation lines).
 */
export function tokenizeCodeLines(code: string, language: string | null): HighlightToken[][] {
  return code.split('\n').map(line => highlightLine(line, language));
}

/**
 * The highlighted lines already produced for one fence's source-line array.
 * `tokenLines` grows in source order; `language` guards a fence that is
 * re-rendered with a different grammar.
 */
type SourceLineHighlightCache = {
  language: string | null;
  tokenLines: HighlightToken[][];
};

/**
 * Per-fence highlight memo, keyed by the identity of the source-line array.
 *
 * `CodeBlock` derives `sourceLines` with a `useMemo` on the display text, so a
 * fence that is re-rendered or re-chunked while its text is unchanged keeps the
 * same array and therefore the same highlighted lines. Without this, the lazy
 * batch path re-walked the fence from line 0 on every commit: each batch
 * re-ran `highlightLine` for every line before it, an O(lines²/batch) walk that
 * went quadratic once the per-line LRU in `highlight.ts` evicted a fence past
 * its 5,000-entry cap, re-tokenizing the whole fence in one commit. The memo is
 * a `WeakMap` so an unmounted fence's lines are collected with its array.
 */
const sourceLineHighlightCaches = new WeakMap<readonly string[], SourceLineHighlightCache>();

/**
 * Yield one highlighted line per source line, on demand, so `groupChunks` only
 * runs `highlightLine` for the lines the mounted chunks need. A line already
 * highlighted for this same source-line array is yielded from the per-fence
 * memo without calling `highlightLine` again, so raising `maxChunks` for a
 * later batch only pays for the lines that batch newly reaches.
 */
function* cachedHighlightSourceLines(
  sourceLines: readonly string[],
  language: string | null
): Generator<HighlightToken[]> {
  let cache = sourceLineHighlightCaches.get(sourceLines);
  if (cache === undefined || cache.language !== language) {
    cache = { language, tokenLines: [] };
    sourceLineHighlightCaches.set(sourceLines, cache);
  }
  for (let index = 0; index < sourceLines.length; index += 1) {
    let tokens = cache.tokenLines[index];
    if (tokens === undefined) {
      tokens = highlightLine(sourceLines[index] ?? '', language);
      cache.tokenLines.push(tokens);
    }
    yield tokens;
  }
}

/**
 * Chunk a fence lazily for the CodeBlock renderer: highlight source lines one
 * at a time through `highlightLine` (and its per-line LRU) and stop as soon as
 * `maxChunks` chunks are complete, so a mount that paints only the first
 * `CODE_FIRST_PAINT_CHUNKS` chunks never tokenizes the rest of the fence.
 *
 * Each already-highlighted line is reused across calls for the same
 * `sourceLines` array (see `cachedHighlightSourceLines`), so a later batch that
 * raises `maxChunks` walks over the lines it already paid for without running
 * `highlightLine` on them again.
 *
 * The line and run caps, the run-dense split, and where a chunk closes are the
 * same rules `chunkTokenLines` applies to already-tokenized lines, so the
 * chunks a fence mounts are identical to the whole-fence path whichever way
 * they are produced. `consumed` is true once the whole fence was chunked
 * within `maxChunks`; while it is false the caller asks for another bounded
 * batch.
 */
export function chunkSourceLines(
  sourceLines: readonly string[],
  language: string | null,
  maxChunks: number
): ChunkSourceLinesResult {
  return groupChunks(cachedHighlightSourceLines(sourceLines, language), maxChunks);
}
