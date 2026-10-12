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
 * One line of display text: control characters and line breaks become spaces,
 * runs of white space collapse, and text longer than `limit` ends with an
 * ellipsis inside the limit. The cut never splits a UTF-16 surrogate pair.
 * Empty text gives null.
 */
export function sessionLiveText(raw: unknown, limit: number): string | null {
  if (typeof raw !== 'string') return null;
  // Iterating code points keeps a surrogate pair whole while the control set is
  // applied. The set is compared numerically: a character class that names the
  // control range reads as a control character in the source itself.
  const flattened = [...raw]
    .map(char => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029 ? ' ' : char;
    })
    .join('');
  const line = flattened.replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  if (line.length <= limit) return line;
  let cut = line.slice(0, limit - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
