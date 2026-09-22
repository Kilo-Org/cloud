import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts/session-title';

/**
 * The user-facing name for a session. The backend seeds a machine placeholder
 * (`New session - <ISO>` / `Child session - <ISO>`) that is not a name, so a
 * placeholder or a blank title falls back to the caller's label.
 */
export function sessionDisplayTitle(title: string | null | undefined, fallback: string): string {
  return title == null || title.trim().length === 0 || isDefaultSessionTitle(title)
    ? fallback
    : title;
}
