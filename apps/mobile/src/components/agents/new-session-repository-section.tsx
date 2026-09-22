import { Fragment, type ReactElement } from 'react';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from '@/components/ui/icons';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { QueryError } from '@/components/query-error';
import { RepoSelector } from '@/components/agents/repo-selector';
import { RepositoryBranchSelector } from '@/components/agents/repository-branch-selector';
import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import {
  setConnectCtaCollapsed,
  useCollapsedConnectCtas,
} from '@/lib/hooks/use-collapsed-connect-ctas-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type NewSessionRepository,
  type RepositoryGroup,
  type RepositoryPlatform,
} from './new-session-repository-state';

type NewSessionRepositorySectionProps = {
  disabled: boolean;
  isRetrying: boolean;
  onChange: (fullName: string) => void;
  onConnect: (platform: RepositoryPlatform) => void;
  onRefreshRepos: () => void;
  repositories: NewSessionRepository[];
  /** Recently used rows for the picker's "Recently used" section. */
  recents: NewSessionRepository[];
  groups: RepositoryGroup[];
  value: string;
  /**
   * The route's organization scope; `undefined` is a personal session. The
   * branch query and the picker's Bitbucket note read it from here, so both
   * match the rows this section was given.
   */
  organizationId: string | undefined;
  /**
   * The Continue clone entry reuses the repository picker but submits through
   * the clone path, which has no `upstreamBranch` field: a branch row there
   * would show a choice the submit silently drops, so it is not rendered.
   */
  isCloneEntry: boolean;
};

const PROVIDER_COPY = {
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
function connectNoteKey(platform: RepositoryPlatform): string | undefined {
  return platform === 'bitbucket' ? 'agentChat.newSession.bitbucketOrganizationsOnly' : undefined;
}

/**
 * Provider-aware repository section. One group per provider renders its own
 * empty/error state independently, and the picker trigger lists every
 * repository plus the Recently used rows when any provider has rows. A
 * provider's expanded connect prompt renders only before a repository is
 * selected. Afterwards, compact actions keep other providers reachable without
 * contradicting the completed selection or requiring it to be cleared.
 */
export function NewSessionRepositorySection({
  disabled,
  isRetrying,
  onChange,
  onConnect,
  onRefreshRepos,
  repositories,
  recents,
  groups,
  value,
  organizationId,
  isCloneEntry,
}: Readonly<NewSessionRepositorySectionProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { collapsedCtas, hasLoaded: collapseStateLoaded } = useCollapsedConnectCtas();

  const hasRepos = repositories.length > 0;
  const anyLoading = groups.some(group => group.status === 'loading');

  // The picker reports `platform:fullName`; resolve it to the row so the branch
  // selector queries (and keys) the full repository identity. The prefill seeds
  // the same platform-qualified key, so no bare-fullName fallback is needed —
  // one would bind a same-named row on another provider.
  const selectedRepository =
    repositories.find(repository => `${repository.platform}:${repository.fullName}` === value) ??
    null;

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('common.repository')}
      </Text>

      {(hasRepos || anyLoading) && (
        <RepoSelector
          value={value}
          repositories={repositories}
          recents={recents}
          isLoading={!hasRepos && anyLoading}
          organizationId={organizationId ?? null}
          onChange={onChange}
          disabled={disabled}
        />
      )}

      {isCloneEntry ? null : (
        <RepositoryBranchSelector
          repository={selectedRepository}
          organizationId={organizationId}
          disabled={disabled}
        />
      )}

      {groups.map(group => (
        <Fragment key={group.key}>{renderGroupCard(group.key, group.status)}</Fragment>
      ))}
    </View>
  );

  function renderGroupCard(
    platform: RepositoryPlatform,
    status: RepositoryGroup['status']
  ): ReactElement | null {
    switch (status) {
      case 'connect': {
        const noteKey = connectNoteKey(platform);
        return selectedRepository === null ? (
          renderConnectCard(platform)
        ) : (
          <View className="mt-3 gap-2">
            {noteKey ? <Text variant="muted">{t(noteKey)}</Text> : null}
            {renderConnectActions(platform)}
          </View>
        );
      }
      case 'connected-empty': {
        return renderConnectedEmptyCard(platform);
      }
      case 'error': {
        return (
          <View className="mt-3">
            <QueryError
              placement="top"
              variant="server"
              title={t(PROVIDER_COPY[platform].errorTitle)}
              message={t('organization.boundary.loadErrorMessage')}
              onRetry={onRefreshRepos}
              isRetrying={isRetrying}
            />
          </View>
        );
      }
      case 'loading': {
        return null;
      }
      case 'repos': {
        return null;
      }
      default: {
        return null;
      }
    }
  }

  function renderConnectCard(platform: RepositoryPlatform): ReactElement | null {
    const copy = PROVIDER_COPY[platform];
    const noteKey = connectNoteKey(platform);
    // The persisted flag decides the card's height, so the card must not paint
    // expanded and then snap shut when the disk read lands (every row below it
    // would move). The read is already in flight from module import, so this
    // gate lasts a frame, not a spinner.
    if (!collapseStateLoaded) {
      return null;
    }
    return (
      <CollapsibleSection
        className="mt-3 gap-3 rounded-lg border border-border bg-card p-4"
        contentClassName="gap-3"
        titleClassName="font-semibold"
        title={t(copy.connectTitle)}
        // The branch row mounts above this card once a repository is chosen; a
        // layout transition would paint the card over it, hiding the row.
        animateLayout={false}
        expanded={!collapsedCtas.includes(platform)}
        onToggle={() => {
          setConnectCtaCollapsed(platform, !collapsedCtas.includes(platform));
        }}
      >
        <View className="gap-1">
          <Text variant="muted">{t(copy.connectDescription)}</Text>
          {noteKey ? <Text variant="muted">{t(noteKey)}</Text> : null}
        </View>
        {renderConnectActions(platform)}
      </CollapsibleSection>
    );
  }

  function renderConnectActions(platform: RepositoryPlatform): ReactElement {
    const copy = PROVIDER_COPY[platform];
    // The label takes the row's remaining width and is pinned to one line: a
    // label sized to its own content is measured at its longest word's width
    // and wraps onto a second line the button's min height then clips. Its
    // trailing (inline-end) margin mirrors the glyph and the row gap, so the
    // centred label stays on the button's own centre. The margin is logical,
    // not physical: in RTL the row mirrors the glyph to the leading edge and
    // React Native resolves `marginInlineEnd` to `marginLeft`, while a physical
    // `marginRight` would push the label 24px the wrong way.
    return (
      <View className="flex-row gap-2">
        <Button
          variant="outline"
          className="flex-1"
          onPress={() => {
            onConnect(platform);
          }}
        >
          <ExternalLink size={16} color={colors.foreground} />
          {/*
            The label owns the row's remaining width and is pinned to one line.
            A box sized to the label's own measured width is a fraction narrower
            than the glyphs Android lays out, so "Open GitLab" wrapped onto two
            lines and grew the button taller than its one-line siblings; giving
            the label the free space keeps its box wider than the text, and
            `numberOfLines` pins the line. The explorer captures
            new-session-filled and new-session-kb-down both showed that wrap.
          */}
          <Text className="me-[24px] flex-1 text-center" numberOfLines={1}>
            {t(selectedRepository === null ? copy.openLabel : copy.connectTitle)}
          </Text>
        </Button>
        <Button
          variant="outline"
          size="icon"
          onPress={onRefreshRepos}
          disabled={isRetrying}
          accessibilityLabel={t('agentChat.newSession.refreshRepositories')}
        >
          {isRetrying ? (
            <ActivityIndicator size="small" color={colors.foreground} />
          ) : (
            <RefreshCw size={16} color={colors.foreground} />
          )}
        </Button>
      </View>
    );
  }

  function renderConnectedEmptyCard(platform: RepositoryPlatform): ReactElement | null {
    const copy = PROVIDER_COPY[platform];
    return (
      <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">{t(copy.connectedTitle)}</Text>
          <Text variant="muted">{t(copy.emptyDescription)}</Text>
        </View>
        <View className="flex-row gap-2">
          <Button
            variant="outline"
            size="icon"
            onPress={onRefreshRepos}
            disabled={isRetrying}
            accessibilityLabel={t('agentChat.newSession.refreshRepositories')}
          >
            {isRetrying ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : (
              <RefreshCw size={16} color={colors.foreground} />
            )}
          </Button>
        </View>
      </View>
    );
  }
}
