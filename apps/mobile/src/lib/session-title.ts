/**
 * The CLI names a session the user has not renamed yet `New session - <ISO>`
 * (or `Child session - <ISO>`). Those generated titles are storage keys, not a
 * human-readable name, so screens render the localized fallback instead.
 *
 * Mirrors `DEFAULT_SESSION_TITLE_PATTERN` from
 * `packages/session-ingest-contracts/src/index.ts`. Kept local because
 * apps/mobile treats a new dependency as an `npx expo install` change, which a
 * one-line matcher does not justify.
 */
const GENERATED_SESSION_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A session title usable as a human-readable header name: the input unchanged
 * for a real title, `undefined` for null, for a blank value, and for a
 * generated placeholder title (`GENERATED_SESSION_TITLE_PATTERN`).
 */
export function normalizeSessionTitle(title: string | null | undefined): string | undefined {
  if (title == null || title.trim().length === 0) {
    return undefined;
  }
  return GENERATED_SESSION_TITLE_PATTERN.test(title) ? undefined : title;
}
