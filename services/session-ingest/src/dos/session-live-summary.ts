import {
  sessionLiveText,
  sdkAssistantErrorSchema,
  SESSION_LIVE_PLAN_STEP_LIMIT,
  SESSION_LIVE_TARGET_LIMIT,
  type SessionLiveChanges,
  type SessionLiveFailureKind,
  type SessionLivePlan,
  type SessionLiveStep,
  type SessionLiveSummary,
} from '@kilocode/session-ingest-contracts';
import { z } from 'zod';

/**
 * Derive the small session card summary from the ingest items. The state is a
 * fold: the DO keeps the running value in its ingest meta and passes only the
 * newest batch, so the derivation never rescans the session. The stored value
 * carries only short display text (a file basename, a plan step, a tool
 * target); assistant message text is never read.
 */

const partTypeSchema = z.object({ type: z.string() });

const toolStateSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'error']),
  input: z.record(z.string(), z.unknown()).optional(),
});

const toolPartSchema = z.object({
  type: z.literal('tool'),
  tool: z.string(),
  state: toolStateSchema,
});

const todoSchema = z.object({ content: z.string(), status: z.string() });
const todoInputSchema = z.object({ todos: z.array(z.unknown()) });

const sessionDiffSchema = z.array(
  z.object({
    file: z.string(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
  })
);

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  error: sdkAssistantErrorSchema.optional(),
});

export type SessionLiveSummaryState = SessionLiveSummary;

/** The running value before any item arrived: nothing known yet. */
export const EMPTY_SESSION_LIVE_SUMMARY_STATE: SessionLiveSummaryState = {
  step: null,
  plan: null,
  changes: null,
  failure: null,
};

/** Whether the two running values differ in a field the session card draws. */
export function sessionLiveSummaryChanged(
  previous: SessionLiveSummaryState,
  next: SessionLiveSummaryState
): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function basename(value: unknown): string | null {
  const text = sessionLiveText(value, Number.MAX_SAFE_INTEGER);
  if (text === null) return null;
  const trimmed = text.replace(/[/\\]+$/, '');
  const last = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = last === -1 ? trimmed : trimmed.slice(last + 1);
  return sessionLiveText(base === '' ? trimmed : base, SESSION_LIVE_TARGET_LIMIT);
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (typeof input[key] === 'string') return input[key];
  }
  return null;
}

/** The path a file tool acted on: `filePath` (CLI), `file_path` or `path`. */
const FILE_PATH_KEYS = ['filePath', 'file_path', 'path'] as const;

/** The URL host, or the whole trimmed URL when it does not parse. */
function urlHost(value: unknown): string | null {
  const text = sessionLiveText(value, Number.MAX_SAFE_INTEGER);
  if (text === null) return null;
  try {
    return sessionLiveText(new URL(text).host, SESSION_LIVE_TARGET_LIMIT);
  } catch {
    return sessionLiveText(text, SESSION_LIVE_TARGET_LIMIT);
  }
}

function toolStep(tool: string, input: Record<string, unknown>): SessionLiveStep {
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
      return { verb: 'running', target: sessionLiveText(input.command, SESSION_LIVE_TARGET_LIMIT) };
    case 'grep':
    case 'glob':
      return {
        verb: 'searching',
        target: sessionLiveText(input.pattern, SESSION_LIVE_TARGET_LIMIT),
      };
    case 'list':
      return { verb: 'searching', target: basename(input.path) };
    case 'codesearch':
      return { verb: 'searching', target: sessionLiveText(input.query, SESSION_LIVE_TARGET_LIMIT) };
    case 'websearch':
    case 'web_search':
      return { verb: 'searching', target: sessionLiveText(input.query, SESSION_LIVE_TARGET_LIMIT) };
    case 'webfetch':
    case 'web_fetch':
      return { verb: 'searching', target: urlHost(input.url) };
    default:
      return { verb: 'other', target: null };
  }
}

/** `todowrite` input: completed count, total (cancelled excluded) and the active step. */
function planFromInput(input: Record<string, unknown>): SessionLivePlan | null {
  const parsed = todoInputSchema.safeParse(input);
  if (!parsed.success) return null;
  let done = 0;
  let total = 0;
  let current: string | null = null;
  for (const raw of parsed.data.todos) {
    const todo = todoSchema.safeParse(raw);
    if (!todo.success || todo.data.status === 'cancelled') continue;
    total++;
    if (todo.data.status === 'completed') done++;
    if (current === null && todo.data.status === 'in_progress') {
      current = sessionLiveText(todo.data.content, SESSION_LIVE_PLAN_STEP_LIMIT);
    }
  }
  if (total === 0) return null;
  return { done, total, current };
}

function changesFromSnapshot(data: unknown): SessionLiveChanges | null {
  const parsed = sessionDiffSchema.safeParse(data);
  if (!parsed.success) return null;
  let added = 0;
  let removed = 0;
  for (const diff of parsed.data) {
    added += Math.max(0, diff.additions ?? 0);
    removed += Math.max(0, diff.deletions ?? 0);
  }
  return { files: parsed.data.length, added, removed };
}

/** Map one assistant error name to a failure kind. */
export function failureKindForAssistantError(name: string): SessionLiveFailureKind {
  switch (name) {
    case 'ProviderAuthError':
    case 'APIError':
      return 'provider';
    case 'MessageAbortedError':
      return 'cancelled';
    default:
      return 'other';
  }
}

/** The failure kind an errored tool part reports, or null when it did not fail. */
export function failureKindForToolPart(raw: unknown): SessionLiveFailureKind | null {
  const parsed = toolPartSchema.safeParse(raw);
  if (!parsed.success || parsed.data.state.status !== 'error') return null;
  return 'tool';
}

export type SessionLiveBatchItem = { type: string; data: unknown };

/**
 * Fold the newest batch into the running state. Items apply in array order, so
 * the newest item of a kind wins when one batch carries several. `status` is
 * the status the same batch reported (already read by the caller): a new turn
 * clears the failure of the turn before it. The returned value is fresh; the
 * input is never mutated.
 */
export function foldSessionLiveSummary(
  state: SessionLiveSummaryState,
  batch: readonly SessionLiveBatchItem[],
  status: string | null
): SessionLiveSummaryState {
  let step = state.step;
  let plan = state.plan;
  let changes = state.changes;
  let failure: SessionLiveSummaryState['failure'] = state.failure;
  let batchStatus: string | null = null;

  for (const item of batch) {
    switch (item.type) {
      case 'part': {
        const tool = toolPartSchema.safeParse(item.data);
        if (tool.success) {
          const { tool: name, state: toolState } = tool.data;
          const input = toolState.input ?? {};
          if (name.toLowerCase() === 'todowrite') plan = planFromInput(input);
          if (toolState.status === 'pending' || toolState.status === 'running') {
            step = toolStep(name, input);
          } else if (toolState.status === 'error') {
            failure = { kind: 'tool' };
          }
          break;
        }
        const partType = partTypeSchema.safeParse(item.data);
        if (
          partType.success &&
          partType.data.type === 'reasoning' &&
          isBusy(status ?? batchStatus)
        ) {
          step = { verb: 'thinking', target: null };
        }
        break;
      }
      case 'message': {
        const parsed = assistantMessageSchema.safeParse(item.data);
        if (parsed.success && parsed.data.error !== undefined) {
          failure = { kind: failureKindForAssistantError(parsed.data.error.name) };
        }
        break;
      }
      case 'session_diff': {
        changes = changesFromSnapshot(item.data);
        break;
      }
      case 'session_status': {
        const next = (item.data as { status?: unknown } | null)?.status;
        if (typeof next === 'string') batchStatus = next;
        break;
      }
      case 'session_close': {
        const reason = (item.data as { reason?: unknown } | null)?.reason;
        if (reason === 'error') failure = { kind: 'other' };
        else if (reason === 'interrupted') failure = { kind: 'cancelled' };
        break;
      }
      default:
        break;
    }
  }

  // A new turn clears the failure of the turn before it.
  const effectiveStatus = status ?? batchStatus;
  return isBusy(effectiveStatus)
    ? { step, plan, changes, failure: null }
    : { step, plan, changes, failure };
}

/** At most one live-summary persist per window; the newest value wins after it. */
export const LIVE_SUMMARY_PERSIST_THROTTLE_MS = 10_000;

/**
 * Whether this batch persists the summary: always on a status transition or a
 * failure change, otherwise at most once per window.
 */
export function decideLiveSummaryPersist(args: {
  nowMs: number;
  statusTransition: boolean;
  failureChanged: boolean;
  lastPersistedAtMs: number | null;
}): boolean {
  if (args.statusTransition || args.failureChanged) return true;
  if (args.lastPersistedAtMs === null) return true;
  return args.nowMs - args.lastPersistedAtMs >= LIVE_SUMMARY_PERSIST_THROTTLE_MS;
}

/**
 * Apply the status transition after a batch. A new turn (busy) clears the
 * finished-turn failure; an idle transition clears the live step and plan.
 * The caller derives `status` from the metadata change it already computed.
 */
export function applySessionLiveSummaryStatus(
  state: SessionLiveSummaryState,
  status: string | null
): SessionLiveSummaryState {
  if (isBusy(status)) return { ...state, failure: null };
  if (status === 'idle') return { ...state, step: null, plan: null };
  return state;
}

function isBusy(status: string | null): boolean {
  return status === 'busy' || status === 'working' || status === 'running';
}
