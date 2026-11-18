import type { core } from 'zod';
import { CONVERSATION_TITLE_MAX_CHARS, MESSAGE_TEXT_MAX_CHARS } from './schemas';

export class KiloChatApiError extends Error {
  constructor(
    public status: number,
    public body: unknown
  ) {
    super(`Kilo Chat API error: ${status}`);
    this.name = 'KiloChatApiError';
  }
}

/**
 * A stable classification of an error thrown by `KiloChatClient`.
 *
 * Mobile maps each kind to a catalog key; web keeps reading the English
 * `formatKiloChatError` output. A `server` or `fallback` kind means the caller
 * should show its own message.
 */
export type KiloChatErrorKind =
  | { kind: 'not-allowed' }
  | { kind: 'message-too-long'; limit: number }
  | { kind: 'title-too-long'; limit: number }
  | { kind: 'message-empty' }
  | { kind: 'server'; message: string }
  | { kind: 'fallback' };

/**
 * Classify an error thrown by `KiloChatClient`.
 *
 * - Non-{@link KiloChatApiError} (network/abort/timeout) → `fallback`.
 * - 401/403 → `not-allowed` (avoids leaking server phrasing).
 * - 4xx with a zod `issues` array → classify the first known issue; otherwise
 *   surface the server's `error` string when present as `server`.
 * - 5xx / unknown → `fallback`.
 *
 * Callers that need custom branching (e.g. 409 edit conflicts) should check
 * `err instanceof KiloChatApiError` themselves before delegating here.
 */
export function classifyKiloChatError(err: unknown): KiloChatErrorKind {
  if (!(err instanceof KiloChatApiError)) return { kind: 'fallback' };

  if (err.status === 401 || err.status === 403) return { kind: 'not-allowed' };
  if (err.status >= 500) return { kind: 'fallback' };

  const body = err.body;
  if (!body || typeof body !== 'object') return { kind: 'fallback' };

  const issues = (body as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const classified = classifyIssue(issues[0] as core.$ZodIssue);
    if (classified) return classified;
  }

  const serverError = (body as { error?: unknown }).error;
  if (typeof serverError === 'string' && serverError.length > 0) {
    return { kind: 'server', message: serverError };
  }

  return { kind: 'fallback' };
}

/**
 * Derive the English string web reads today. Built from the classifier so the
 * two stay in lockstep; the output is byte-for-byte what web rendered before.
 */
export function formatKiloChatError(err: unknown, fallback: string): string {
  const kind = classifyKiloChatError(err);
  switch (kind.kind) {
    case 'not-allowed':
      return 'Not allowed';
    case 'message-too-long':
      return `Message is too long — keep it under ${kind.limit.toLocaleString('en-US')} characters`;
    case 'title-too-long':
      return `Title is too long — keep it under ${kind.limit} characters`;
    case 'message-empty':
      return "Message can't be empty";
    case 'server':
      return kind.message;
    case 'fallback':
      return fallback;
  }
}

function classifyIssue(issue: core.$ZodIssue): KiloChatErrorKind | null {
  const path = issue.path;
  const onTextContent = path[0] === 'content' && typeof path[1] === 'number' && path[2] === 'text';
  const onTitle = path[0] === 'title';

  if (issue.code === 'too_big') {
    const max = Number(issue.maximum);
    if (onTextContent) {
      return {
        kind: 'message-too-long',
        limit: Number.isFinite(max) ? max : MESSAGE_TEXT_MAX_CHARS,
      };
    }
    if (onTitle) {
      return {
        kind: 'title-too-long',
        limit: Number.isFinite(max) ? max : CONVERSATION_TITLE_MAX_CHARS,
      };
    }
  }
  if (issue.code === 'too_small' && onTextContent) {
    return { kind: 'message-empty' };
  }
  return null;
}
