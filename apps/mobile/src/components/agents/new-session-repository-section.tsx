import { Fragment, type ReactElement } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from '@/components/ui/icons';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { QueryError } from '@/components/query-error';
import { RepoSelector } from '@/components/agents/repo-selector';
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
  groups: RepositoryGroup[];
  value: string;
};

const PROVIDER_COPY = {
  github: {
    connectTitle: 'agentChat.newSession.connectGithub',
    connectDescription: 'agentChat.newSession.connectGithubDescription',
    openLabel: 'agentChat.newSession.openGithub',
    connectedTitle: 'agentChat.newSession.githubConnected',
  },
  gitlab: {
    connectTitle: 'agentChat.newSession.connectGitlab',
    connectDescription: 'agentChat.newSession.connectGitlabDescription',
    openLabel: 'agentChat.newSession.openGitlab',
    connectedTitle: 'agentChat.newSession.gitlabConnected',
  },
  bitbucket: {
    connectTitle: 'agentChat.newSession.connectBitbucket',
    connectDescription: 'agentChat.newSession.connectBitbucketDescription',
    openLabel: 'agentChat.newSession.openBitbucket',
    connectedTitle: 'agentChat.newSession.bitbucketConnected',
  },
} satisfies Record<
  RepositoryPlatform,
  {
    connectTitle: string;
    connectDescription: string;
    openLabel: string;
    connectedTitle: string;
  }
>;

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
  groups,
  value,
}: Readonly<NewSessionRepositorySectionProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  const hasRepos = repositories.length > 0;
  const anyLoading = groups.some(group => group.status === 'loading');

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.repository')}
      </Text>

      {(hasRepos || anyLoading) && (
        <RepoSelector
          value={value}
          repositories={repositories}
          isLoading={!hasRepos && anyLoading}
          onChange={onChange}
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
              title={t('agentChat.newSession.couldNotLoadRepositories')}
              message={t('agentChat.instancePicker.couldNotLoadDescription')}
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
    return (
      <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">{t(copy.connectTitle)}</Text>
          <Text variant="muted">{t(copy.connectDescription)}</Text>
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
          <Text variant="muted">{t('agentChat.newSession.noRepositoriesVisible')}</Text>
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
