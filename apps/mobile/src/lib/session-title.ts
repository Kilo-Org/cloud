import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

/**
 * A stored session title a person can read, or null while the backend has not
 * named the session yet. The worker creates a session with `New session - <ISO>`
 * and session-ingest replaces it once a name is generated; the app must not print
 * that machine string in the meantime. The API and web app treat the placeholder
 * as 'no title' through the same contract (cli-sessions-v2-router.ts:955-956).
 */
export function readableSessionTitle(title: string | null | undefined): string | null {
  const value = title?.trim() ?? '';
  return value.length > 0 && !isDefaultSessionTitle(value) ? value : null;
}
