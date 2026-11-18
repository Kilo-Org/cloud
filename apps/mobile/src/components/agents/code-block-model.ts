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
 * Tokenize source line by line for the CodeBlock renderer. One token list per
 * line, each line highlighted independently (the per-line ceiling documented
 * in `highlight.ts` — multi-line tokens may mis-color on continuation lines).
 */
export function tokenizeCodeLines(code: string, language: string | null): HighlightToken[][] {
  return code.split('\n').map(line => highlightLine(line, language));
}
