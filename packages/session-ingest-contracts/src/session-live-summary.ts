/**
 * The small derived summary of one session that the session card shows
 * (`.specs/mobile-session-live-activity.md` "Card data contract"). The ingest
 * service derives it from the tool, todo, diff and error items and stores only
 * this summary, never the raw text. It never carries assistant message text.
 */

import { z } from 'zod';

/**
 * The title the backend seeds at creation: `New session - <ISO>` for a root
 * session and `Child session - <ISO>` for a child. Every surface that decides
 * whether a session has a name yet reads the creation-title rule from here.
 */
export const DEFAULT_SESSION_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Whether the title is still the creation placeholder, or missing entirely. */
export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  return title == null || DEFAULT_SESSION_TITLE_PATTERN.test(title);
}

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

/**
 * The todo statuses `sessionLivePlan` classifies: it leaves `cancelled` out of
 * the count, counts `completed` as done, and shows the first `in_progress` step
 * as the current one. They are the values the `todowrite` field description
 * names, not values its schema enforces, so a plan can also carry a status
 * outside this set. Such an entry is still a task the session has to do, so it
 * counts toward the total and is neither done nor current. The mobile task list
 * reads such an entry as an outstanding task the same way; the web todo
 * projection leaves it out, so the two can differ for that input.
 */
export const SESSION_LIVE_TODO_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
] as const;

export type SessionLiveTodoStatus = (typeof SESSION_LIVE_TODO_STATUSES)[number];

/** The longest step target (a file basename or a short tool target). */
export const SESSION_LIVE_TARGET_LIMIT = 40;
export const SESSION_LIVE_PLAN_STEP_LIMIT = 40;
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
 * of its own that does not shape adjacent characters either (directional marks
 * and embeddings, the zero-width space, the invisible operators, and the byte
 * order mark). Display text keeps the code points that draw themselves and the
 * joiners that shape their neighbours, so these are removed. Compared
 * numerically because a character class naming them reads in the source as the
 * characters themselves.
 */
function isFormatControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200b ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Display text as one line of what it draws: control characters (the C0 range,
 * delete, the C1 range) and line breaks become spaces, layout format controls
 * are left out, and the joiners that shape adjacent characters are kept. Every
 * display surface that shows stored text reads it through this, so one string
 * cannot read two ways. White space is left as it is; `sessionLiveText`
 * collapses and bounds it.
 */
export function sessionDisplayLine(raw: string): string {
  // Iterating code points keeps a surrogate pair whole while the control set is applied.
  return [...raw]
    .map(char => {
      const code = char.codePointAt(0) ?? 0;
      if (isFormatControl(code)) return '';
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
        ? ' '
        : char;
    })
    .join('');
}

let graphemeSegmenter: Intl.Segmenter | undefined;

/**
 * The segmenter the cut reads character boundaries from, or null when the
 * runtime does not provide one. A built segmenter is kept: it is stateless, and
 * the granularity is the same for every language, so no locale is needed.
 *
 * A missing one is not remembered. Hermes ships no `Intl.Segmenter` and the
 * mobile app installs the polyfill into the running process, so a caller that
 * cuts text before that install must read the next cut through the segmenter
 * that is there now, not keep a code-unit cut for the rest of the process.
 */
function characterSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter) return graphemeSegmenter;
  if (typeof Intl !== 'object' || Intl === null || typeof Intl.Segmenter !== 'function') {
    return null;
  }
  graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return graphemeSegmenter;
}

/**
 * The shared character reader for every cut in the workspace: display surfaces
 * read it through `sessionLiveCut`, and byte-capped report fields read it
 * directly after their own byte count.
 *
 * The end of the character at or before `maxIndex`, as the index just past it:
 * the largest extended grapheme cluster boundary no greater than `maxIndex`.
 * A runtime without segmentation falls back to a code unit boundary that keeps
 * a surrogate pair whole. A cap past the end of the line reads as the line end,
 * and a cap at or below zero reads as zero.
 */
export function characterCut(line: string, maxIndex: number): number {
  // Clamping once keeps the two runtime branches on one contract.
  const cap = Math.min(Math.max(maxIndex, 0), line.length);
  const segmenter = characterSegmenter();
  if (segmenter === null) {
    const last = line.charCodeAt(cap - 1);
    return cap > 0 && last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap;
  }
  let end = 0;
  for (const { index, segment } of segmenter.segment(line)) {
    if (index + segment.length > cap) break;
    end = index + segment.length;
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
 * of joiners give null, and so does a limit below one: a caller that computed
 * no room for text gets no text back, never an ellipsis that overruns the
 * budget.
 */
export function sessionLiveText(raw: unknown, limit: number): string | null {
  if (typeof raw !== 'string') return null;
  if (!(limit >= 1)) return null;
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

function basename(value: unknown): string | null {
  const text = sessionLiveText(value, Number.MAX_SAFE_INTEGER);
  if (text === null) return null;
  // Trailing separators name no segment, so the target ends before them.
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code !== 0x2f && code !== 0x5c) break;
    end--;
  }
  const last =
    end === 0 ? -1 : Math.max(text.lastIndexOf('/', end - 1), text.lastIndexOf('\\', end - 1));
  const base = last === -1 ? text.slice(0, end) : text.slice(last + 1, end);
  return sessionLiveText(base, SESSION_LIVE_TARGET_LIMIT);
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (typeof input[key] === 'string') return input[key];
  }
  return null;
}

/** The path a file tool acted on: `filePath` (CLI), `file_path` or `path`. */
const FILE_PATH_KEYS = ['filePath', 'file_path', 'path'] as const;

/**
 * The host a URL names, or null when the text is not a URL. The caller supplies
 * it because this package compiles under consumers whose `lib` has no platform
 * globals: `webUrlHost` in `@kilocode/worker-utils` is the implementation every
 * producer passes.
 */
export type SessionLiveUrlHost = (url: string) => string | null;

/** The URL host, or the whole trimmed URL when it does not parse. */
function urlHost(value: unknown, webHost: SessionLiveUrlHost): string | null {
  const text = sessionLiveText(value, Number.MAX_SAFE_INTEGER);
  if (text === null) return null;
  const host = webHost(text);
  return sessionLiveText(host ?? text, SESSION_LIVE_TARGET_LIMIT);
}

/**
 * The step a started tool call shows: its verb and a short target (a file
 * basename, a command, a pattern or a host). Every producer of the summary
 * names a tool through this one table; `webHost` reads a web fetch URL's host
 * for the `webfetch` cases.
 */
export function sessionLiveToolStep(
  tool: string,
  input: Record<string, unknown>,
  webHost: SessionLiveUrlHost
): SessionLiveStep {
  switch (tool.toLowerCase()) {
    case 'edit':
    case 'write':
    case 'multiedit':
    case 'patch':
    case 'apply_patch':
      return { verb: 'editing', target: basename(firstString(input, FILE_PATH_KEYS)) };
    case 'read':
      return { verb: 'reading', target: basename(firstString(input, FILE_PATH_KEYS)) };
    case 'bash':
      return {
        verb: 'running',
        target: sessionLiveText(input['command'], SESSION_LIVE_TARGET_LIMIT),
      };
    case 'grep':
    case 'glob':
      return {
        verb: 'searching',
        target: sessionLiveText(input['pattern'], SESSION_LIVE_TARGET_LIMIT),
      };
    case 'list':
      return { verb: 'searching', target: basename(firstString(input, FILE_PATH_KEYS)) };
    case 'codesearch':
    case 'websearch':
    case 'web_search':
      return {
        verb: 'searching',
        target: sessionLiveText(input['query'], SESSION_LIVE_TARGET_LIMIT),
      };
    case 'webfetch':
    case 'web_fetch':
      return { verb: 'searching', target: urlHost(input['url'], webHost) };
    default:
      return { verb: 'other', target: null };
  }
}

/**
 * What each classified todo status means to the plan. `satisfies` a record of
 * `SessionLiveTodoStatus`, so adding a status to that set fails the type check
 * until its role is written here, and the counting below reads only this table.
 */
const TODO_STATUS_ROLES = {
  cancelled: 'skipped',
  completed: 'done',
  in_progress: 'current',
  pending: 'outstanding',
} as const satisfies Readonly<
  Record<SessionLiveTodoStatus, 'skipped' | 'done' | 'current' | 'outstanding'>
>;

function isClassifiedTodoStatus(status: string): status is SessionLiveTodoStatus {
  return SESSION_LIVE_TODO_STATUSES.some(candidate => candidate === status);
}

const todoSchema = z.object({ content: z.string(), status: z.string() });
const todoInputSchema = z.object({ todos: z.array(z.unknown()) });

/**
 * `todowrite` input: completed count, total (cancelled excluded) and the active
 * step. `SESSION_LIVE_TODO_STATUSES` and `TODO_STATUS_ROLES` are the one place a
 * status's meaning is written down; the loop only reads the role. Null when no
 * entry counts, which is an empty list and a list of only cancelled entries.
 */
export function sessionLivePlan(input: Record<string, unknown>): SessionLivePlan | null {
  const parsed = todoInputSchema.safeParse(input);
  if (!parsed.success) return null;
  let done = 0;
  let total = 0;
  let current: string | null = null;
  for (const raw of parsed.data.todos) {
    const todo = todoSchema.safeParse(raw);
    if (!todo.success) continue;
    const { status } = todo.data;
    const role = isClassifiedTodoStatus(status) ? TODO_STATUS_ROLES[status] : 'outstanding';
    if (role === 'skipped') continue;
    total++;
    if (role === 'done') done++;
    if (role === 'current' && current === null) {
      current = sessionLiveText(todo.data.content, SESSION_LIVE_PLAN_STEP_LIMIT);
    }
  }
  if (total === 0) return null;
  return { done, total, current };
}
