import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

/**
 * Resolve a session title for display, or `undefined` when there is nothing
 * worth showing.
 *
 * The server stamps a creation-default placeholder
 * (`New session - <ISO timestamp>`) on every session it creates and only
 * replaces it once a message is ingested. That raw value is an internal
 * marker, never user copy: the same rule web applies in
 * `apps/web/src/routers/cli-sessions-v2-router.ts`. Resolution happens at
 * every paint site of a server title, so the placeholder can never reach the
 * session-detail header, a list row, the rename modal's initial value, or the
 * live-list search index — each of those substitutes its own generic label
 * (or skips the value) when this returns `undefined`.
 */
export function resolveSessionDisplayTitle(title: string | null | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed || isDefaultSessionTitle(trimmed)) {
    return undefined;
  }
  return trimmed;
}
