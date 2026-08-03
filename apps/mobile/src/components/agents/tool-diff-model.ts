// Pure model that converts edit and write tool inputs into
// `ParsedDiffLine` rows for the shared tool diff preview.
//
// Edit: builds deleted rows from `oldString` and added rows from
// `newString`, numbered independently from one.
// Write: builds added rows from `content`, numbered from one.
//
// Character and line caps bound output size. The model is null when
// the input is absent, invalid, or carries no diff content.
//
// Reuses the existing `ParsedDiffLine` type and `languageForPath` from
// the pull request diff surface. Does not use `parsePatch` because the
// tool inputs are not unified patches.

import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { type ParsedDiffLine } from '@/lib/pr-review/diff/parse-patch';
import { languageForPath } from '@/lib/pr-review/diff/highlight';

const EDIT_CHARACTER_CAP = 1000;
const EDIT_LINE_CAP = 100;
const WRITE_CHARACTER_CAP = 2000;
const WRITE_LINE_CAP = 200;

export type ToolDiffModel = {
  lines: readonly ParsedDiffLine[];
  filePath: string;
  /** File-extension language for syntax highlighting. null = plain text. */
  language: string | null;
  truncated: boolean;
  tool: string;
};

/**
 * Convert an edit or write tool part into a diff model.
 * Returns null when the tool is neither edit nor write, the input is
 * absent or invalid, or the diff content is empty.
 */
export function buildToolDiffModel(part: ToolPart): ToolDiffModel | null {
  const tool = part.tool;
  const input = part.state.input as Record<string, unknown>;

  if (tool === 'edit') {
    const filePath = typeof input.filePath === 'string' ? input.filePath : '';
    const oldString = typeof input.oldString === 'string' ? input.oldString : '';
    const newString = typeof input.newString === 'string' ? input.newString : '';

    const slicedOld = oldString.slice(0, EDIT_CHARACTER_CAP);
    const slicedNew = newString.slice(0, EDIT_CHARACTER_CAP);

    const delLines = oldString ? splitTrimTrailingEmpty(slicedOld) : [];
    const addLines = newString ? splitTrimTrailingEmpty(slicedNew) : [];

    if (delLines.length === 0 && addLines.length === 0) {
      return null;
    }

    const oldCapHit = oldString.length > EDIT_CHARACTER_CAP;
    const newCapHit = newString.length > EDIT_CHARACTER_CAP;
    const truncated =
      oldCapHit || newCapHit || delLines.length > EDIT_LINE_CAP || addLines.length > EDIT_LINE_CAP;

    const cappedDel = delLines.slice(0, EDIT_LINE_CAP);
    const cappedAdd = addLines.slice(0, EDIT_LINE_CAP);

    const lines: ParsedDiffLine[] = [
      ...cappedDel.map(
        (text, i): ParsedDiffLine => ({
          type: 'del',
          oldLine: i + 1,
          text,
          noNewlineAtEndOfFile: false,
        })
      ),
      ...cappedAdd.map(
        (text, i): ParsedDiffLine => ({
          type: 'add',
          newLine: i + 1,
          text,
          noNewlineAtEndOfFile: false,
        })
      ),
    ];

    return {
      lines,
      filePath,
      language: languageForPath(filePath),
      truncated,
      tool,
    };
  }

  if (tool === 'write') {
    const filePath = typeof input.filePath === 'string' ? input.filePath : '';
    const content = typeof input.content === 'string' ? input.content : '';

    if (!content) {
      return null;
    }

    const sliced = content.slice(0, WRITE_CHARACTER_CAP);
    const textLines = splitTrimTrailingEmpty(sliced);

    if (textLines.length === 0) {
      return null;
    }

    const truncated = content.length > WRITE_CHARACTER_CAP || textLines.length > WRITE_LINE_CAP;

    const cappedLines = textLines.slice(0, WRITE_LINE_CAP);

    const lines: ParsedDiffLine[] = cappedLines.map(
      (text, i): ParsedDiffLine => ({
        type: 'add',
        newLine: i + 1,
        text,
        noNewlineAtEndOfFile: false,
      })
    );

    return {
      lines,
      filePath,
      language: languageForPath(filePath),
      truncated,
      tool,
    };
  }

  return null;
}

/**
 * Split text on newlines. Drop a single trailing empty string produced
 * when the input ends with a newline because it is not a content line.
 */
function splitTrimTrailingEmpty(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 1 && parts.at(-1) === '') {
    parts.pop();
  }
  return parts;
}
