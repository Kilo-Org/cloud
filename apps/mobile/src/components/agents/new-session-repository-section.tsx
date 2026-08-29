import { Fragment, type ReactElement, useEffect, useRef } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from '@/components/ui/icons';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { QueryError } from '@/components/query-error';
import { RepoSelector } from '@/components/agents/repo-selector';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useTRPC } from '@/lib/trpc';
import { withRepositoryAccount } from '@/lib/use-github-repos-refresh';
import { REPO_PLATFORM_LABEL_KEYS } from '@/lib/picker-bridge';
import { RepositoryBranchSelector } from './repository-branch-selector';
import {
  type NewSessionRepository,
  type RepositoryGroup,
  type RepositoryPlatform,
} from './new-session-repository-state';

type NewSessionRepositorySectionProps = {
  disabled: boolean;
  isRetrying: boolean;
  onChange: (key: string) => void;
  onConnect: (platform: RepositoryPlatform) => void;
  onRefreshRepos: () => void;
  repositories: NewSessionRepository[];
  recents: NewSessionRepository[];
  groups: RepositoryGroup[];
  value: string;
};

const PROVIDER_COPY = {
  github: {
    connectTitle: 'agentChat.newSession.connectGithub',
    connectDescription: 'agentChat.newSession.connectGithubDescription',
    openLabel: 'agentChat.newSession.openGithub',
    connectedTitle: 'agentChat.newSession.githubConnected',
    errorTitle: 'agentChat.newSession.couldNotLoadGithubRepositories',
    emptyDescription: 'agentChat.newSession.noRepositoriesVisible',
  },
  gitlab: {
    connectTitle: 'agentChat.newSession.connectGitlab',
    connectDescription: 'agentChat.newSession.connectGitlabDescription',
    openLabel: 'agentChat.newSession.openGitlab',
    connectedTitle: 'agentChat.newSession.gitlabConnected',
    errorTitle: 'agentChat.newSession.couldNotLoadGitlabRepositories',
    emptyDescription: 'agentChat.newSession.noRepositoriesVisibleGitlab',
  },
  bitbucket: {
    connectTitle: 'agentChat.newSession.connectBitbucket',
    connectDescription: 'agentChat.newSession.connectBitbucketDescription',
    openLabel: 'agentChat.newSession.openBitbucket',
    connectedTitle: 'agentChat.newSession.bitbucketConnected',
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
  const selected = repositories.find(repo => repo.key === value);
  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.repository')}
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
      <AccessibleStatus
        message={value && !selected ? t('agentChat.newSession.repositoryUnavailable') : null}
      />
      {selected ? (
        <RepositoryBranchSelector
          disabled={disabled}
          onConnect={() => {
            onConnect(selected.platform);
          }}
          connectLabel={t(PROVIDER_COPY[selected.platform].openLabel)}
        />
      ) : null}
      {groups.map(group => (
        <Fragment key={group.key}>{renderGroupCard(group.key, group.status)}</Fragment>
      ))}
      {!groups.some(group => group.key === 'bitbucket') ? (
        <PersonalBitbucketNotice disabled={disabled} />
      ) : null}
    </View>
  );

  function renderGroupCard(
    platform: RepositoryPlatform,
    status: RepositoryGroup['status']
  ): ReactElement | null {
    const copy = PROVIDER_COPY[platform];
    if (status === 'repos') {
      return null;
    }
    if (status === 'loading') {
      return (
        <View className="mt-3 flex-row items-center gap-2" accessibilityState={{ busy: true }}>
          <ActivityIndicator accessible={false} size="small" color={colors.mutedForeground} />
          <AccessibleStatus
            tone="status"
            className="flex-1"
            message={t('agentChat.newSession.loadingRepositories', {
              provider: t(REPO_PLATFORM_LABEL_KEYS[platform]),
            })}
          />
        </View>
      );
    }
    if (status === 'error' || status === 'identity-unavailable') {
      return (
        <View className="mt-3">
          <QueryError
            placement="top"
            variant="server"
            title={t(copy.errorTitle)}
            message={t(
              status === 'identity-unavailable'
                ? 'agentChat.newSession.repositoryIdentityUnavailable'
                : 'agentChat.instancePicker.couldNotLoadDescription'
            )}
            onRetry={onRefreshRepos}
            isRetrying={isRetrying}
          />
        </View>
      );
    }
    const connectedEmpty = status === 'connected-empty';
    const description = connectedEmpty ? copy.emptyDescription : copy.connectDescription;
    return (
      <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">
            {t(connectedEmpty ? copy.connectedTitle : copy.connectTitle)}
          </Text>
          <AccessibleStatus
            tone={status === 'access-denied' ? 'error' : 'status'}
            message={t(
              status === 'access-denied'
                ? 'agentChat.newSession.repositoryAccessDenied'
                : description
            )}
          />
        </View>
        <View className="flex-row gap-2">
          <Button
            variant="outline"
            className="min-h-12 flex-1"
            disabled={disabled}
            onPress={() => {
              onConnect(platform);
            }}
          >
            <ExternalLink size={16} color={colors.foreground} />
            <Text>{t(copy.openLabel)}</Text>
          </Button>
          {status !== 'access-denied' ? (
            <Button
              variant="outline"
              className="min-h-12 min-w-12"
              size="icon"
              onPress={onRefreshRepos}
              disabled={isRetrying || disabled}
              accessibilityLabel={t('agentChat.newSession.refreshRepositories')}
            >
              {isRetrying ? (
                <ActivityIndicator size="small" color={colors.foreground} />
              ) : (
                <RefreshCw size={16} color={colors.foreground} />
              )}
            </Button>
          ) : null}
        </View>
      </View>
    );
  }
}

function PersonalBitbucketNotice({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const router = useRouter();
  const { userId } = useCurrentUserId();
  const currentAccount = useRef<string | undefined>(userId);
  currentAccount.current = userId;
  useEffect(() => {
    currentAccount.current = userId;
    return () => {
      currentAccount.current = undefined;
    };
  }, [userId]);
  const { showActionSheetWithOptions } = useActionSheet();
  const query = useQuery({
    ...withRepositoryAccount(trpc.organizations.list.queryOptions(), userId),
    enabled: Boolean(userId),
  });
  const organizations = query.data ?? [];
  return (
    <View className="mt-3 gap-2">
      <Text className="text-sm text-muted-foreground">
        {t('agentChat.newSession.personalBitbucket')}
      </Text>
      {query.isError ? (
        <QueryError
          placement="top"
          onRetry={() => {
            void query.refetch();
          }}
          isRetrying={query.isFetching}
        />
      ) : null}
      {organizations.length > 0 ? (
        <Button
          variant="outline"
          disabled={disabled}
          onPress={() => {
            showActionSheetWithOptions(
              {
                title: t('profile.selectAccount'),
                options: [...organizations.map(org => org.organizationName), t('common.cancel')],
                cancelButtonIndex: organizations.length,
              },
              index => {
                const organization = index === undefined ? undefined : organizations[index];
                if (organization && currentAccount.current === userId) {
                  router.setParams({ organizationId: organization.organizationId });
                }
              }
            );
          }}
        >
          <Text>{t('providerReview.connection.switchOrganization')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
