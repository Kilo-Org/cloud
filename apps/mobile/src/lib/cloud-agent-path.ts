/**
 * Cloud Agent workspaces put the repo inside an absolute, account-scoped
 * directory: `/workspace/<userId>/sessions/<sessionId>` for a session
 * workspace and `/workspace/<userId>/worktrees/<worktreeId>` for a
 * worktree-backed session, either optionally under an organization id
 * (`services/cloud-agent-next/src/workspace.ts:200-224`). The isolated
 * container layout clones at `/workspace/app`.
 *
 * A reader wants the repo-relative path, not the account, session and worktree
 * ids that lead to it. Patch parts and patch tool previews can also receive
 * the relative tail (`sessions/<id>/...`) once a caller has already joined a
 * path against the workspace root, so strip that form too.
 */
const ABSOLUTE_CLOUD_AGENT_PREFIX =
  /^.*\/workspace\/(?:[^/]+\/)?[^/]+\/(?:sessions|worktrees)\/[^/]+\//;
const CONTAINER_WORKSPACE_PREFIX = /^\/workspace\/app\//;
const RELATIVE_SESSION_PREFIX = /^(?:sessions|worktrees)\/[^/]+\//;

/** The repo-relative label for a path from a Cloud Agent workspace. */
export function cloudAgentFileLabel(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(ABSOLUTE_CLOUD_AGENT_PREFIX, '')
    .replace(CONTAINER_WORKSPACE_PREFIX, '')
    .replace(RELATIVE_SESSION_PREFIX, '');
}
