import { describe, expect, it } from 'vitest';

import { type ParsedHunk, parsePatch } from './parse-patch';

function firstHunk(hunks: ParsedHunk[]): ParsedHunk {
  const hunk = hunks[0];
  if (!hunk) {
    throw new Error('expected at least one hunk');
  }
  return hunk;
}

function nthHunk(hunks: ParsedHunk[], index: number): ParsedHunk {
  const hunk = hunks[index];
  if (!hunk) {
    throw new Error(`expected hunk at index ${index}`);
  }
  return hunk;
}

describe('parsePatch', () => {
  it('returns an empty result for a null patch', () => {
    expect(parsePatch(null)).toEqual({ isRename: false, hunks: [] });
  });

  it('returns an empty result for an empty string', () => {
    expect(parsePatch('')).toEqual({ isRename: false, hunks: [] });
  });

  it('parses a simple added line', () => {
    const patch = [
      'diff --git a/hello.ts b/hello.ts',
      'index 0000001..1111111 100644',
      '--- a/hello.ts',
      '+++ b/hello.ts',
      '@@ -0,0 +1,1 @@',
      '+export const hello = "world";',
    ].join('\n');

    const result = parsePatch(patch);
    expect(result.isRename).toBe(false);
    expect(result.hunks).toHaveLength(1);
    const hunk = firstHunk(result.hunks);
    expect(hunk.oldStart).toBe(0);
    expect(hunk.oldLines).toBe(0);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(1);
    expect(hunk.lines).toEqual([
      {
        type: 'add',
        newLine: 1,
        text: 'export const hello = "world";',
        noNewlineAtEndOfFile: false,
      },
    ]);
  });

  it('parses a pure deletion with context', () => {
    const patch = [
      'diff --git a/hello.ts b/hello.ts',
      '@@ -1,3 +1,1 @@',
      ' import { foo } from "./foo";',
      '-import { bar } from "./bar";',
      '-import { baz } from "./baz";',
      ' export const x = foo();',
    ].join('\n');

    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(1);
    const hunk = firstHunk(result.hunks);
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(1);
    expect(hunk.lines).toEqual([
      {
        type: 'context',
        oldLine: 1,
        newLine: 1,
        text: 'import { foo } from "./foo";',
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'del',
        oldLine: 2,
        text: 'import { bar } from "./bar";',
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'del',
        oldLine: 3,
        text: 'import { baz } from "./baz";',
        noNewlineAtEndOfFile: false,
      },
      {
        type: 'context',
        oldLine: 4,
        newLine: 2,
        text: 'export const x = foo();',
        noNewlineAtEndOfFile: false,
      },
    ]);
  });

  it('parses a multi-hunk patch with correct line counters per hunk', () => {
    const patch = [
      'diff --git a/file.ts b/file.ts',
      '@@ -1,2 +1,2 @@',
      ' line one',
      '-old line two',
      '+new line two',
      ' line three',
      '@@ -10,3 +10,4 @@',
      ' line ten',
      '+inserted after ten',
      ' line eleven',
      ' line twelve',
    ].join('\n');

    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(2);

    const first = firstHunk(result.hunks);
    expect(first.oldStart).toBe(1);
    expect(first.newStart).toBe(1);
    expect(first.lines.map(l => l.type)).toEqual(['context', 'del', 'add', 'context']);
    expect(first.lines.map(l => l.oldLine)).toEqual([1, 2, undefined, 3]);
    expect(first.lines.map(l => l.newLine)).toEqual([1, undefined, 2, 3]);

    const second = nthHunk(result.hunks, 1);
    expect(second.oldStart).toBe(10);
    expect(second.newStart).toBe(10);
    expect(second.lines.map(l => l.type)).toEqual(['context', 'add', 'context', 'context']);
    expect(second.lines[1]?.newLine).toBe(11);
  });

  it('attaches the no-newline marker to the immediately preceding add/del line', () => {
    // GitHub emits the `\ No newline at end of file` marker as a
    // separate line directly after the line it qualifies — it never
    // appears between two add/del lines. So the marker is attached to
    // the most recent add/del, not to both halves of a -/+ pair.
    const patch = [
      'diff --git a/single.txt b/single.txt',
      '@@ -1,1 +1,1 @@',
      '-old content',
      '+new content',
      String.raw`\ No newline at end of file`,
    ].join('\n');

    const result = parsePatch(patch);
    const lines = firstHunk(result.hunks).lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'del', noNewlineAtEndOfFile: false });
    expect(lines[1]).toMatchObject({ type: 'add', noNewlineAtEndOfFile: true });
  });

  it('attaches the no-newline marker to a del when the del is the last non-context line', () => {
    const patch = [
      'diff --git a/single.txt b/single.txt',
      '@@ -1,2 +0,0 @@',
      '-removed line',
      String.raw`\ No newline at end of file`,
    ].join('\n');

    const result = parsePatch(patch);
    const lines = firstHunk(result.hunks).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'del', noNewlineAtEndOfFile: true });
  });

  it('does not emit the no-newline marker as its own line', () => {
    const patch = [
      'diff --git a/single.txt b/single.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      String.raw`\ No newline at end of file`,
      ' context',
    ].join('\n');

    const result = parsePatch(patch);
    const lines = firstHunk(result.hunks).lines;
    // 2 non-context lines + 1 context line = 3 total. The marker is
    // attached to the preceding add, not counted as its own row.
    expect(lines).toHaveLength(3);
    expect(lines[0]?.type).toBe('del');
    expect(lines[1]?.type).toBe('add');
    expect(lines[1]?.noNewlineAtEndOfFile).toBe(true);
    expect(lines[2]?.type).toBe('context');
  });

  it('parses a renamed file and exposes previousPath', () => {
    const patch = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 95%',
      'rename from old-name.ts',
      'rename to new-name.ts',
      '@@ -1,1 +1,1 @@',
      '-export const a = 1;',
      '+export const a = 2;',
    ].join('\n');

    const result = parsePatch(patch);
    expect(result.isRename).toBe(true);
    expect(result.previousPath).toBe('old-name.ts');
    expect(result.hunks).toHaveLength(1);
    expect(firstHunk(result.hunks).lines).toHaveLength(2);
  });

  it('handles headers without explicit line counts (defaults to 1)', () => {
    const patch = ['diff --git a/short.txt b/short.txt', '@@ -1 +1 @@', '-old', '+new'].join('\n');

    const result = parsePatch(patch);
    const hunk = firstHunk(result.hunks);
    expect(hunk.oldLines).toBe(1);
    expect(hunk.newLines).toBe(1);
  });

  it('preserves a hunk header section heading (e.g. function name) in the header text', () => {
    const patch = [
      'diff --git a/file.ts b/file.ts',
      '@@ -1,1 +1,1 @@ def greet():',
      '-print("hi")',
      '+print("hello")',
    ].join('\n');

    const result = parsePatch(patch);
    expect(firstHunk(result.hunks).header).toBe('@@ -1,1 +1,1 @@ def greet():');
  });

  it('attaches the no-newline marker to the immediately-preceding context line', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '@@ -1,2 +1,2 @@',
      '-old last line',
      '+new last line',
      ' trailing context',
      String.raw`\ No newline at end of file`,
    ].join('\n');

    const lines = firstHunk(parsePatch(patch).hunks).lines;
    const contextLine = lines.find(l => l.text === 'trailing context');
    const addLine = lines.find(l => l.text === 'new last line');
    // The marker qualifies the context line it directly follows, NOT the
    // earlier add/del line.
    expect(contextLine?.noNewlineAtEndOfFile).toBe(true);
    expect(addLine?.noNewlineAtEndOfFile).toBe(false);
  });

  it('normalizes CRLF line endings and still matches the no-newline marker', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      String.raw`\ No newline at end of file`,
    ].join('\r\n');

    const lines = firstHunk(parsePatch(patch).hunks).lines;
    const addLine = lines.find(l => l.type === 'add');
    // No stray \r leaked into the rendered content, and the marker matched.
    expect(addLine?.text).toBe('new');
    expect(addLine?.noNewlineAtEndOfFile).toBe(true);
  });

  it('returns an empty hunks array for a malformed hunk header', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '@@ this is not a real header @@',
      '-whatever',
      '+whatever',
    ].join('\n');

    const result = parsePatch(patch);
    // The parser bails out of the rest of the patch on a malformed
    // header; the caller still has the file metadata from the DTO so
    // it can render "Open on GitHub" as a fallback.
    expect(result.hunks).toEqual([]);
  });
});
