/**
 * Mirror of `DEFAULT_SESSION_TITLE_PATTERN` in
 * `packages/session-ingest-contracts/src/index.ts` (the backend's contract for
 * a session it has not named yet). Kept local on purpose: importing that
 * package would pull its zod rpc-contract into the mobile bundle for a regex.
 */
const DEFAULT_SESSION_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The session backend names a session `New session - <ISO>` (or
 * `Child session - <ISO>`) until a real title exists. That raw timestamp is
 * machine output, so a display surface treats it as untitled and renders its
 * own fallback copy instead of the timestamp.
 *
 * Returns the title when it is worth showing, `undefined` otherwise (absent,
 * empty, or a backend default title).
 */
export function displaySessionTitle(title: string | null | undefined): string | undefined {
  if (title == null || title.length === 0 || DEFAULT_SESSION_TITLE_PATTERN.test(title)) {
    return undefined;
  }
  return title;
}
