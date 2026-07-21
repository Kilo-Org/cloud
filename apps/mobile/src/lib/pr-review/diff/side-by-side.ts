// Side-by-side rendering helper for the tablet PR diff viewer.
//
// A side-by-side view splits each parsed hunk into two columns:
//   - LEFT: old (context) + deleted lines, with their old line numbers
//   - RIGHT: new (context) + added lines, with their new line numbers
//
// A "replacement" hunk is a contiguous run of `-…` lines followed by
// `+…` lines (in any combination of counts). Each pair of one del + one
// add becomes a single row with both columns populated. Leftover dels
// become left-only rows; leftover adds become right-only rows. Context
// lines (which appear with both old and new line numbers) become rows
// with both columns set to the same text. The result is a fixed grid
// of equal-height rows the FlashList can virtualize without measuring.
//
// This module is pure data — no React, no React Native — so it is
// testable in plain Node and reusable by any future non-mobile surface
// (web, CLI). The visual rendering of these rows lives in
// `pr-diff-side-by-side-row.tsx` so this file stays under the max-lines
// limit.

import { type ParsedDiffLine, type ParsedHunk } from '@/lib/pr-review/diff/parse-patch';

export type SideBySideCell = {
  line: ParsedDiffLine;
};

export type SideBySideRow = {
  left: SideBySideCell | null;
  right: SideBySideCell | null;
};

function pushReplacementPair(
  rows: SideBySideRow[],
  del: ParsedDiffLine,
  add: ParsedDiffLine
): void {
  rows.push({ left: { line: del }, right: { line: add } });
}

function pushLeftOnly(rows: SideBySideRow[], del: ParsedDiffLine): void {
  rows.push({ left: { line: del }, right: null });
}

function pushRightOnly(rows: SideBySideRow[], add: ParsedDiffLine): void {
  rows.push({ left: null, right: { line: add } });
}

function pushContextPair(rows: SideBySideRow[], context: ParsedDiffLine): void {
  rows.push({ left: { line: context }, right: { line: context } });
}

function flushRun(rows: SideBySideRow[], dels: ParsedDiffLine[], adds: ParsedDiffLine[]): void {
  const pairs = Math.min(dels.length, adds.length);
  for (let i = 0; i < pairs; i += 1) {
    const del = dels[i];
    const add = adds[i];
    if (!del || !add) {
      break;
    }
    pushReplacementPair(rows, del, add);
  }
  for (let i = pairs; i < dels.length; i += 1) {
    const del = dels[i];
    if (!del) {
      break;
    }
    pushLeftOnly(rows, del);
  }
  for (let i = pairs; i < adds.length; i += 1) {
    const add = adds[i];
    if (!add) {
      break;
    }
    pushRightOnly(rows, add);
  }
}

export function buildSideBySideRows(hunk: ParsedHunk): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let dels: ParsedDiffLine[] = [];
  let adds: ParsedDiffLine[] = [];

  const flush = () => {
    if (dels.length > 0 || adds.length > 0) {
      flushRun(rows, dels, adds);
      dels = [];
      adds = [];
    }
  };

  for (const line of hunk.lines) {
    if (line.type === 'context') {
      flush();
      pushContextPair(rows, line);
    } else if (line.type === 'del') {
      dels.push(line);
    } else {
      adds.push(line);
    }
  }
  flush();

  return rows;
}
