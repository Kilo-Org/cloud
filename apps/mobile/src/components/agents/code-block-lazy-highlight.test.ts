import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HighlightModule from '@/lib/pr-review/diff/highlight';

import {
  chunkCodeLines,
  chunkTokenLines,
  clearFenceWalkCacheForTests,
  fenceWalkCacheStatsForTests,
  releaseFenceChunkWalk,
  retainFenceChunkWalk,
} from './code-block-fence-walk';
import {
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

  it('drops the released walk instead of the cached neighbour', async () => {
    // Regression: releasing a walk re-inserted it as the newest entry, which
    // eviction never drops, so it pushed out a cached walk that was still worth
    // keeping and then deleted itself on the next task anyway.
    const held = Array.from({ length: 400 }, (_, index) => `const held${index} = ${index};`).join(
      '\n'
    );
    const cached = Array.from(
      { length: 3200 },
      (_, index) => `const big${index} = ${'x'.repeat(700)};`
    ).join('\n');

    chunkCodeLines(held, 'typescript', CODE_FIRST_PAINT_CHUNKS);
    retainFenceChunkWalk(held, 'typescript');
    chunkCodeLines(cached, null, CODE_FIRST_PAINT_CHUNKS);
    expect(fenceWalkCacheStatsForTests().held).toBe(1);

    releaseFenceChunkWalk(held, 'typescript');
    await Promise.resolve();

    // The released entry is gone and the cached one kept its place.
    expect(fenceWalkCacheStatsForTests()).toMatchObject({ entries: 1, held: 0 });
    // The neighbour still resumes: asking for what it already painted highlights
    // nothing, where a dropped walk would re-highlight from line 0.
    highlightCalls.lines = [];
    chunkCodeLines(cached, null, CODE_FIRST_PAINT_CHUNKS);
    expect(highlightCalls.lines).toEqual([]);
  });

  it('keeps a retained fence walk when another fence exceeds the budget', () => {
    // Regression: the holder count lived in a map beside the cache and eviction
    // never consulted it, so another fence's `set` evicted the walk a mounted
    // block still held. Its next batch then re-walked from line 0 and
    // re-highlighted the prefix it had already placed.
    const held = Array.from({ length: 400 }, (_, index) => `const held${index} = ${index};`).join(
      '\n'
    );
    chunkCodeLines(held, 'typescript', CODE_FIRST_PAINT_CHUNKS);
    retainFenceChunkWalk(held, 'typescript');
    const highlightedPrefix = [...highlightCalls.lines];
    expect(highlightedPrefix.length).toBeGreaterThan(0);

    const overBudget = Array.from(
      { length: 3200 },
      (_, index) => `const big${index} = ${'x'.repeat(700)};`
    ).join('\n');
    expect(overBudget.length).toBeGreaterThan(2_000_000);
    chunkCodeLines(overBudget, null, CODE_FIRST_PAINT_CHUNKS);

    highlightCalls.lines = [];
    const mounted = CODE_FIRST_PAINT_CHUNKS + CODE_CHUNK_MOUNT_BATCH;
    const page = chunkCodeLines(held, 'typescript', mounted);
    expect(page.chunks.length).toBeGreaterThan(CODE_FIRST_PAINT_CHUNKS);

    // The batch continues past the prefix instead of repeating it.
    const newlyHighlighted = highlightCalls.lines;
    expect(newlyHighlighted.length).toBeGreaterThan(0);
    const alreadyHighlighted = new Set(highlightedPrefix);
    expect(newlyHighlighted.filter(line => alreadyHighlighted.has(line))).toEqual([]);
    expect(newlyHighlighted).toEqual(
      held
        .split('\n')
        .slice(highlightedPrefix.length, highlightedPrefix.length + newlyHighlighted.length)
    );
    // The pinned walk is the one entry the budget may not drop.
    expect(fenceWalkCacheStatsForTests().held).toBe(1);
  });
});

describe('chunkCodeLines streamed fence extension', () => {
  const SOURCE_LINES = SOURCE.split('\n');
  const textOf = (lineCount: number) => SOURCE_LINES.slice(0, lineCount).join('\n');

  it('highlights only the appended lines when a stream extends the fence', () => {
    // Regression: a streamed fence published under a new key on every append,
    // so the publish found no cached walk for it and started a fresh walk at
    // line 0 — re-highlighting the whole prefix up to the mounted front on
    // each append, quadratic in the streamed length and the very work the
    // resumable walk exists to avoid. The walk now resumes from the cached
    // prefix: only the appended lines and its one provisional tail line are
    // highlighted again.
    const appends = [300, 300, 300, 300, 460];
    const lineCount = appends.reduce((total, appended) => total + appended, 40);
    const finalText = textOf(lineCount);
    const finalChunkCount = chunkTokenLines(tokenizeCodeLines(finalText, 'typescript')).length;

    const allCalls: string[] = [];
    const seen = new Set<string>();
    const publish = (text: string, mounted: number) => {
      highlightCalls.lines = [];
      const page = chunkCodeLines(text, 'typescript', mounted);
      const calls = [...highlightCalls.lines];
      allCalls.push(...calls);
      return { page, calls };
    };

    let streamed = 40;
    const first = publish(textOf(streamed), CODE_FIRST_PAINT_CHUNKS);
    expect(first.page.hasMore).toBe(false);
    for (const line of first.calls) {
      seen.add(line);
    }

    let mounted = CODE_FIRST_PAINT_CHUNKS;
    let lastPage = first.page;
    for (const [round, appended] of appends.entries()) {
      streamed += appended;
      const last = round === appends.length - 1;
      // Each publish mounts one more bounded batch; the last mounts the whole
      // final fence, so every line of it is walked by the end.
      mounted = last ? finalChunkCount : mounted + CODE_CHUNK_MOUNT_BATCH;
      const { page, calls } = publish(textOf(streamed), mounted);
      lastPage = page;

      expect(page.chunks).toHaveLength(mounted);
      // The resumed walk pulls the appended lines past the old tail, so an
      // intermediate batch still fronts on more lines further down.
      expect(page.hasMore).toBe(!last);
      // At most one line per publish repeats: the first line the resumed walk
      // pulls may be the previous walk's provisional tail (when that walk had
      // reached its own source's end and rewound to it) — or, when it stopped
      // at a mount front, the next appended line. Every line after it is new.
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.slice(1).filter(line => seen.has(line))).toEqual([]);
      for (const line of calls) {
        seen.add(line);
      }
    }

    const counts = new Map<string, number>();
    for (const line of allCalls) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    const finalLines = finalText.split('\n');
    const publishCount = 1 + appends.length;
    // Every line of the final fence was highlighted, and none more than twice:
    // once when it was appended, plus the single provisional tail repeat when
    // the next append rewound it.
    expect(counts.size).toBe(finalLines.length);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    // A fresh walk per publish is quadratic — the whole prefix re-highlighted
    // up to the mounted front on every append. Resuming costs one call per
    // appended line plus the one tail repeat.
    expect(allCalls.length).toBeLessThan(finalLines.length + 2 * publishCount);
    expect(allCalls.length).toBeLessThan(4 * finalLines.length);
    // The resumed walk's output is the whole fence's, not an approximation:
    // the appended text's chunk boundaries match a fresh walk of it.
    expect(lastPage.chunks).toEqual(chunkTokenLines(tokenizeCodeLines(finalText, 'typescript')));
  });

  it('keeps the resumed walk identical when the tail line grows mid-line', () => {
    // A streamed fence's last line grows a token at a time. The resumed walk
    // rewinds exactly that line, so the tokens it re-highlights still produce
    // the chunks a fresh walk of the final source produces.
    const head = 'const a = 1;\nconst b = 2;';
    const growth = ['const x = ', 'const x = 1', 'const x = 1 + ', 'const x = 1 + 2 + 3;'];

    const counts = new Map<string, number>();
    const publish = (text: string) => {
      highlightCalls.lines = [];
      const page = chunkCodeLines(text, 'typescript', CODE_FIRST_PAINT_CHUNKS);
      const calls = [...highlightCalls.lines];
      for (const line of calls) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
      return { page, calls };
    };

    const pages = growth.map(tail => publish(`${head}\n${tail}`));

    expect(pages[0]?.calls).toEqual(['const a = 1;', 'const b = 2;', growth[0]]);
    // Appending to the tail line re-highlights that line only; no earlier line
    // is highlighted again.
    expect(pages.slice(1).map(published => published.calls)).toEqual(
      growth.slice(1).map(tail => [tail])
    );
    for (const [index, published] of pages.entries()) {
      expect(published.page.chunks).toEqual(
        chunkTokenLines(tokenizeCodeLines(`${head}\n${growth[index]}`, 'typescript'))
      );
    }

    const finalTail = growth.at(-1) ?? '';
    const finalText = `${head}\n${finalTail}`;
    const finalLines = finalText.split('\n');
    // Every line but the growing tail was highlighted exactly once.
    for (const line of finalLines.slice(0, -1)) {
      expect(counts.get(line)).toBe(1);
    }
    const totalCalls = [...counts.values()].reduce((total, count) => total + count, 0);
    expect(totalCalls).toBeLessThan(finalLines.length + growth.length);
  });

  it('clones the extended walk instead of mutating the cached one', () => {
    // Two blocks can render the same fence at different lengths — a streamed
    // append while the shorter text is still on screen. Extending must clone
    // the walk at its restore point, not advance the cached walk: the shorter
    // fence's next publish still yields its own chunks and highlights nothing
    // again.
    const lines = SOURCE.split('\n');
    const prefix = lines.slice(0, 200).join('\n');
    const extended = `${prefix}\n${lines.slice(200, 250).join('\n')}`;
    const prefixChunks = chunkTokenLines(tokenizeCodeLines(prefix, 'typescript'));
    const extendedChunks = chunkTokenLines(tokenizeCodeLines(extended, 'typescript'));
    expect(prefixChunks.length).toBeGreaterThan(CODE_FIRST_PAINT_CHUNKS);

    highlightCalls.lines = [];
    const first = chunkCodeLines(prefix, 'typescript', prefixChunks.length);
    expect(highlightCalls.lines).toEqual(lines.slice(0, 200));
    expect(first.chunks).toEqual(prefixChunks);
    retainFenceChunkWalk(prefix, 'typescript');

    highlightCalls.lines = [];
    const resumed = chunkCodeLines(extended, 'typescript', extendedChunks.length);
    // Only the provisional tail line and the appended text were highlighted.
    expect(highlightCalls.lines).toEqual([lines[199], ...lines.slice(200, 250)]);
    expect(resumed.chunks).toEqual(extendedChunks);
    // The completed chunks are shared by reference; only the tail chunk, whose
    // last line the append changes, is rebuilt.
    const sharedChunks = first.chunks.length - 1;
    for (let index = 0; index < sharedChunks; index += 1) {
      expect(resumed.chunks[index]).toBe(first.chunks[index]);
    }
    expect(resumed.chunks[sharedChunks]).not.toBe(first.chunks[sharedChunks]);

    // The cached shorter walk survived the extension: its next publish
    // highlights nothing and still yields the whole prefix's chunks.
    highlightCalls.lines = [];
    const again = chunkCodeLines(prefix, 'typescript', prefixChunks.length);
    expect(highlightCalls.lines).toEqual([]);
    expect(again.chunks).toEqual(prefixChunks);
  });
});

describe('fence walk cache accounting', () => {
  it('weighs a walk by the highlighted tokens it retains, not only its source', () => {
    // The walk holds every token it placed, and those token texts are copies of
    // the source. Charging only the key made a warm cache hold several times the
    // budget it claims to keep.
    const code = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`).join(
      '\n'
    );
    let mounted = CODE_FIRST_PAINT_CHUNKS;
    for (;;) {
      const page = chunkCodeLines(code, 'typescript', mounted);
      if (!page.hasMore) {
        break;
      }
      mounted += CODE_CHUNK_MOUNT_BATCH;
    }

    const { entries, weight } = fenceWalkCacheStatsForTests();
    expect(entries).toBe(1);
    expect(weight).toBeGreaterThan(code.length);
  });

  it('drops one fence walk when its block releases it', async () => {
    const code = 'const value = 1;';
    chunkCodeLines(code, 'typescript', CODE_FIRST_PAINT_CHUNKS);
    expect(fenceWalkCacheStatsForTests().entries).toBe(1);

    releaseFenceChunkWalk(code, 'typescript');
    // The entry is dropped on the task after the release, so a block mounting
    // the same fence in that commit keeps it.
    await Promise.resolve();
    expect(fenceWalkCacheStatsForTests()).toEqual({ entries: 0, weight: 0, held: 0 });

    // A released fence highlights its lines again, because nothing is retained.
    highlightCalls.lines = [];
    chunkCodeLines(code, 'typescript', CODE_FIRST_PAINT_CHUNKS);
    expect(highlightCalls.lines).toEqual([code]);
  });

  it('keeps the walks of other fences when one is released', async () => {
    chunkCodeLines('const a = 1;', null, CODE_FIRST_PAINT_CHUNKS);
    chunkCodeLines('const b = 2;', null, CODE_FIRST_PAINT_CHUNKS);
    expect(fenceWalkCacheStatsForTests().entries).toBe(2);

    releaseFenceChunkWalk('const a = 1;', null);
    await Promise.resolve();
    expect(fenceWalkCacheStatsForTests().entries).toBe(1);
  });
});
