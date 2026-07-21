import { describe, expect, it } from 'vitest';

import { type ParsedHunk, parsePatch } from '@/lib/pr-review/diff/parse-patch';
import { buildSideBySideRows, type SideBySideRow } from '@/lib/pr-review/diff/side-by-side';

function firstHunk(patch: string): ParsedHunk {
  const result = parsePatch(patch);
  const hunk = result.hunks[0];
  if (!hunk) {
    throw new Error('expected at least one hunk');
  }
  return hunk;
}

function typesOf(rows: SideBySideRow[]): string[] {
  return rows.map(row => {
    if (row.left && row.right) {
      if (row.left.line === row.right.line) {
        return 'context';
      }
      return 'replace';
    }
    if (row.left) {
      return 'del';
    }
    if (row.right) {
      return 'add';
    }
    return 'empty';
  });
}

describe('buildSideBySideRows', () => {
  it('pairs a one-line replacement: -a / +b', () => {
    const patch = ['diff --git a/foo.ts b/foo.ts', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n');
    const rows = buildSideBySideRows(firstHunk(patch));
    expect(typesOf(rows)).toEqual(['replace']);
    expect(rows[0]?.left?.line.text).toBe('old');
    expect(rows[0]?.left?.line.type).toBe('del');
    expect(rows[0]?.right?.line.text).toBe('new');
    expect(rows[0]?.right?.line.type).toBe('add');
  });

  it('pairs a multi-line replacement: -a -b / +c +d', () => {
    const patch = ['diff --git a/foo.ts b/foo.ts', '@@ -1,2 +1,2 @@', '-a', '-b', '+c', '+d'].join(
      '\n'
    );
    const rows = buildSideBySideRows(firstHunk(patch));
    expect(typesOf(rows)).toEqual(['replace', 'replace']);
    expect(rows.map(r => r.left?.line.text)).toEqual(['a', 'b']);
    expect(rows.map(r => r.right?.line.text)).toEqual(['c', 'd']);
  });

  it('pairs an uneven replacement: -a -b -c / +x, leaving b and c as left-only', () => {
    const patch = ['diff --git a/foo.ts b/foo.ts', '@@ -1,3 +1,1 @@', '-a', '-b', '-c', '+x'].join(
      '\n'
    );
    const rows = buildSideBySideRows(firstHunk(patch));
    expect(typesOf(rows)).toEqual(['replace', 'del', 'del']);
    expect(rows[0]?.left?.line.text).toBe('a');
    expect(rows[0]?.right?.line.text).toBe('x');
    expect(rows[1]?.left?.line.text).toBe('b');
    expect(rows[1]?.right).toBeNull();
    expect(rows[2]?.left?.line.text).toBe('c');
    expect(rows[2]?.right).toBeNull();
  });

  it('pairs an uneven replacement: -a / +x +y +z, leaving y and z as right-only', () => {
    const patch = ['diff --git a/foo.ts b/foo.ts', '@@ -1,1 +1,3 @@', '-a', '+x', '+y', '+z'].join(
      '\n'
    );
    const rows = buildSideBySideRows(firstHunk(patch));
    expect(typesOf(rows)).toEqual(['replace', 'add', 'add']);
    expect(rows[0]?.left?.line.text).toBe('a');
    expect(rows[0]?.right?.line.text).toBe('x');
    expect(rows[1]?.left).toBeNull();
    expect(rows[1]?.right?.line.text).toBe('y');
    expect(rows[2]?.left).toBeNull();
    expect(rows[2]?.right?.line.text).toBe('z');
  });

  it('renders a pure-add line as right-only (left null)', () => {
    const patch = ['diff --git a/foo.ts b/foo.ts', '@@ -0,0 +1,1 @@', '+new'].join('\n');
    const rows = buildSideBySideRows(firstHunk(patch));
    expect(typesOf(rows)).toEqual(['add']);
    expect(rows[0]?.left).toBeNull();
    expect(rows[0]?.right?.line.text).toBe('new');
  });

  it('renders a pure-del line as left-only (right null)', () => {
    const patch = ['diff --git a/foo.ts b/foo.ts', '@@ -1,1 +0,0 @@', '-gone'].join('\n');
    const rows = buildSideBySideRows(firstHunk(patch));
    expect(typesOf(rows)).toEqual(['del']);
    expect(rows[0]?.left?.line.text).toBe('gone');
    expect(rows[0]?.right).toBeNull();
  });

  it('renders context on both sides and does not pair it with del/add', () => {
    const patch = [
      'diff --git a/foo.ts b/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' ctx',
      '-a',
      '+b',
      ' end',
    ].join('\n');
    const rows = buildSideBySideRows(firstHunk(patch));
    expect(typesOf(rows)).toEqual(['context', 'replace', 'context']);
    expect(rows[0]?.left?.line.text).toBe('ctx');
    expect(rows[0]?.right?.line.text).toBe('ctx');
    expect(rows[2]?.left?.line.text).toBe('end');
    expect(rows[2]?.right?.line.text).toBe('end');
  });

  it('keeps context as a single row shared by both columns (same reference)', () => {
    const patch = ['diff --git a/foo.ts b/foo.ts', '@@ -1,1 +1,1 @@', ' same'].join('\n');
    const rows = buildSideBySideRows(firstHunk(patch));
    expect(typesOf(rows)).toEqual(['context']);
    expect(rows[0]?.left?.line).toBe(rows[0]?.right?.line);
  });

  it('keeps leftover lines after a del/add run as separate rows (no fusion with later context)', () => {
    const patch = [
      'diff --git a/foo.ts b/foo.ts',
      '@@ -1,3 +1,3 @@',
      '-a',
      '+b',
      '-c',
      ' end',
    ].join('\n');
    const rows = buildSideBySideRows(firstHunk(patch));
    expect(typesOf(rows)).toEqual(['replace', 'del', 'context']);
    expect(rows[1]?.left?.line.text).toBe('c');
    expect(rows[1]?.right).toBeNull();
    expect(rows[2]?.left?.line.text).toBe('end');
    expect(rows[2]?.right?.line.text).toBe('end');
  });
});
