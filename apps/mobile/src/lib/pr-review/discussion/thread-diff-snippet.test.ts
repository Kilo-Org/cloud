import { describe, expect, it } from 'vitest';

import {
  selectThreadDiffSnippet,
  THREAD_SNIPPET_MAX_LINES,
  type ThreadDiffSnippetInput,
} from './thread-diff-snippet';

const SIMPLE_HUNK = [
  '@@ -10,4 +10,5 @@ function greet() {',
  '   const name = "world";',
  '-  console.log(name);',
  '+  console.log("hello " + name);',
  '+  return name;',
  ' }',
].join('\n');

function baseThread(overrides: Partial<ThreadDiffSnippetInput> = {}): ThreadDiffSnippetInput {
  return {
    diffHunk: SIMPLE_HUNK,
    subjectType: 'LINE',
    path: 'src/greet.ts',
    ...overrides,
  };
}

describe('selectThreadDiffSnippet', () => {
  it('returns null for a null diffHunk', () => {
    expect(selectThreadDiffSnippet(baseThread({ diffHunk: null }))).toBeNull();
  });

  it('returns null for an empty diffHunk', () => {
    expect(selectThreadDiffSnippet(baseThread({ diffHunk: '' }))).toBeNull();
  });

  it('returns null for FILE subject even when a hunk is present', () => {
    expect(
      selectThreadDiffSnippet(baseThread({ subjectType: 'FILE', diffHunk: SIMPLE_HUNK }))
    ).toBeNull();
  });

  it('parses a valid hunk into add/del/context lines with line numbers', () => {
    const snippet = selectThreadDiffSnippet(baseThread());
    expect(snippet).not.toBeNull();
    expect(snippet?.totalLineCount).toBe(5);
    expect(snippet?.lines).toEqual([
      {
        type: 'context',
        oldLine: 10,
        newLine: 10,
        text: '  const name = "world";',
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'del',
        oldLine: 11,
        text: '  console.log(name);',
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'add',
        newLine: 11,
        text: '  console.log("hello " + name);',
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'add',
        newLine: 12,
        text: '  return name;',
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'context',
        oldLine: 12,
        newLine: 13,
        text: '}',
        noNewlineAtEndOfFile: false,
      },
    ]);
  });

  it('parses a multi-line-range hunk (start/end span in header)', () => {
    const hunk = [
      '@@ -18,6 +18,8 @@ export function sum(a: number, b: number) {',
      '   // helpers',
      '   const left = a;',
      '-  return a + b;',
      '+  const right = b;',
      '+  const total = left + right;',
      '+  return total;',
      ' }',
    ].join('\n');
    const snippet = selectThreadDiffSnippet(baseThread({ diffHunk: hunk, path: 'src/math.ts' }));
    expect(snippet).not.toBeNull();
    expect(snippet?.totalLineCount).toBe(7);
    expect(snippet?.lines.filter(l => l.type === 'add')).toHaveLength(3);
    expect(snippet?.lines.filter(l => l.type === 'del')).toHaveLength(1);
    expect(snippet?.lines[0]?.oldLine).toBe(18);
    expect(snippet?.lines[0]?.newLine).toBe(18);
  });

  it('treats an outdated-style hunk the same as any other (no special casing)', () => {
    // Outdated threads still carry the original hunk string; selector
    // path is identical to a live LINE thread.
    const snippet = selectThreadDiffSnippet(
      baseThread({
        diffHunk: SIMPLE_HUNK,
        subjectType: 'LINE',
        path: 'src/alpha.ts',
      })
    );
    expect(snippet).not.toBeNull();
    expect(snippet?.lines).toHaveLength(5);
    expect(snippet?.language).toBe('typescript');
  });

  it('returns null for a garbage / unparseable string', () => {
    expect(selectThreadDiffSnippet(baseThread({ diffHunk: 'not a diff at all' }))).toBeNull();
    expect(selectThreadDiffSnippet(baseThread({ diffHunk: '@@ broken header' }))).toBeNull();
  });

  it('maps a .ts path to typescript', () => {
    const snippet = selectThreadDiffSnippet(baseThread({ path: 'apps/web/src/foo.ts' }));
    expect(snippet?.language).toBe('typescript');
  });

  it('returns language null when path is null', () => {
    const snippet = selectThreadDiffSnippet(baseThread({ path: null }));
    expect(snippet).not.toBeNull();
    expect(snippet?.language).toBeNull();
  });

  it(`caps lines at ${THREAD_SNIPPET_MAX_LINES} keeping the tail (anchored line)`, () => {
    const bodyLines: string[] = [];
    // 40 context lines after the header — well over the cap.
    for (let i = 0; i < 40; i += 1) {
      bodyLines.push(` line ${i}`);
    }
    const hunk = [`@@ -1,40 +1,40 @@`, ...bodyLines].join('\n');
    const snippet = selectThreadDiffSnippet(baseThread({ diffHunk: hunk }));
    expect(snippet).not.toBeNull();
    expect(snippet?.totalLineCount).toBe(40);
    expect(snippet?.lines).toHaveLength(THREAD_SNIPPET_MAX_LINES);
    // Head dropped; last 30 kept so the anchored (final) line survives.
    expect(snippet?.lines[0]?.text).toBe('line 10');
    expect(snippet?.lines[THREAD_SNIPPET_MAX_LINES - 1]?.text).toBe('line 39');
  });

  it('parses a bare @@ fragment without a diff --git header', () => {
    // GitHub comment.diffHunk is often just the @@ hunk, no file header.
    const snippet = selectThreadDiffSnippet(baseThread({ diffHunk: SIMPLE_HUNK }));
    expect(snippet).not.toBeNull();
    expect(snippet?.lines.length).toBeGreaterThan(0);
  });
});
