import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

/**
 * The user-facing title for a session, or undefined when the row carries no
 * name a person wrote.
 *
 * `packages/session-ingest-contracts/src/index.ts` owns the placeholder
 * pattern (`DEFAULT_SESSION_TITLE_PATTERN` / `isDefaultSessionTitle`). The
 * backend seeds every fresh session with `New session - ${ISO}` —
 * `services/cloud-agent-next/src/session/session-registration.ts`,
 * `services/cloud-agent-next/src/session-service.ts`, and
 * `services/cloud-agent-next/wrapper/src/session-bootstrap.ts` — and
 * `services/session-ingest/src/ingest/metadata.ts` promotes the first user
 * message's real title over it. A session that still carries the placeholder
 * has no name yet, so every surface treats it exactly like a title-less one
 * and never paints the machine string.
 */
export function sessionDisplayTitle(title: string | null | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed || isDefaultSessionTitle(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * The session-detail header and its live `session.updated` handler call the
 * same rules under this name; keep it an alias so the two names cannot drift.
 */
export const displayableSessionTitle = sessionDisplayTitle;
