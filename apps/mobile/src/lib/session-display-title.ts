import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

/**
 * True when a session title is machine copy rather than a user-facing title:
 * it is empty, or it is the creation placeholder
 * `New session - <ISO timestamp>` / `Child session - <ISO timestamp>` written
 * by the backend at
 * `services/cloud-agent-next/src/session/session-registration.ts:763` and only
 * replaced once the agent's generated title is promoted by ingest
 * (`services/session-ingest/src/ingest/metadata.ts:159-175`).
 */
export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim() ?? '';
  return trimmed.length === 0 || isDefaultSessionTitle(trimmed);
}

/**
 * Resolves the title to paint in the UI: `fallback` for any placeholder (see
 * {@link isPlaceholderSessionTitle}), otherwise the trimmed server title. The
 * placeholder is written by the backend at
 * `services/cloud-agent-next/src/session/session-registration.ts:763` and
 * promoted by `services/session-ingest/src/ingest/metadata.ts:159-175`, so the
 * client must never paint it.
 */
export function resolveSessionDisplayTitle(
  title: string | null | undefined,
  fallback: string
): string {
  const trimmed = title?.trim() ?? '';
  return isPlaceholderSessionTitle(trimmed) ? fallback : trimmed;
}
