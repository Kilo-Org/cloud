/**
 * Server-side session titles are written as a millisecond-timestamp
 * placeholder at creation time (e.g. `New session - 2026-09-21T15:44:47.176Z`).
 * Web nulls it out before display; mobile must do the same so the raw
 * placeholder never reaches the session header or the rename modal.
 *
 * The pattern is the source of truth in
 * `packages/session-ingest-contracts/src/index.ts`
 * (`DEFAULT_SESSION_TITLE_PATTERN` / `isDefaultSessionTitle`); keep this copy
 * in sync with it.
 */
const DEFAULT_SESSION_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Whether `title` is absent or the server's creation-default placeholder.
 */
export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  return title == null || DEFAULT_SESSION_TITLE_PATTERN.test(title);
}

/**
 * The title to display on a user-facing surface: `undefined` when the input is
 * absent, blank, or the creation-default placeholder, otherwise the trimmed
 * real title.
 */
export function resolveSessionDisplayTitle(title: string | null | undefined): string | undefined {
  if (title == null) {
    return undefined;
  }
  const trimmed = title.trim();
  if (trimmed.length === 0 || isDefaultSessionTitle(trimmed)) {
    return undefined;
  }
  return trimmed;
}
