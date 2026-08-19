// Pure model that converts edit tool inputs into
// `ParsedDiffLine` rows for the shared tool diff preview.
//
// Edit: builds deleted rows from `oldString` and added rows from
// `newString`, numbered independently from one.
//
// Character and line caps bound output size. The model is null when
// the input is absent, invalid, or carries no diff content.
//
// Reuses the existing `ParsedDiffLine` type and `languageForPath` from
// the pull request diff surface. Does not use `parsePatch` because the
// tool inputs are not unified patches.

import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';
import { type ParsedDiffLine } from '@/lib/pr-review/diff/parse-patch';
import { languageForPath } from '@/lib/pr-review/diff/highlight';

/** Zod's validation `.catch()` fallback, not a Promise catch. */
function tolerant<T>(schema: z.ZodType<T>, fallback: T): z.ZodType<T> {
  // oxlint-disable-next-line promise/prefer-await-to-then -- zod schema fallback, not a Promise
  return schema.catch(fallback);
}

const editToolInputSchema = tolerant(
  z.object({
    filePath: tolerant(z.string(), ''),
    oldString: tolerant(z.string(), ''),
    newString: tolerant(z.string(), ''),
  }),
  { filePath: '', oldString: '', newString: '' }
);

// Sized for the scrolling detail sheet: an order of magnitude above the old
// transcript-preview caps (1000/2000) because the sheet scrolls and only one
// body renders at a time.
const EDIT_CHARACTER_CAP = 10_000;
const EDIT_LINE_CAP = 500;

export type ToolDiffModel = {
  lines: readonly ParsedDiffLine[];
  filePath: string;
  /** File-extension language for syntax highlighting. null = plain text. */
  language: string | null;
  truncated: boolean;
  tool: string;
};

/**
 * Convert an edit tool part into a diff model.
 * Returns null when the tool is not edit, the input is absent or
 * invalid, or the diff content is empty.
 */
export function buildToolDiffModel(part: ToolPart): ToolDiffModel | null {
  const tool = part.tool;
  const input = part.state.input as Record<string, unknown>;

  if (tool === 'edit') {
    const { filePath, oldString, newString } = editToolInputSchema.parse(input);

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

  return null;
}

/**
 * Split text on newlines. Drop a single trailing empty string produced
 * when the input ends with a newline because it is not a content line.
 */
function splitTrimTrailingEmpty(text: string): string[] {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const parts = normalized.split('\n');
  if (parts.length > 1 && parts.at(-1) === '') {
    parts.pop();
  }
  return parts;
}
