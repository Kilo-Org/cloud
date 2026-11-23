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
 * container layout clones at `/workspace/app`. The absolute form must lead the
 * path, so a repository-relative path that merely contains a
 * `/workspace/<name>/sessions/<id>` shape keeps its own directories.
 *
 * A reader wants the repo-relative path, not the account, session and worktree
 * ids that lead to it. Patch parts and tool inputs can also carry the relative
 * tail (`sessions/<id>/...`) once a caller has already joined a path against
 * the workspace root, so strip that form too.
 */
const CONTAINER_WORKSPACE_ROOT = /^\/workspace\/app(?=\/|$)/;
// This segment names a Kilo session, and every writer that produces one mints or
// validates the `ses_` prefix, so only that family reaches here. The private
// roots below name a workspace directory instead, which can carry any of the
// control plane's id families.
const PUBLIC_CLOUD_AGENT_ROOT = /^\/cloud-agent\/sessions\/ses_[^/]+(?=\/|$)/;
/** The two directory kinds a Cloud Agent workspace root can end with. */
const WORKSPACE_KIND = String.raw`sessions|worktrees`;
/** The session, worktree, and retired control plane id prefixes. */
const WORKSPACE_ID_PREFIX = String.raw`(?:ses_|sess_|agent_|workspace_|worktree_)`;
/** Every root pattern ends at a path separator or the end of the string. */
const ROOT_BOUNDARY = String.raw`(?=\/|$)`;
const ABSOLUTE_CLOUD_AGENT_ROOT = new RegExp(
  String.raw`^\/workspace\/(?:[^/]+\/)?[^/]+\/(?:` +
    WORKSPACE_KIND +
    String.raw`)\/` +
    WORKSPACE_ID_PREFIX +
    String.raw`[^/]+` +
    ROOT_BOUNDARY
);
const RELATIVE_CLOUD_AGENT_ROOT = new RegExp(
  String.raw`^(?:` +
    WORKSPACE_KIND +
    String.raw`)\/` +
    WORKSPACE_ID_PREFIX +
    String.raw`[^/]+` +
    ROOT_BOUNDARY
);

/** The repo-relative label for a path from a Cloud Agent workspace. */
export function cloudAgentFileLabel(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const strippedRoot = normalized
    .replace(PUBLIC_CLOUD_AGENT_ROOT, '')
    .replace(CONTAINER_WORKSPACE_ROOT, '')
    .replace(ABSOLUTE_CLOUD_AGENT_ROOT, '')
    .replace(RELATIVE_CLOUD_AGENT_ROOT, '');
  if (strippedRoot === normalized) return normalized;
  const relative = strippedRoot.replace(/^\//, '');
  return relative === '' ? '.' : relative;
}
