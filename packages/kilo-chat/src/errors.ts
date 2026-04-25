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
 * Derive a user-facing string from an error thrown by `KiloChatClient`.
 *
 * - Non-{@link KiloChatApiError} (network/abort/timeout) → returns `fallback`.
 * - 401/403 → generic "Not allowed" (avoids leaking server phrasing).
 * - 4xx with a zod `issues` array → phrase the first known issue; otherwise
 *   surface the server's `error` string when present.
 * - 5xx / unknown → returns `fallback`.
 *
 * Callers that need custom branching (e.g. 409 edit conflicts) should check
 * `err instanceof KiloChatApiError` themselves before delegating here.
 */
export function formatKiloChatError(err: unknown, fallback: string): string {
  if (!(err instanceof KiloChatApiError)) return fallback;

  if (err.status === 401 || err.status === 403) return 'Not allowed';
  if (err.status >= 500) return fallback;

  const body = err.body;
  if (!body || typeof body !== 'object') return fallback;

  const issues = (body as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const phrased = phraseIssue(issues[0] as core.$ZodIssue);
    if (phrased) return phrased;
  }

  const serverError = (body as { error?: unknown }).error;
  if (typeof serverError === 'string' && serverError.length > 0) return serverError;

  return fallback;
}

function phraseIssue(issue: core.$ZodIssue): string | null {
  const path = issue.path;
  const onTextContent = path[0] === 'content' && typeof path[1] === 'number' && path[2] === 'text';
  const onTitle = path[0] === 'title';

  if (issue.code === 'too_big') {
    const max = Number(issue.maximum);
    if (onTextContent) {
      const limit = Number.isFinite(max) ? max : MESSAGE_TEXT_MAX_CHARS;
      return `Message is too long — keep it under ${limit.toLocaleString('en-US')} characters`;
    }
    if (onTitle) {
      const limit = Number.isFinite(max) ? max : CONVERSATION_TITLE_MAX_CHARS;
      return `Title is too long — keep it under ${limit} characters`;
    }
  }
  if (issue.code === 'too_small' && onTextContent) {
    return "Message can't be empty";
  }
  return null;
}
