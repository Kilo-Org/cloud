// Pure unified-diff parser for GitHub's `file.patch` strings.
//
// GitHub emits a single `diff --git a/<path> b/<path>` block per file
// followed by one or more `@@ -oldStart,oldLines +newStart,newLines @@`
// hunks. Each hunk body is a sequence of lines starting with ' '
// (context), '+' (add), or '-' (del). A trailing `\ No newline at end of
// file` marker belongs to the previous add/del line and must not become
// its own diff line — that marker means "the previous line had no
// terminating newline" and is purely metadata, not diff content.
//
// Renamed files appear with a `rename from <old>` / `rename to <new>`
// header in addition to the `diff --git` line. We expose those via
// `isRename` + `previousPath` on the parsed file result so the UI can
// render an "old → new" header. The actual diff body for a rename is
// still a normal unified diff against the new path, so `hunks` does not
// need any special treatment.
//
// Outputs are plain data — no React, no React Native, no lowlight —
// so this module is testable in plain Node and reusable by any future
// non-mobile surface (web, CLI, etc.).

export type DiffLineType = 'context' | 'add' | 'del';

export type ParsedDiffLine = {
  type: DiffLineType;
  /** 1-indexed line number in the old file. Undefined for `add` lines. */
  oldLine?: number;
  /** 1-indexed line number in the new file. Undefined for `del` lines. */
  newLine?: number;
  /** The line content, without the leading +/-/space marker. */
  text: string;
  /**
   * The previous line had no terminating newline. Carried as a flag
   * rather than its own line so the caller can render it once and the
   * total line count matches the row count the user sees.
   */
  noNewlineAtEndOfFile: boolean;
};

export type ParsedHunk = {
  /** The raw `@@ -a,b +c,d @@` header line, minus the trailing section heading. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ParsedDiffLine[];
};

export type ParsedPatch = {
  isRename: boolean;
  previousPath?: string;
  hunks: ParsedHunk[];
};

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const NO_NEWLINE_MARKER = String.raw`\ No newline at end of file`;
// `git apply` accepts " " / "+" / "-" / "\" as line-type markers.
const LINE_MARKERS = new Set([' ', '+', '-', '\\']);

type ParseState = {
  isRename: boolean;
  previousPath: string | undefined;
  hunks: ParsedHunk[];
  currentHunk: ParsedHunk | null;
  oldLineNo: number;
  newLineNo: number;
  /** Index of the immediately-preceding parsed body line (any type). */
  lastLineIndex: number;
  abort: boolean;
};

function processDiffGitLine(state: ParseState): void {
  // Starting a new file — flush any open hunk defensively even
  // though GitHub's output is well-formed and never has two diff
  // blocks in a single patch string.
  if (state.currentHunk) {
    state.hunks.push(state.currentHunk);
    state.currentHunk = null;
  }
}

function processRenameFrom(state: ParseState, line: string): void {
  state.isRename = true;
  state.previousPath = line.slice('rename from '.length);
}

function processHunkHeader(state: ParseState, line: string): void {
  if (state.currentHunk) {
    state.hunks.push(state.currentHunk);
  }
  const match = HUNK_HEADER_RE.exec(line);
  if (!match) {
    // Unparseable hunk header — bail out of the rest of this
    // patch. The file DTO still has its path / status / counts
    // so the user can read the file via "Open on GitHub".
    state.currentHunk = null;
    state.abort = true;
    return;
  }
  const oldStart = Number(match[1]);
  const oldLines = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newLines = match[4] === undefined ? 1 : Number(match[4]);
  state.currentHunk = {
    header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${match[5] ?? ''}`,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines: [],
  };
  state.oldLineNo = oldStart;
  state.newLineNo = newStart;
  state.lastLineIndex = -1;
}

function attachNoNewlineMarker(state: ParseState): void {
  if (!state.currentHunk || state.lastLineIndex < 0) {
    return;
  }
  const previous = state.currentHunk.lines[state.lastLineIndex];
  if (!previous) {
    return;
  }
  state.currentHunk.lines[state.lastLineIndex] = {
    type: previous.type,
    ...(previous.oldLine !== undefined ? { oldLine: previous.oldLine } : {}),
    ...(previous.newLine !== undefined ? { newLine: previous.newLine } : {}),
    text: previous.text,
    noNewlineAtEndOfFile: true,
  };
}

function processBodyLine(state: ParseState, line: string): void {
  if (!state.currentHunk) {
    // Diff metadata lines (index, ---, +++, similarity, etc.) are
    // skipped — we only emit actual hunk bodies.
    return;
  }
  if (line === NO_NEWLINE_MARKER) {
    attachNoNewlineMarker(state);
    return;
  }
  const marker = line[0];
  if (!marker || !LINE_MARKERS.has(marker) || marker === '\\') {
    // Empty / unrecognized line inside a hunk body — skip rather
    // than treat as a malformed context line. The leading '\' case
    // for non-marker no-newline lines is already handled above.
    return;
  }
  const text = line.slice(1);
  if (marker === ' ') {
    state.currentHunk.lines.push({
      type: 'context',
      oldLine: state.oldLineNo,
      newLine: state.newLineNo,
      text,
      noNewlineAtEndOfFile: false,
    });
    state.oldLineNo += 1;
    state.newLineNo += 1;
    state.lastLineIndex = state.currentHunk.lines.length - 1;
    return;
  }
  if (marker === '+') {
    state.currentHunk.lines.push({
      type: 'add',
      newLine: state.newLineNo,
      text,
      noNewlineAtEndOfFile: false,
    });
    state.newLineNo += 1;
    state.lastLineIndex = state.currentHunk.lines.length - 1;
    return;
  }
  // marker === '-'
  state.currentHunk.lines.push({
    type: 'del',
    oldLine: state.oldLineNo,
    text,
    noNewlineAtEndOfFile: false,
  });
  state.oldLineNo += 1;
  state.lastLineIndex = state.currentHunk.lines.length - 1;
}

function processLine(state: ParseState, line: string): void {
  if (line.startsWith('diff --git ')) {
    processDiffGitLine(state);
    return;
  }
  if (line.startsWith('rename from ')) {
    processRenameFrom(state, line);
    return;
  }
  if (line.startsWith('rename to ')) {
    // The `rename to` path is the same as the new file path (already
    // available in the file DTO), so we don't re-parse it here.
    return;
  }
  if (line.startsWith('@@')) {
    processHunkHeader(state, line);
    return;
  }
  processBodyLine(state, line);
}

export function parsePatch(patch: string | null | undefined): ParsedPatch {
  if (!patch) {
    return { isRename: false, hunks: [] };
  }

  // Normalize line endings — GitHub's API returns \n, but splitting on
  // \r?\n keeps the parser robust against a proxy that returns CRLF and
  // ensures the `\ No newline at end of file` marker matches exactly
  // (a stray \r would otherwise leak into rendered content and break the
  // marker match).
  const rawLines = patch.split(/\r?\n/);

  const state: ParseState = {
    isRename: false,
    previousPath: undefined,
    hunks: [],
    currentHunk: null,
    oldLineNo: 0,
    newLineNo: 0,
    lastLineIndex: -1,
    abort: false,
  };

  for (const line of rawLines) {
    if (state.abort) {
      break;
    }
    processLine(state, line);
  }

  if (state.currentHunk) {
    state.hunks.push(state.currentHunk);
  }

  return {
    isRename: state.isRename,
    ...(state.previousPath ? { previousPath: state.previousPath } : {}),
    hunks: state.hunks,
  };
}
