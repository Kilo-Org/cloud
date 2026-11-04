import { type RepositoryPlatform } from './new-session-repository-state';

/**
 * Copy for one provider's repository states.
 */
export const PROVIDER_COPY = {
  github: {
    connectTitle: 'common.connectGithub',
    connectDescription: 'agentChat.newSession.connectGithubDescription',
    openLabel: 'agentChat.newSession.openGithub',
    connectedTitle: 'agentChat.newSession.githubConnected',
    errorTitle: 'agentChat.newSession.couldNotLoadGithubRepositories',
    emptyDescription: 'agentChat.newSession.noRepositoriesVisible',
  },
  gitlab: {
    connectTitle: 'common.connectGitlab',
    connectDescription: 'agentChat.newSession.connectGitlabDescription',
    openLabel: 'agentChat.newSession.openGitlab',
    connectedTitle: 'agentChat.newSession.gitlabConnected',
    errorTitle: 'agentChat.newSession.couldNotLoadGitlabRepositories',
    emptyDescription: 'agentChat.newSession.noRepositoriesVisibleGitlab',
  },
  bitbucket: {
    connectTitle: 'common.connectBitbucket',
    connectDescription: 'agentChat.newSession.connectBitbucketDescription',
    openLabel: 'agentChat.newSession.openBitbucket',
    connectedTitle: 'common.bitbucketConnected',
    errorTitle: 'agentChat.newSession.couldNotLoadBitbucketRepositories',
    emptyDescription: 'agentChat.newSession.noRepositoriesVisibleBitbucket',
  },
} satisfies Record<
  RepositoryPlatform,
  {
    connectTitle: string;
    connectDescription: string;
    openLabel: string;
    connectedTitle: string;
    errorTitle: string;
    emptyDescription: string;
  }
>;

/**
 * The restriction a provider's connect card must state outright. Bitbucket
 * connects for an organization, never for a personal account, so "connect it"
 * can never read as a promise that a personal session will get Bitbucket
 * repositories — or their branches.
 */
export function connectNoteKey(platform: RepositoryPlatform): string | undefined {
  return platform === 'bitbucket' ? 'agentChat.newSession.bitbucketOrganizationsOnly' : undefined;
}
/**
 * Copy for a provider whose stored installation exists but cannot list
 * repositories. Only a provider API that reports the reason answers here:
 * guessing one for another provider would ask for a reconnect step nobody
 * diagnosed.
 */
export function providerNeedsAttentionCopy(
  platform: RepositoryPlatform
): { title: string; description: string } | null {
  return platform === 'github'
    ? {
        title: 'agentChat.newSession.githubNeedsAttention',
        description: 'agentChat.newSession.githubNeedsAttentionDescription',
      }
    : null;
}

/** Copy for a provider that answered with only some of its installations. */
export function providerPartialNoticeKey(platform: RepositoryPlatform): string | null {
  return platform === 'github' ? 'agentChat.newSession.partialRepositories' : null;
}
