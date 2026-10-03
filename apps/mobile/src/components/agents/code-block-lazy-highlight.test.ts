import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HighlightModule from '@/lib/pr-review/diff/highlight';

import {
  chunkCodeLines,
  chunkTokenLines,
  clearFenceWalkCacheForTests,
  CODE_CHUNK_MOUNT_BATCH,
  CODE_FIRST_PAINT_CHUNKS,
  tokenizeCodeLines,
} from './code-block-model';

// Wrap the real per-line highlighter so the tests can count how many source
// lines a fence's mount batches actually tokenize.
const highlightCalls = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('@/lib/pr-review/diff/highlight', async importOriginal => {
  const actual = await importOriginal<typeof HighlightModule>();
  return {
    ...actual,
    highlightLine: (text: string, language: string | null) => {
      highlightCalls.lines.push(text);
      return actual.highlightLine(text, language);
    },
  };
});

const LINE_COUNT = 5000;
const SOURCE = Array.from(
  { length: LINE_COUNT },
  (_, index) => `const value${index} = ${index};`
).join('\n');

beforeEach(() => {
  highlightCalls.lines = [];
  clearFenceWalkCacheForTests();
});

describe('chunkCodeLines lazy highlighting', () => {
  it('highlights only the lines the first paint mounts', () => {
    const page = chunkCodeLines(SOURCE, 'typescript', CODE_FIRST_PAINT_CHUNKS);

    expect(page.chunks).toHaveLength(CODE_FIRST_PAINT_CHUNKS);
    expect(page.hasMore).toBe(true);
    expect(highlightCalls.lines.length).toBeGreaterThan(0);
    // The whole fence is 5,000 lines; a first paint is a bounded front of it.
    expect(highlightCalls.lines.length).toBeLessThanOrEqual(200);
    expect(highlightCalls.lines.length).toBeLessThan(LINE_COUNT);
  });

  it('does not re-highlight the prefix on a later mount batch', () => {
    // Regression: the lazy chunker restarted its line index at zero on every
    // mount batch, so a 5,000-line fence re-highlighted the whole prefix up to
    // the mounted front each time — quadratic in the fence's line count.
    let mounted = CODE_FIRST_PAINT_CHUNKS;
    for (;;) {
      const page = chunkCodeLines(SOURCE, 'typescript', mounted);
      if (!page.hasMore) {
        break;
      }
      mounted += CODE_CHUNK_MOUNT_BATCH;
    }

    // Across the whole batch progression each source line is highlighted once.
    expect(highlightCalls.lines.length).toBe(LINE_COUNT);
  });

  it('resumes a fence larger than the walk-cache budget instead of re-walking it', () => {
    // Regression: the walk key holds the whole source, so at 10x the audit's
    // 200 KB fence the key alone is over 2,000,000 characters — heavier than
    // the whole walk cache. evictFenceWalks then deleted the walk the instant
    // it was inserted, so every mount batch rebuilt it from line 0 and
    // re-highlighted the entire prefix (quadratic in the line count). The
    // newest walk has to survive its own insertion.
    const lineCount = 3200;
    const source = Array.from(
      { length: lineCount },
      (_, index) => `const value${index} = ${'x'.repeat(700)};`
    ).join('\n');
    expect(source.length).toBeGreaterThan(2_000_000);

    let mounted = CODE_FIRST_PAINT_CHUNKS;
    for (;;) {
      const page = chunkCodeLines(source, null, mounted);
      if (!page.hasMore) {
        break;
      }
      mounted += CODE_CHUNK_MOUNT_BATCH;
    }

    // Each source line is highlighted exactly once across the progression.
    expect(highlightCalls.lines.length).toBe(lineCount);
  });

  it('matches the whole-fence chunk boundaries across the batch progression', () => {
    const code = `a\n\nb\n${'x'.repeat(2000)}`;
    const expected = chunkTokenLines(tokenizeCodeLines(code, null));

    let mounted = CODE_FIRST_PAINT_CHUNKS;
    let page = chunkCodeLines(code, null, mounted);
    while (page.hasMore) {
      mounted += CODE_CHUNK_MOUNT_BATCH;
      page = chunkCodeLines(code, null, mounted);
    }

    expect(page.chunks).toEqual(expected);
  });
});
