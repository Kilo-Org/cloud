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
  /**
   * The same restriction for the compact row after a repository is selected.
   * That row has no title, so its first-connect copy names the provider itself
   * where the card leans on its header for that.
   */
  compactNoteKey: string | undefined;
  /**
   * A subject line the compact row states above `compactNoteKey` when that
   * note's only subject is a pronoun. The reconnect sentence is provider
   * neutral (the sheet shows it above a title that names the provider), so the
   * headerless row supplies that name itself instead of leaving "it" unbound.
   */
  compactContextKey: string | undefined;
};

/**
 * The connect action and restriction note for one provider.
 *
 * Bitbucket connects for an organization, never for a personal account, and
 * every one of its connect mutations takes organization billing authority, so
 * the card offers the action only where the server would accept it. The
 * Bitbucket group itself exists only in an organization session
 * (`resolveRepositoryGroups`), so this decides among organization members.
 *
 * `role` is `undefined` until the membership list answers. That state keeps the
 * action on purpose: the card never blocks on a verdict it does not have, and
 * refusing one a member may hold would read worse than the delay. The list is
 * the same one the new-session shell already reads, so this is a retry path and
 * not the first frame; when it does answer late, the card's note and action
 * settle in one change instead of the card appearing inert first.
 *
 * `needsReconnect` is the Bitbucket answer naming a connected workspace that
 * still needs a selection or fresh credentials, which `bitbucketRowsUnlisted`
 * reports. Those states map to the same `connect` status as "not connected",
 * but the step left is a reconnect, not a first connect, so the note asks for
 * the former instead of claiming the provider was never connected. The sheet
 * the card opens says the same thing.
 */
export function connectCardOffer(
  platform: RepositoryPlatform,
  role: string | undefined,
  needsReconnect = false
): ConnectCardOffer {
  if (platform !== 'bitbucket') {
    return {
      offersAction: true,
      noteKey: undefined,
      compactNoteKey: undefined,
      compactContextKey: undefined,
    };
  }
  if (role !== undefined && !canManageOrganizationBilling(role)) {
    // The member cannot connect it, so the note names the roles that can and the
    // step left to them instead of an action that can only end in a refusal.
    if (needsReconnect) {
      // The workspace is connected but cannot list: the step is a fresh
      // selection or credentials, so the reconnect sentence applies. Both notes
      // carry Bitbucket's own provider-neutral copy, so a GitLab reword cannot
      // change this card; neither note has a header to explain which connect
      // step is left, and the compact row states the provider name above it,
      // since that sentence's only subject is a pronoun.
      return {
        offersAction: false,
        noteKey: 'prReview.connect.bitbucketReconnectAdminOnlyDescription',
        compactNoteKey: 'prReview.connect.bitbucketReconnectAdminOnlyDescription',
        compactContextKey: 'prReview.connect.reconnectTitleBitbucket',
      };
    }
    return {
      offersAction: false,
      noteKey: 'prReview.connect.bitbucketAdminOnlyDescription',
      // The compact row carries no header, so this copy names Bitbucket itself.
      compactNoteKey: 'codeReviewer.bitbucket.notConnectedReadOnly',
      compactContextKey: undefined,
    };
  }
  return {
    offersAction: true,
    noteKey: 'agentChat.newSession.bitbucketOrganizationsOnly',
    compactNoteKey: 'agentChat.newSession.bitbucketOrganizationsOnly',
    compactContextKey: undefined,
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
