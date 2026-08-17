// Pure model that converts an `apply_patch` (or `patch`) tool input into
// per-file diff rows for the patch preview.
//
// The envelope grammar mirrors the CLI binary's parser exactly:
// - Lines split on `\n`. `*** Begin Patch` / `*** End Patch` match after
//   `.trim()`; both must exist, Begin before End. Lines outside the markers
//   are ignored.
// - `*** Add File: <path>` — following lines must each start with `+`;
//   content ends at the next line starting with `***`.
// - `*** Delete File: <path>` — no body.
// - `*** Update File: <path>` — optional following `*** Move to: <path>` line
//   (the move path must be non-empty), then one or more `@@` chunks. Chunk
//   body lines: ` ` = context, `-` = removed, `+` = added. `*** End of File`
//   ends the chunk; the next line must start `@@` or `***`. Any other line
//   fails the parse.
// - A file op with an invalid line, or an update with zero chunks, fails the
//   whole parse.
//
// CRLF input is normalized to `\n` before parsing so content lines never
// carry a stray `\r` (the binary itself does not normalize; the plan
// requires CRLF patches to parse cleanly).
//
// No line numbers exist in the envelope; context/del/add rows are numbered
// with per-file old/new counters starting at 1. `@@` context text and
// `*** Move to:` are ignored for display.
//
// Caps are applied DURING parsing, not after, so a very large valid patch
// never allocates unbounded rows: the full envelope is always scanned and
// every line validated (a grammar violation anywhere, including past the
// caps, fails the parse), but rows are only allocated up to what survives —
// at most `PATCH_FILE_CAP` files are retained, each file's rows are bounded
// by `PATCH_FILE_LINE_CAP`, and `PATCH_TOTAL_LINE_CAP` is an exact overall
// bound (a file crossing the remaining budget is partially retained, later
// files are validated then dropped). A delete file contributes 0 lines but
// counts toward the file cap. An add file with zero content lines is valid.
//
// `truncated` is true only when a row or file was actually dropped or
// sliced: a model whose retained lines end exactly at the total cap with no
// drop stays untruncated.
//
// Any grammar violation, zero parsed files, or an update with zero chunks
// returns null so the caller falls back to the generic body. The patch label
// uses `listPatchFilePaths`, a cheap header scan, instead of this parser.

import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { type ParsedDiffLine } from '@/lib/pr-review/diff/parse-patch';
import { languageForPath } from '@/lib/pr-review/diff/highlight';

const PATCH_FILE_CAP = 50;
const PATCH_FILE_LINE_CAP = 500;
const PATCH_TOTAL_LINE_CAP = 2000;

const PATCH_FILE_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/** First-character → row type for a chunk body line. */
const CHUNK_LINE_TYPE: Record<string, ParsedDiffLine['type']> = {
  ' ': 'context',
  '-': 'del',
  '+': 'add',
};

export type ToolPatchFile = {
  path: string;
  operation: 'add' | 'update' | 'delete';
  lines: readonly ParsedDiffLine[];
  /** File-extension language for syntax highlighting. null = plain text. */
  language: string | null;
};

export type ToolPatchModel = { files: ToolPatchFile[]; truncated: boolean };

/**
 * Header scan for the transcript row label. Requires the Begin/End envelope
 * (else `[]`), then lists every `*** <Op> File:` path inside the envelope in
 * order; headers outside the envelope are ignored. This is a label authority
 * only — it never parses chunk grammar, so a patch with recognizable headers
 * and a corrupt chunk still names its files.
 */
export function listPatchFilePaths(patchText: string): string[] {
  const normalized = patchText.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');

  let beginIndex = -1;
  let endIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '*** Begin Patch') {
      beginIndex = i;
      break;
    }
  }
  if (beginIndex !== -1) {
    for (let i = beginIndex + 1; i < lines.length; i += 1) {
      if (lines[i]?.trim() === '*** End Patch') {
        endIndex = i;
        break;
      }
    }
  }
  if (beginIndex === -1 || endIndex === -1) {
    return [];
  }

  const paths: string[] = [];
  const envelope = lines.slice(beginIndex + 1, endIndex).join('\n');
  for (const match of envelope.matchAll(PATCH_FILE_HEADER_RE)) {
    const path = match[1]?.trim() ?? '';
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Convert an `apply_patch` or `patch` tool part into a diff model.
 * Returns null when the tool is neither patch name, `patchText` is absent or
 * empty, the patch does not parse, or the patch carries no files.
 */
export function buildToolPatchModel(part: ToolPart): ToolPatchModel | null {
  if (part.tool !== 'patch' && part.tool !== 'apply_patch') {
    return null;
  }
  const patchText =
    typeof part.state.input.patchText === 'string' ? part.state.input.patchText : '';
  if (!patchText) {
    return null;
  }

  const model = parsePatchText(patchText);
  if (!model || model.files.length === 0) {
    return null;
  }

  return model;
}

/**
 * Parse the full envelope into the capped preview model. The parser mirrors
 * the binary's file-op loop and chunk state machine; CRLF is normalized
 * first. Every line is scanned and validated regardless of the caps, but row
 * objects are allocated only up to what the caps retain: at most
 * `PATCH_TOTAL_LINE_CAP` rows survive across all retained files, with at most
 * `PATCH_FILE_LINE_CAP` held in flight for the file being parsed, so a huge
 * valid patch cannot grow the row set unboundedly. Returns null on any
 * grammar violation.
 */
function parsePatchText(patchText: string): ToolPatchModel | null {
  const lines = patchText.replaceAll('\r\n', '\n').split('\n');
  const begin = lines.findIndex(line => line.trim() === '*** Begin Patch');
  const end = lines.findIndex(line => line.trim() === '*** End Patch');
  if (begin === -1 || end === -1 || begin >= end) {
    return null;
  }

  const files: ToolPatchFile[] = [];
  let truncated = false;
  let totalLines = 0;
  let index = begin + 1;

  while (index < end) {
    const line = lines[index] ?? '';
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      if (!path) {
        return null;
      }
      index += 1;
      const maxRows = retentionCap(files.length, totalLines);
      if (maxRows === 0) {
        truncated = true;
      }
      const rows: ParsedDiffLine[] = [];
      while (index < lines.length && !lines[index]?.startsWith('***')) {
        const content = lines[index] ?? '';
        if (!content.startsWith('+')) {
          return null;
        }
        if (rows.length < maxRows) {
          rows.push({
            type: 'add',
            newLine: rows.length + 1,
            text: content.slice(1),
            noNewlineAtEndOfFile: false,
          });
        } else {
          truncated = true;
        }
        index += 1;
      }
      retainFile(files, maxRows, { path, operation: 'add', lines: rows });
      totalLines += rows.length;
    } else if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      if (!path) {
        return null;
      }
      index += 1;
      const maxRows = retentionCap(files.length, totalLines);
      if (maxRows === 0) {
        truncated = true;
      }
      retainFile(files, maxRows, { path, operation: 'delete', lines: [] });
    } else if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      if (!path) {
        return null;
      }
      index += 1;
      const moveTo = lines[index];
      if (moveTo?.startsWith('*** Move to:')) {
        const movePath = moveTo.slice('*** Move to:'.length).trim();
        if (!movePath) {
          return null;
        }
        index += 1;
      }
      const maxRows = retentionCap(files.length, totalLines);
      if (maxRows === 0) {
        truncated = true;
      }
      const parsed = parseUpdateChunks(lines, index, maxRows);
      if (!parsed || parsed.chunks === 0) {
        return null;
      }
      if (parsed.dropped) {
        truncated = true;
      }
      retainFile(files, maxRows, { path, operation: 'update', lines: parsed.lines });
      totalLines += parsed.lines.length;
      index = parsed.next;
    } else {
      return null;
    }
  }

  return { files, truncated };
}

/**
 * How many rows the next file may retain. 0 means the file is past a cap:
 * its body is still validated, but the file is dropped from the model.
 */
function retentionCap(fileCount: number, totalLines: number): number {
  if (fileCount >= PATCH_FILE_CAP) {
    return 0;
  }
  const remaining = PATCH_TOTAL_LINE_CAP - totalLines;
  if (remaining <= 0) {
    return 0;
  }
  return Math.min(PATCH_FILE_LINE_CAP, remaining);
}

/** Append the file when it survived the caps (`maxRows > 0`). */
function retainFile(
  files: ToolPatchFile[],
  maxRows: number,
  file: { path: string; operation: ToolPatchFile['operation']; lines: readonly ParsedDiffLine[] }
): void {
  if (maxRows <= 0) {
    return;
  }
  files.push({
    path: file.path,
    operation: file.operation,
    lines: file.lines,
    language: languageForPath(file.path),
  });
}

/**
 * Parse every `@@` chunk of an update file into numbered diff rows, retaining
 * at most `maxRows` of them. Returns null on a grammar violation. The chunk
 * state machine mirrors the binary's `_ch`: `*** End of File` ends the chunk,
 * `***` ends the op, `@@` starts the next chunk, ` `/`-`/`+` are content, and
 * anything else fails. Rows past `maxRows` are counted but not allocated
 * (`dropped` reports the overflow so the caller can flag truncation).
 */
function parseUpdateChunks(
  lines: readonly string[],
  start: number,
  maxRows: number
): { lines: ParsedDiffLine[]; chunks: number; next: number; dropped: boolean } | null {
  const rows: ParsedDiffLine[] = [];
  let index = start;
  let chunks = 0;
  let oldLineNo = 1;
  let newLineNo = 1;
  let dropped = false;

  while (index < lines.length && !lines[index]?.startsWith('***')) {
    if (!lines[index]?.startsWith('@@')) {
      return null;
    }
    chunks += 1;
    index += 1;
    while (index < lines.length && !lines[index]?.startsWith('@@')) {
      const chunkLine = lines[index] ?? '';
      if (chunkLine === '*** End of File') {
        index += 1;
        break;
      }
      if (chunkLine.startsWith('***')) {
        break;
      }
      const type = CHUNK_LINE_TYPE[chunkLine[0] ?? ''];
      if (!type) {
        return null;
      }
      if (rows.length < maxRows) {
        const row: ParsedDiffLine = {
          type,
          text: chunkLine.slice(1),
          noNewlineAtEndOfFile: false,
        };
        if (type === 'context') {
          row.oldLine = oldLineNo;
          row.newLine = newLineNo;
        } else if (type === 'del') {
          row.oldLine = oldLineNo;
        } else {
          row.newLine = newLineNo;
        }
        rows.push(row);
      } else {
        dropped = true;
      }
      if (type === 'context') {
        oldLineNo += 1;
        newLineNo += 1;
      } else if (type === 'del') {
        oldLineNo += 1;
      } else {
        newLineNo += 1;
      }
      index += 1;
    }
  }

  return { lines: rows, chunks, next: index, dropped };
}
