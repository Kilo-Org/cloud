import { describe, expect, it, vi } from 'vitest';

import * as highlightModule from '@/lib/pr-review/diff/highlight';

import {
  chunkSourceLines,
  chunkTokenLines,
  CODE_CHUNK_MOUNT_BATCH,
  CODE_CHUNK_TOKENS,
  CODE_FIRST_PAINT_CHUNKS,
  normalizeFenceLanguage,
  tokenizeCodeLines,
} from './code-block-model';

// Count the highlighter's work: the lazy path must not re-run `highlightLine`
// for lines a previous batch already highlighted. The mock delegates to the
// real highlighter (and its per-line LRU) but records every invocation.
vi.mock('@/lib/pr-review/diff/highlight', async importOriginal => {
  const actual = await importOriginal<typeof highlightModule>();
  return { ...actual, highlightLine: vi.fn(actual.highlightLine) };
});

describe('normalizeFenceLanguage', () => {
  it('returns null for undefined, empty, and whitespace-only info strings', () => {
    expect(normalizeFenceLanguage(undefined)).toBeNull();
    expect(normalizeFenceLanguage('')).toBeNull();
    expect(normalizeFenceLanguage('   ')).toBeNull();
    expect(normalizeFenceLanguage('\t\n ')).toBeNull();
  });

  it('takes only the first word of the info string', () => {
    expect(normalizeFenceLanguage('TS extra')).toBe('ts');
    expect(normalizeFenceLanguage('python3.11 with mocks')).toBe('python3.11');
  });

  it('lower-cases the resolved language', () => {
    expect(normalizeFenceLanguage('TypeScript')).toBe('typescript');
    expect(normalizeFenceLanguage('PYTHON')).toBe('python');
    expect(normalizeFenceLanguage('  Ruby  ')).toBe('ruby');
  });

  it('passes single-word languages through unchanged', () => {
    expect(normalizeFenceLanguage('ts')).toBe('ts');
    expect(normalizeFenceLanguage('diff')).toBe('diff');
  });
});

describe('tokenizeCodeLines', () => {
  it('returns one token line per source line', () => {
    const tokens = tokenizeCodeLines('a\nb\nc', null);
    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toEqual([{ text: 'a', className: null }]);
    expect(tokens[1]).toEqual([{ text: 'b', className: null }]);
    expect(tokens[2]).toEqual([{ text: 'c', className: null }]);
  });

  it('passes plain text through for a null language', () => {
    const tokens = tokenizeCodeLines('const x = 1;', null);
    expect(tokens).toEqual([[{ text: 'const x = 1;', className: null }]]);
  });

  it('returns one empty token line for empty code', () => {
    expect(tokenizeCodeLines('', null)).toEqual([[{ text: '', className: null }]]);
  });

  it('highlights a TypeScript keyword with a non-null className', () => {
    const [firstLine] = tokenizeCodeLines('const x = 1;', 'typescript');
    expect(firstLine).toBeDefined();
    expect(firstLine?.some(token => token.className !== null)).toBe(true);
    const keywordToken = firstLine?.find(token => token.className === 'keyword');
    expect(keywordToken?.text).toBe('const');
  });
});

describe('chunkTokenLines', () => {
  it('splits a run-dense line so no chunk exceeds the run budget', () => {
    // Regression: the line cap alone left a single long source line in one
    // `Text` with its whole token run set applied in one frame. A minified read
    // body (the tool sheet routes up to 50,000 characters here) is one such
    // line, so the run budget has to break the line as well.
    const dense = JSON.stringify({
      items: Array.from({ length: 1200 }, (_, index) => ({ id: index, name: `name-${index}` })),
    });
    const lines = tokenizeCodeLines(dense, 'json');
    expect(lines).toHaveLength(1);
    const tagged = lines.flat().filter(token => token.className !== null).length;
    expect(tagged).toBeGreaterThan(CODE_CHUNK_TOKENS);

    const chunks = chunkTokenLines(lines);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.flat().filter(token => token.className !== null).length).toBeLessThanOrEqual(
        CODE_CHUNK_TOKENS
      );
    }

    // Nothing is dropped or reordered: the tokens of the chunks in order are
    // the tokens of the source lines in order.
    const chunkTokens = chunks.flatMap(chunk => chunk.flat());
    expect(chunkTokens.map(token => token.text).join('')).toBe(
      lines
        .flat()
        .map(token => token.text)
        .join('')
    );
  });

  it('keeps the line cap for ordinary code', () => {
    const code = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`).join(
      '\n'
    );
    const chunks = chunkTokenLines(tokenizeCodeLines(code, 'typescript'));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(32);
    expect(chunks[1]).toHaveLength(8);
  });
});

describe('chunkSourceLines', () => {
  it('highlights a bounded first paint, then only the lines each later batch reaches', () => {
    // Regression: every batch re-ran the lazy generator from line 0 and called
    // `highlightLine` for every line before its own. A long fence was
    // O(lines²/batch) highlighter work, and once the fence passed the per-line
    // LRU cap each batch re-tokenized the whole fence in one commit. The
    // per-fence memo makes the walk over already-highlighted lines free.
    const code = Array.from({ length: 5000 }, (_, index) => `const value${index} = ${index};`);
    const mocked = vi.mocked(highlightModule.highlightLine);
    mocked.mockClear();

    const first = chunkSourceLines(code, 'typescript', CODE_FIRST_PAINT_CHUNKS);
    expect(first.consumed).toBe(false);
    expect(first.chunks).toHaveLength(CODE_FIRST_PAINT_CHUNKS);
    const firstPaintCalls = mocked.mock.calls.length;
    expect(firstPaintCalls).toBeLessThanOrEqual(
      first.chunks.flat().length + CODE_FIRST_PAINT_CHUNKS
    );
    expect(firstPaintCalls).toBeLessThan(code.length / 10);

    let result = first;
    let maxChunks = CODE_FIRST_PAINT_CHUNKS;
    while (!result.consumed) {
      maxChunks += CODE_CHUNK_MOUNT_BATCH;
      result = chunkSourceLines(code, 'typescript', maxChunks);
    }

    // Every source line was highlighted at most once across every batch.
    expect(mocked.mock.calls.length).toBe(code.length);
    expect(result.chunks.length).toBeGreaterThan(1);
  });
});
