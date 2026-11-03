import { sameRepositoryIdentity } from '@kilocode/cloud-agent-profile';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { launchRepositoryIdentity, memberCloneUrl } from '../../session/environment-launch.js';
import type {
  ControlPlaneRouteGit,
  ControlPlaneWorkspaceRoot,
} from '../../shared/control-plane-protocol.js';
import { environmentWorkspace } from '../../shared/environment-workspace.js';
import { getControlPlaneSessionDirectory } from '../../workspace.js';

/**
 * Whether a root runs on the session's generated `kilo/<slug>` branch, rather
 * than on a branch somebody requested. A requested branch must exist on the
 * remote. A generated one is created when the remote has none, so only it is
 * checked out in `working` mode.
 */
export function rootBranchMode(
  branch: string,
  generatedBranch: string | undefined
): 'working' | undefined {
  return generatedBranch !== undefined && branch === generatedBranch ? 'working' : undefined;
}

/**
 * Where a session's repositories are checked out: the route directory (the Kilo
 * cwd) and, for a V2 environment, the git roots the wrapper clones. A V1 session
 * has no roots on the wire, so its route is what it was before V2.
 */
export function sessionWorkspace(
  metadata: SessionMetadata,
  launchGit: ControlPlaneRouteGit | undefined
): { directory: string; roots?: ControlPlaneWorkspaceRoot[] } {
  const launch =
    metadata.repository === undefined ? undefined : launchRepositoryIdentity(metadata.repository);
  const workspace = environmentWorkspace({
    sessionDirectory: getControlPlaneSessionDirectory({
      workspacePath: metadata.workspace?.workspacePath,
      sandboxId: metadata.workspace?.sandboxId,
      sandboxKind: metadata.workspace?.sandboxKind,
      orgId: metadata.identity.orgId,
      userId: metadata.identity.userId,
      sessionId: metadata.identity.sessionId,
    }),
    environment: metadata.environment,
    isLaunch: member => launch !== undefined && sameRepositoryIdentity(member.identity, launch),
  });
  const generatedBranch = metadata.workspace?.generatedBranchName;
  const roots = workspace.roots.flatMap((root): ControlPlaneWorkspaceRoot[] => {
    const { repository } = root;
    if (repository === null) return [];
    const url = root.launch && launchGit ? launchGit.url : memberCloneUrl(repository);
    const mode = rootBranchMode(repository.branch, generatedBranch);
    return [
      {
        directory: root.directory,
        repoFullName: repository.repoFullName,
        git: { url, platform: repository.identity.platform },
        branch: repository.branch,
        ...(mode ? { branchMode: mode } : {}),
      },
    ];
  });
  return { directory: workspace.cwd, ...(roots.length > 0 ? { roots } : {}) };
}
