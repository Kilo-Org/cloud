import { Fragment, type ReactElement, useEffect } from 'react';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from '@/components/ui/icons';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { QueryError } from '@/components/query-error';
import { RepoSelector } from '@/components/agents/repo-selector';
import { RepositoryBranchSelector } from '@/components/agents/repository-branch-selector';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type NewSessionRepository,
  type RepositoryGroup,
  type RepositoryPlatform,
  resetSelectedBranchOverrides,
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
 * connect/empty/error state independently, and the picker trigger lists every
 * repository plus the Recently used rows when any provider has rows.
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
}: Readonly<NewSessionRepositorySectionProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  const hasRepos = repositories.length > 0;
  const anyLoading = groups.some(group => group.status === 'loading');

  // The picker reports `platform:fullName`; resolve it to the row so the branch
  // selector queries (and keys) the full repository identity. The prefill seeds
  // the same platform-qualified key, so no bare-fullName fallback is needed —
  // one would bind a same-named row on another provider.
  const selectedRepository =
    repositories.find(repository => `${repository.platform}:${repository.fullName}` === value) ??
    null;

  // The branch choice belongs to this screen: clear it when the section mounts
  // and when it goes away, so a branch picked for one draft can never reach the
  // next one.
  useEffect(() => {
    resetSelectedBranchOverrides();
    return resetSelectedBranchOverrides;
  }, []);

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
          onChange={onChange}
          disabled={disabled}
        />
      )}

      <RepositoryBranchSelector repository={selectedRepository} disabled={disabled} />

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
        return renderConnectCard(platform);
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
    return (
      <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">{t(copy.connectTitle)}</Text>
          <Text variant="muted">{t(copy.connectDescription)}</Text>
          {noteKey ? <Text variant="muted">{t(noteKey)}</Text> : null}
        </View>
        <View className="flex-row gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onPress={() => {
              onConnect(platform);
            }}
          >
            <ExternalLink size={16} color={colors.foreground} />
            <Text>{t(copy.openLabel)}</Text>
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
