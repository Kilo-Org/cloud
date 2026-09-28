/**
 * Session resume links: the universal link a device advertises for the session
 * it is showing, plus the parse side that restores the session AND the position
 * on another device.
 *
 * The position rides the `?at=` query of the same link the app is already
 * claimed for — AASA and the Android intent filters compile from `routes.ts`,
 * so no new link, host or private channel is introduced. The path half
 * (`/cloud/sessions/<id>`) is the row at `routes.ts`, whose app target is the
 * session screen. `anchorPosition` is the single place both platforms turn the
 * stored anchor into a position, which is what makes the restored position
 * identical on iOS, Android and web.
 */

import { parseKiloWebPath, resolveIncomingUrl } from './routes';

/** Query parameter that carries the anchor message id. */
export const SESSION_RESUME_ANCHOR_PARAM = 'at';

/** Web path prefix of the session-detail row in `UNIVERSAL_LINK_ROUTES`. */
const SESSION_PATH_PREFIX = '/cloud/sessions/';

/** Host is the associated domain; see `apps/mobile/app.config.ts` applinks. */
const WEB_ORIGIN = 'https://app.kilo.ai';

export type SessionResumeTarget = {
  readonly sessionId: string;
  /** Message the resumed device should land on; omitted/null = session top. */
  readonly anchorMessageId?: string | null;
};

export type SessionResumeRef = {
  readonly sessionId: string;
  readonly anchorMessageId: string | null;
};

export type IncomingResume = {
  readonly href: string;
  readonly anchorMessageId: string | null;
};

/**
 * Build the universal link another device opens to resume this session.
 * The anchor is appended only when it is a non-empty string.
 */
export function sessionResumeUrl({ sessionId, anchorMessageId }: SessionResumeTarget): string {
  const base = `${WEB_ORIGIN}${SESSION_PATH_PREFIX}${encodeURIComponent(sessionId)}`;

  if (typeof anchorMessageId !== 'string' || anchorMessageId.length === 0) {
    return base;
  }

  return `${base}?${SESSION_RESUME_ANCHOR_PARAM}=${encodeURIComponent(anchorMessageId)}`;
}

/**
 * Read a session resume link (https or kiloapp). Null for any other path,
 * host or scheme. The session id and the anchor are each decoded once.
 */
export function readSessionResume(raw: string): SessionResumeRef | null {
  const webPath = parseKiloWebPath(raw);
  if (webPath === null || !webPath.startsWith(SESSION_PATH_PREFIX)) {
    return null;
  }

  const encodedId = webPath.slice(SESSION_PATH_PREFIX.length);
  // Exactly one segment: `/cloud/sessions` (the list) and `/cloud/sessions/a/b`
  // are not session links.
  if (encodedId.length === 0 || encodedId.includes('/')) {
    return null;
  }

  const sessionId = decodeComponent(encodedId);
  if (sessionId === null || sessionId.length === 0) {
    return null;
  }

  return { sessionId, anchorMessageId: readAnchorParam(raw) };
}

/**
 * Raw URL → app href plus the anchor, so a caller navigates to
 * `href?at=<anchor>`. A thin wrapper: `resolveIncomingUrl` itself stays the
 * pinned translator.
 */
export function resolveIncomingResume(raw: string): IncomingResume | null {
  const href = resolveIncomingUrl(raw);
  if (href === null) {
    return null;
  }

  return { href, anchorMessageId: readAnchorParam(raw) };
}

/**
 * Index of the anchor in the server-ordered message id list, or null when the
 * anchor is absent from it. Both platforms resolve a stored anchor through
 * this function.
 */
export function anchorPosition(
  orderedMessageIds: readonly string[],
  anchorMessageId: string
): number | null {
  if (typeof anchorMessageId !== 'string' || anchorMessageId.length === 0) {
    return null;
  }

  const index = orderedMessageIds.indexOf(anchorMessageId);
  return index < 0 ? null : index;
}

/** Query value of `at` in `raw`, decoded once; null when missing or unusable. */
function readAnchorParam(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  const schemeEnd = raw.indexOf('://');
  if (schemeEnd <= 0) {
    return null;
  }

  const afterScheme = raw.slice(schemeEnd + 3);
  const queryStart = afterScheme.indexOf('?');
  if (queryStart < 0) {
    return null;
  }

  const hash = afterScheme.indexOf('#');
  // A fragment before the query owns everything after it: a `?` inside the
  // fragment is fragment text, not a query parameter.
  if (hash >= 0 && hash < queryStart) {
    return null;
  }

  const queryEnd = hash > queryStart ? hash : afterScheme.length;

  for (const pair of afterScheme.slice(queryStart + 1, queryEnd).split('&')) {
    if (pair.length === 0) {
      continue;
    }

    const equals = pair.indexOf('=');
    const key = equals < 0 ? pair : pair.slice(0, equals);
    if (decodeComponent(key) !== SESSION_RESUME_ANCHOR_PARAM) {
      continue;
    }

    if (equals < 0) {
      return null;
    }

    const value = decodeComponent(pair.slice(equals + 1));
    return value !== null && value.length > 0 ? value : null;
  }

  return null;
}

/** Percent-decode once; null when the encoding is malformed. Never throws. */
function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
