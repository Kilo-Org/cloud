// Duplicated from kilocode packages/opencode/src/session/session.ts:55-62
// (isDefaultTitle). Keep in sync when the CLI default-title pattern changes.
export const DEFAULT_SESSION_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A session title counts as the creation placeholder when it is still NULL or when it
 * holds the default title stamped at creation time (e.g. cloud-agent-next inserts
 * `New session - <ISO timestamp>` via createSessionForCloudAgent). Agent-generated
 * titles may promote a placeholder title but must never overwrite a user-chosen one.
 */
export function isDefaultSessionTitle(title: string | null | undefined): boolean {
  if (title == null) return true;
  return DEFAULT_SESSION_TITLE_PATTERN.test(title);
}
