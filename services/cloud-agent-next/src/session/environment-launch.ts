import {
  bitbucketCloneUrl,
  type EnvironmentRepositoryIdentity,
} from '@kilocode/cloud-agent-profile';
import { canonicalGitLabCloneUrl } from '@kilocode/worker-utils/git-url';
import type { SessionRepositoryRequest } from './session-requests.js';

/** The GitHub access purpose a launch repository request carries, in either request shape. */
type LaunchGitHubAccess = {
  type: string;
  githubAccessPurpose?: 'workflow' | 'agent' | undefined;
};

/**
 * The GitHub access of an environment member: the launch repository's access
 * purpose when the launch is a GitHub repository, and never its integration
 * pin. A pin names one installation, and the members of an environment may
 * belong to different installations, so a member is looked up across the
 * owner's connections. Without a pin the `agent` purpose behaves as `workflow`,
 * so a member that only an `agent_only` connection reaches is not found. Another
 * launch platform gives the default `workflow` purpose.
 */
export function memberGitHubAccess(launch: LaunchGitHubAccess | undefined): {
  githubAccessPurpose?: 'workflow' | 'agent';
} {
  if (launch?.type !== 'github' || !launch.githubAccessPurpose) return {};
  return { githubAccessPurpose: launch.githubAccessPurpose };
}

/**
 * The identity an environment is keyed by for the repository a session launches
 * on; none for a generic git repository. Preflight resolves the environment by
 * it, and session registration finds the launch repository among the
 * repositories of a V2 environment by it.
 */
export function launchRepositoryIdentity(
  repository: SessionRepositoryRequest
): EnvironmentRepositoryIdentity | undefined {
  switch (repository.type) {
    case 'github':
      return { platform: 'github', repoFullName: repository.repo };
    case 'gitlab': {
      const cloneUrl = canonicalGitLabCloneUrl(repository.url);
      return cloneUrl ? { platform: 'gitlab', cloneUrl } : undefined;
    }
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
      };
    case 'git':
      return undefined;
  }
}

/**
 * The credential-free HTTPS clone URL of an environment member. A GitLab member
 * keeps its canonical project URL, and a Bitbucket member's URL is built from its
 * `workspace/slug` name.
 */
export function memberCloneUrl(member: {
  identity: EnvironmentRepositoryIdentity;
  repoFullName: string;
}): string {
  switch (member.identity.platform) {
    case 'github':
      return `https://github.com/${member.repoFullName}.git`;
    case 'gitlab':
      return member.identity.cloneUrl;
    case 'bitbucket':
      return bitbucketCloneUrl(member.repoFullName);
  }
}
