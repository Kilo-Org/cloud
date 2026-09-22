import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

/**
 * True when a title carries no user copy: it is empty/whitespace-only, or it is
 * the backend's creation placeholder (`New session - <ISO timestamp>` /
 * `Child session - <ISO timestamp>`) written at session creation
 * (`services/cloud-agent-next/src/session/session-registration.ts:764`) and
 * only promoted to an agent-generated title once ingest runs
 * (`services/session-ingest/src/ingest/metadata.ts:166`). The client must never
 * paint this machine string.
 */
export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim();
  return trimmed === undefined || trimmed.length === 0 || isDefaultSessionTitle(trimmed);
}

/**
 * The user-facing title to paint: `fallback` when the server title is the
 * backend's creation placeholder or empty, otherwise the trimmed real title.
 * The placeholder's origin is `services/cloud-agent-next/src/session/session-registration.ts:764`,
 * promoted by `services/session-ingest/src/ingest/metadata.ts:166`.
 */
export function resolveSessionDisplayTitle(
  title: string | null | undefined,
  fallback: string
): string {
  const trimmed = title?.trim();
  if (trimmed === undefined || isPlaceholderSessionTitle(trimmed)) {
    return fallback;
  }
  return trimmed;
}
