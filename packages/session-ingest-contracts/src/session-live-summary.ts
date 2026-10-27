import { z } from 'zod';

/**
 * The small derived summary of one session that the session card shows
 * (`.specs/mobile-session-live-activity.md` "Card data contract"). The ingest
 * service derives it from the tool, todo, diff and error items and stores only
 * this summary, never the raw text. It never carries assistant message text.
 */

export const SESSION_LIVE_STEP_VERBS = [
  'editing',
  'reading',
  'running',
  'searching',
  'thinking',
  'other',
] as const;

export type SessionLiveStepVerb = (typeof SESSION_LIVE_STEP_VERBS)[number];

export const SESSION_LIVE_FAILURE_KINDS = ['provider', 'tool', 'cancelled', 'other'] as const;

export type SessionLiveFailureKind = (typeof SESSION_LIVE_FAILURE_KINDS)[number];

/** The longest step target (a file basename or a short tool target). */
export const SESSION_LIVE_TARGET_LIMIT = 40;
/** The longest plan step name. */
export const SESSION_LIVE_PLAN_STEP_LIMIT = 40;
/** The longest permission command. */
export const SESSION_LIVE_COMMAND_LIMIT = 60;

export const sessionLiveStepSchema = z.object({
  verb: z.enum(SESSION_LIVE_STEP_VERBS),
  target: z.string().max(SESSION_LIVE_TARGET_LIMIT).nullable(),
});

export type SessionLiveStep = z.infer<typeof sessionLiveStepSchema>;

export const sessionLivePlanSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  current: z.string().max(SESSION_LIVE_PLAN_STEP_LIMIT).nullable(),
});

export type SessionLivePlan = z.infer<typeof sessionLivePlanSchema>;

export const sessionLiveChangesSchema = z.object({
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});

export type SessionLiveChanges = z.infer<typeof sessionLiveChangesSchema>;

export const sessionLiveFailureSchema = z.object({
  kind: z.enum(SESSION_LIVE_FAILURE_KINDS),
});

export type SessionLiveFailure = z.infer<typeof sessionLiveFailureSchema>;

/**
 * The stored summary. `failure` describes the last finished turn and is
 * cleared when a new turn starts.
 */
export const sessionLiveSummarySchema = z.object({
  step: sessionLiveStepSchema.nullable(),
  plan: sessionLivePlanSchema.nullable(),
  changes: sessionLiveChangesSchema.nullable(),
  failure: sessionLiveFailureSchema.nullable(),
});

export type SessionLiveSummary = z.infer<typeof sessionLiveSummarySchema>;

/**
 * Whether the code point is a layout format control: a code point with no glyph
 * of its own that does not shape adjacent characters either. Display text keeps
 * the code points that draw themselves and the joiners that shape their
 * neighbours, so these are removed. Compared numerically because a character
 * class naming them reads in the source as the characters themselves.
 */
function isFormatControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200b ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    code === 0x2060 ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Display text as one line of what it draws: control characters and line breaks
 * become spaces, layout format controls are left out, and the joiners that
 * shape adjacent characters are kept. Every display surface that shows stored
 * text reads it through this, so one string cannot read two ways. White space
 * is left as it is; `sessionLiveText` collapses and bounds it.
 */
export function sessionDisplayLine(raw: string): string {
  // Iterating code points keeps a surrogate pair whole while the control set is
  // applied. The set is compared numerically: a character class that names the
  // control range reads as a control character in the source itself.
  return [...raw]
    .map(char => {
      const code = char.codePointAt(0) ?? 0;
      if (isFormatControl(code)) return '';
      return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029 ? ' ' : char;
    })
    .join('');
}

let graphemeSegmenter: Intl.Segmenter | null | undefined;

/**
 * The segmenter the cut reads character boundaries from, or null when the
 * runtime does not provide one. Built once: a segmenter is stateless, and the
 * granularity is the same for every language, so no locale is needed.
 */
function characterSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter =
      typeof Intl === 'object' && Intl !== null && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  return graphemeSegmenter;
}

/**
 * The end of the character at or before `maxIndex`, as the index just past it:
 * the largest extended grapheme cluster boundary no greater than `maxIndex`.
 * A runtime without segmentation falls back to a code unit boundary that keeps
 * a surrogate pair whole.
 */
function characterCut(line: string, maxIndex: number): number {
  const segmenter = characterSegmenter();
  if (segmenter === null) {
    const last = line.charCodeAt(maxIndex - 1);
    return maxIndex > 0 && last >= 0xd800 && last <= 0xdbff ? maxIndex - 1 : maxIndex;
  }
  let end = 0;
  for (const { index } of segmenter.segment(line)) {
    if (index > maxIndex) break;
    end = index;
  }
  return end;
}

/**
 * The longest prefix of `text` that fits in `limit` UTF-16 code units and ends
 * on a character boundary, so an emoji sequence, a flag, a skin-tone or keycap
 * modifier, or a combining mark is never left half drawn. Every capped card
 * text reads its cut from here. A runtime without segmentation keeps a code
 * unit boundary that does not split a surrogate pair.
 */
export function sessionLiveCut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, characterCut(text, limit));
}

/**
 * One line of display text: control characters and line breaks become spaces,
 * layout format controls are removed, the joiners that shape adjacent
 * characters are kept, runs of white space collapse, and text longer than
 * `limit` ends with an ellipsis inside the limit. The cut falls on a character
 * boundary, so the line never ends half drawn, and the whole result stays
 * within `limit` UTF-16 code units. Empty text, white space, and text made only
 * of joiners give null.
 */
export function sessionLiveText(raw: unknown, limit: number): string | null {
  if (typeof raw !== 'string') return null;
  const line = sessionDisplayLine(raw).replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  // Joiners alone draw nothing, so they are empty display text like blanks.
  if (
    [...line].every(char => {
      const code = char.codePointAt(0);
      return code === 0x200c || code === 0x200d;
    })
  ) {
    return null;
  }
  if (line.length <= limit) return line;
  return `${sessionLiveCut(line, limit - 1).trimEnd()}…`;
}
