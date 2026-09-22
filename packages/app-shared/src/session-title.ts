/**
 * The cloud-agent backend writes a machine title when the user has not named
 * a session (`New session - <ISO>` / `Child session - <ISO>`). The pattern is
 * a shared contract owned by
 * `packages/session-ingest-contracts/src/index.ts` (its
 * `DEFAULT_SESSION_TITLE_PATTERN`); this copy exists only because the app
 * bundles platform-agnostic logic separately. Keep the two identical so the
 * "is this a real name?" answer never drifts between the ingest contract and
 * the app.
 */
export const DEFAULT_SESSION_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * True for `null`/`undefined`, for a blank title, and for the backend's
 * machine title. The app then paints its own fallback instead of the machine
 * string.
 */
export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  return title == null || title.trim().length === 0 || DEFAULT_SESSION_TITLE_PATTERN.test(title);
}

/** The fallback when the title is default/blank, else the title itself. */
export function displaySessionTitle(title: string | null | undefined, fallback: string): string {
  if (title == null || isDefaultSessionTitle(title)) {
    return fallback;
  }
  return title;
}

/**
 * The value a rename field should open with: `''` when the title is
 * default/blank, else the trimmed title. A machine or blank title must never
 * pre-fill the field with a name the user did not choose.
 */
export function sessionTitleRenameSeed(title: string | null | undefined): string {
  if (title == null || isDefaultSessionTitle(title)) {
    return '';
  }
  return title.trim();
}
