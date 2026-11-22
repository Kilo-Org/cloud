import { repositoryLeaf, sameRepositoryIdentity } from '@kilocode/cloud-agent-profile';
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
 * The shared checkout layout for route preparation and worktree capture.
 */
export function sessionWorkspaceLayout(
  metadata: SessionMetadata,
  sessionDirectory = getControlPlaneSessionDirectory({
    workspacePath: metadata.workspace?.workspacePath,
    sandboxId: metadata.workspace?.sandboxId,
    sandboxKind: metadata.workspace?.sandboxKind,
    orgId: metadata.identity.orgId,
    userId: metadata.identity.userId,
    sessionId: metadata.identity.sessionId,
  })
) {
  const hosted = metadata.hostedGitHubRepositories;
  if (hosted) {
    const generatedBranch = metadata.workspace?.generatedBranchName;
    if (generatedBranch === undefined)
      throw new Error('Hosted workspace is missing its generated branch');
    return environmentWorkspace({
      sessionDirectory,
      environment: {
        repositories: [hosted.primary, ...hosted.additional].map(({ id, fullName }) => ({
          id,
          identity: { platform: 'github' as const, repoFullName: fullName },
          repoFullName: fullName,
          leaf: repositoryLeaf(fullName),
          branch:
            id === hosted.primary.id
              ? (metadata.workspace?.branchName ??
                metadata.repository?.upstreamBranch ??
                generatedBranch)
              : generatedBranch,
        })),
      },
      isLaunch: member => member.id === hosted.primary.id,
    });
  }
  const launch =
    metadata.repository === undefined ? undefined : launchRepositoryIdentity(metadata.repository);
  return environmentWorkspace({
    sessionDirectory,
    environment: metadata.environment,
    isLaunch: member => launch !== undefined && sameRepositoryIdentity(member.identity, launch),
  });
}

export function sessionWorkspace(
  metadata: SessionMetadata,
  launchGit: ControlPlaneRouteGit | undefined
): { directory: string; roots?: ControlPlaneWorkspaceRoot[] } {
  const workspace = sessionWorkspaceLayout(metadata);
  const generatedBranch = metadata.workspace?.generatedBranchName;
  const baseBranch = metadata.repository?.baseBranch;
  const baseSha = metadata.repository?.baseSha;
  const roots = workspace.roots.flatMap((root): ControlPlaneWorkspaceRoot[] => {
    const { repository } = root;
    if (repository === null) return [];
    const url = root.launch && launchGit ? launchGit.url : memberCloneUrl(repository);
    const mode =
      root.launch && metadata.hostedGitHubRepositories && metadata.repository?.upstreamBranch
        ? undefined
        : rootBranchMode(repository.branch, generatedBranch);
    return [
      {
        directory: root.directory,
        repoFullName: repository.repoFullName,
        git: { url, platform: repository.identity.platform },
        branch: repository.branch,
        ...(mode ? { branchMode: mode } : {}),
        // A stacked base names a branch of the launch repository only.
        ...(root.launch && baseBranch !== undefined ? { baseBranch } : {}),
        ...(root.launch && baseSha !== undefined ? { baseSha } : {}),
      },
    ];
  });
  return { directory: workspace.cwd, ...(roots.length > 0 ? { roots } : {}) };
}
