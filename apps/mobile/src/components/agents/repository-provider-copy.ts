import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';

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
    // Bitbucket's connect card explains itself through the restriction note
    // (`connectCardOffer`): a workspace access token is pasted in the app's own
    // sheet, so there is no browser step left to announce.
    connectDescription: null,
    openLabel: 'common.connectBitbucket',
    connectedTitle: 'common.bitbucketConnected',
    errorTitle: 'agentChat.newSession.couldNotLoadBitbucketRepositories',
    emptyDescription: 'agentChat.newSession.noRepositoriesVisibleBitbucket',
  },
} satisfies Record<
  RepositoryPlatform,
  {
    connectTitle: string;
    /** Omitted when the card's own note says everything it needs to. */
    connectDescription: string | null;
    openLabel: string;
    connectedTitle: string;
    errorTitle: string;
    emptyDescription: string;
  }
>;

/** What one provider's connect card offers the member looking at it. */
export type ConnectCardOffer = {
  /** Whether the card renders its connect action. */
  offersAction: boolean;
  /** The restriction the card states outright, or `undefined` for none. */
  noteKey: string | undefined;
};

/**
 * The connect action and restriction note for one provider in this session's
 * scope.
 *
 * Bitbucket connects for an organization, never for a personal account, and
 * every one of its connect mutations takes organization billing authority, so
 * the card offers the action only where the server would accept it: an
 * organization session whose role may manage billing. A personal session keeps
 * the organizations-only note and offers no action, because the sheet behind it
 * can only explain that no organization is selected.
 *
 * `role` is `undefined` until the membership list answers. That state keeps the
 * action: the card never blocks on a verdict it does not have, and a member who
 * keeps the authority would otherwise watch the action arrive after the card had
 * painted. The new-session shell resolves the membership before it mounts this
 * section, so the unresolved state is a retry, not a first frame.
 */
export function connectCardOffer(
  platform: RepositoryPlatform,
  organizationId: string | undefined,
  role: string | undefined
): ConnectCardOffer {
  if (platform !== 'bitbucket') {
    return { offersAction: true, noteKey: undefined };
  }
  if (organizationId === undefined) {
    return {
      offersAction: false,
      noteKey: 'agentChat.newSession.bitbucketOrganizationsOnly',
    };
  }
  if (role !== undefined && !canManageOrganizationBilling(role)) {
    // The member cannot connect it, so the note names the roles that can and the
    // step left to them instead of an action that can only end in a refusal.
    return { offersAction: false, noteKey: 'prReview.connect.bitbucketAdminOnlyDescription' };
  }
  return {
    offersAction: true,
    noteKey: 'agentChat.newSession.bitbucketOrganizationsOnly',
  };
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
