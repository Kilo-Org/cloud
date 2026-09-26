/**
 * The session-resume gate's decision, kept pure and DOM-free.
 *
 * A universal session link (`/cloud/sessions/<id>?at=<messageId>`) resolves the
 * session through `cliSessionsV2.get`. This module turns that lookup into either
 * the chat URL the gate replaces into, or the refusal the gate renders in place
 * when the account may not see the session.
 *
 * Web has no i18n catalog: the refusal copy is the same literal the app shows
 * for these codes, so it lives here and nowhere else.
 */

/**
 * Where a refusal sends the reader next. The link they arrived on points at a
 * session their account may not see, so the one useful move is the sessions
 * list they can open; the label is the same "Back to sessions" the app shows.
 */
export const SESSION_RESUME_REFUSAL_HREF = '/cloud/sessions';

/** Refusal shown when the session does not exist or was deleted. */
const SESSION_RESUME_NOT_FOUND: SessionResumeRefusal = {
  heading: 'Not found',
  message: 'This item may have been removed or is no longer available.',
};

/** Refusal shown when the session exists but the account cannot access it. */
const SESSION_RESUME_ACCESS_DENIED: SessionResumeRefusal = {
  heading: 'Access denied',
  message: "You don't have permission to view this.",
};

export type SessionResumeRefusal = {
  readonly heading: string;
  readonly message: string;
};

/** The `cliSessionsV2.get` fields the destination depends on. */
export type SessionResumeSession = {
  readonly session_id: string;
  readonly organization_id?: string | null;
};

/**
 * Refusal the gate renders for an access-denied lookup, or null when the code
 * is not an authoritative denial (a retryable failure keeps the gate retrying).
 */
export function sessionResumeRefusal(code: string | null | undefined): SessionResumeRefusal | null {
  if (code === 'NOT_FOUND') {
    return SESSION_RESUME_NOT_FOUND;
  }
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    return SESSION_RESUME_ACCESS_DENIED;
  }
  return null;
}

/**
 * The `cliSessionsV2.get` error fields this decision reads. `code` is part of
 * the shape so a caller can pass the error data as-is.
 */
type SessionResumeErrorLike =
  | {
      readonly data?: { readonly authRequired?: boolean; readonly code?: string } | null;
    }
  | null
  | undefined;

/**
 * Whether the lookup failed because the signed-in session expired rather than
 * because the account may not open this session. Both arrive as `UNAUTHORIZED`;
 * only the context-level auth failure carries `authRequired`. That failure is
 * recoverable — the gate sends the reader through sign-in and back to the same
 * link — so it must not render as a permanent access denial.
 */
export function sessionResumeNeedsSignIn(error: SessionResumeErrorLike): boolean {
  return error?.data?.authRequired === true;
}

/**
 * Chat URL that opens the session, preserving the recorded anchor when present.
 * Organization sessions land on their organization chat page.
 */
export function sessionResumeHref(
  session: SessionResumeSession,
  anchorMessageId: string | null | undefined
): string {
  const base = session.organization_id
    ? `/organizations/${encodeURIComponent(session.organization_id)}/cloud/chat`
    : '/cloud/chat';

  const params = [`sessionId=${encodeURIComponent(session.session_id)}`];
  if (typeof anchorMessageId === 'string' && anchorMessageId.length > 0) {
    params.push(`at=${encodeURIComponent(anchorMessageId)}`);
  }

  return `${base}?${params.join('&')}`;
}

/**
 * Sign-in redirect for a universal session link, keeping the recorded anchor in
 * the `callbackPath` so the position survives the sign-in round trip instead of
 * dropping to the session top. The whole callback path is encoded exactly once.
 */
export function sessionResumeSignInPath(
  sessionId: string,
  anchorMessageId: string | null | undefined
): string {
  let callbackPath = `/cloud/sessions/${encodeURIComponent(sessionId)}`;
  if (typeof anchorMessageId === 'string' && anchorMessageId.length > 0) {
    callbackPath += `?at=${encodeURIComponent(anchorMessageId)}`;
  }

  return `/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`;
}
