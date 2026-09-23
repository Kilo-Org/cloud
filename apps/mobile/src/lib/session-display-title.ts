// Mirrors DEFAULT_SESSION_TITLE_PATTERN / isDefaultSessionTitle in
// packages/session-ingest-contracts (apps/mobile has no dependency on that
// package; apps/mobile/src/lib/model-display-name.ts is the precedent for a
// mirrored display helper). Keep the two in step.
const DEFAULT_SESSION_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The title to paint for a session, or undefined when there is nothing
 * user-readable to show.
 *
 * The ingest service names a session `New session - <ISO>` at creation and
 * `Child session - <ISO>` for spawned children. Until a title is generated or
 * the user renames it, that machine string is not a name: treat it, like a
 * blank title, as absent so the caller renders its localized fallback.
 */
export function displayableSessionTitle(title: string | null | undefined): string | undefined {
  if (title == null) {
    return undefined;
  }
  const trimmed = title.trim();
  if (trimmed.length === 0 || DEFAULT_SESSION_TITLE_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}
