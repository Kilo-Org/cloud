/**
 * Cloud agent attachment reference shared by the web and mobile apps.
 *
 * R2 path structure: {bucket}/{userId}/{path}/{filename}
 */
export type CloudAgentAttachments = {
  path: string;
  files: string[];
};

/**
 * Cloud Agent workspaces put the repo inside an absolute, account-scoped
 * directory: `/workspace/<userId>/sessions/<sessionId>` for a session
 * workspace and `/workspace/<userId>/worktrees/<worktreeId>` for a
 * worktree-backed session, either optionally under an organization id
 * (`services/cloud-agent-next/src/workspace.ts:200-224`). The isolated
 * container layout clones at `/workspace/app`.
 *
 * A reader wants the repo-relative path, not the account, session and worktree
 * ids that lead to it. Patch parts and tool inputs can also carry the relative
 * tail (`sessions/<id>/...`) once a caller has already joined a path against
 * the workspace root, so strip that form too.
 */
const CONTAINER_WORKSPACE_ROOT = /^\/workspace\/app(?=\/|$)/;
const ABSOLUTE_CLOUD_AGENT_ROOT =
  /^.*\/workspace\/(?:[^/]+\/)?[^/]+\/(?:sessions|worktrees)\/(?:ses_|sess_|agent_|workspace_|worktree_)[^/]+(?=\/|$)/;
const RELATIVE_CLOUD_AGENT_ROOT =
  /^(?:sessions|worktrees)\/(?:ses_|sess_|agent_|workspace_|worktree_)[^/]+(?=\/|$)/;

/** The repo-relative label for a path from a Cloud Agent workspace. */
export function cloudAgentFileLabel(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const strippedRoot = normalized
    .replace(CONTAINER_WORKSPACE_ROOT, '')
    .replace(ABSOLUTE_CLOUD_AGENT_ROOT, '')
    .replace(RELATIVE_CLOUD_AGENT_ROOT, '');
  if (strippedRoot === normalized) return normalized;
  const relative = strippedRoot.replace(/^\//, '');
  return relative === '' ? '.' : relative;
}
