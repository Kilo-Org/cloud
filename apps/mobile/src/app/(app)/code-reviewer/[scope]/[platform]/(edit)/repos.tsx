import { type Href, useNavigation } from 'expo-router';
import { FolderGit2 } from '@/components/ui/icons';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { AppState, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CenteredState } from '@/components/centered-state';
import { RepositorySyncFooter } from '@/components/code-reviewer/repository-sync-footer';
import { EmptyState } from '@/components/empty-state';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { RepoToggleRow } from '@/components/repo-toggle-row';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { RefreshControl } from '@/components/ui/refresh-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { PLATFORM_CAPABILITIES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import {
  useBitbucketReadiness,
  useGitHubRepositories,
  useGitLabRepositories,
  useReviewConfig,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { useManageRepositoryAccess } from '@/lib/hooks/use-code-reviewer-manage-access';
import {
  type SyncedRepoPlatform,
  useReviewerRepositoriesResync,
} from '@/lib/hooks/use-code-reviewer-repo-sync';
import { useRepoSelectionToggle } from '@/lib/hooks/use-code-reviewer-repo-selection';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';
import { getBitbucketIntegrationUrl } from '@/lib/integration-urls';
import { parseTimestamp, timeAgo } from '@/lib/utils';

export default function ReposRoute() {
  const params = useReviewerRouteParams();
  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }
  return <ReposScreen scope={params.scope} platform={params.platform} />;
}

function ReposScreen({ scope, platform }: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const toggleRepo = useRepoSelectionToggle(scope, platform);
  const { t } = useTranslation();
  const capabilities = PLATFORM_CAPABILITIES[platform];
  const mode = data?.repositorySelectionMode ?? 'all';
  const githubRepos = useGitHubRepositories(scope, platform === 'github' && mode === 'selected');
  const gitlabRepos = useGitLabRepositories(scope, platform === 'gitlab');
  const bitbucketReadiness = useBitbucketReadiness(scope);
  const bitbucketRepos =
    bitbucketReadiness.data?.repositoryCache.status === 'available'
      ? bitbucketReadiness.data.repositoryCache.repositories.map(repo => ({
          id: repo.id,
          fullName: repo.fullName,
          private: repo.private,
        }))
      : [];
  const reposByPlatform = {
    github: {
      isLoading: githubRepos.isLoading,
      isError: githubRepos.isError,
      isFetching: githubRepos.isFetching,
      refetch: () => void githubRepos.refetch(),
      // The cached snapshot's sync time still answers the "how old is this
      // list" question, so a read that did not force a provider call shows it.
      syncedAt: githubRepos.data?.syncedAt ?? null,
      rows: githubRepos.data?.repositories ?? [],
    },
    gitlab: {
      isLoading: gitlabRepos.isLoading,
      isError: gitlabRepos.isError,
      isFetching: gitlabRepos.isFetching,
      refetch: () => void gitlabRepos.refetch(),
      syncedAt: gitlabRepos.data?.syncedAt ?? null,
      rows: gitlabRepos.data?.repositories ?? [],
    },
    bitbucket: {
      isLoading: bitbucketReadiness.isLoading,
      isError: bitbucketReadiness.isError,
      isFetching: bitbucketReadiness.isFetching,
      refetch: () => void bitbucketReadiness.refetch(),
      // Bitbucket's workspace snapshot carries no sync timestamp.
      syncedAt: null,
      rows: bitbucketRepos,
    },
  };
  const {
    isLoading: reposLoading,
    isError: reposError,
    isFetching: reposFetching,
    refetch: refetchRepos,
    rows: repoRows,
    syncedAt,
  } = reposByPlatform[platform];
  const selectedIds = data?.selectedRepositoryIds ?? [];
  const configDisabled = data == null;
  const bitbucketNotReady =
    platform === 'bitbucket' && bitbucketReadiness.data?.repositoryCache.status !== 'available';
  const confirmedEmpty =
    !reposLoading && !reposError && !bitbucketNotReady && repoRows.length === 0;
  const resyncPlatform: SyncedRepoPlatform = platform === 'gitlab' ? 'gitlab' : 'github';
  const { resync, resyncing } = useReviewerRepositoriesResync(scope, resyncPlatform);
  const openManageAccess = useManageRepositoryAccess(scope, platform);
  // Set when the user leaves for the provider's settings page: the return trip
  // is the moment installation access may have widened, so it forces a sync.
  const pendingAccessChange = useRef(false);
  const navigation = useNavigation();
  const flushPendingSync = useCallback(() => {
    if (!pendingAccessChange.current) {
      return;
    }
    pendingAccessChange.current = false;
    void resync();
  }, [resync]);
  const manageAccess = openManageAccess
    ? () => {
        pendingAccessChange.current = true;
        // Two return signals reach here and only the first one syncs: the
        // awaited browser dismissal (the only one iOS reports, because its
        // settings page opens in-app) and the next foreground (Android).
        void (async () => {
          try {
            await openManageAccess();
          } finally {
            flushPendingSync();
          }
        })();
      }
    : undefined;
  const refreshing = platform === 'bitbucket' ? reposFetching : resyncing;
  const refreshRepositories = () => {
    if (platform === 'bitbucket') {
      refetchRepos();
      return;
    }
    void resync();
  };
  // The label is relative, so it must be derived from a clock the render
  // traces: a live `Date.now()` read inside render is memoized with unchanged
  // props and the on-screen text freezes at its first value.
  const now = useNowTicker(10_000);
  const syncedLabel = syncedAt
    ? t('securityAgent.dashboard.lastSynced', {
        time: timeAgo(parseTimestamp(syncedAt), undefined, now),
      })
    : null;
  const emptyStateCopyByPlatform = {
    github: {
      title: t('codeReviewer.repos.installGithubApp'),
      description: t('codeReviewer.repos.installGithubAppDescription'),
    },
    gitlab: {
      title: t('common.noRepositoriesFound'),
      description: t('codeReviewer.repos.gitlabNoRepositoriesDescription'),
    },
    bitbucket: {
      title: t('common.noRepositoriesFound'),
      description: t('codeReviewer.repos.bitbucketNoRepositoriesDescription'),
    },
  } satisfies Record<ReviewerPlatform, { title: string; description: string }>;
  const emptyStateCopy = emptyStateCopyByPlatform[platform];

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active' || !navigation.isFocused()) {
        return;
      }
      flushPendingSync();
    });
    return () => {
      subscription.remove();
    };
  }, [flushPendingSync, navigation]);

  const setMode = (nextMode: 'all' | 'selected') => {
    save.mutate({ repositorySelectionMode: nextMode });
  };

  const fullBodyState = !capabilities.selectionModePicker && !reposLoading && repoRows.length === 0;
  let repoState: ReactNode = null;
  if (!reposLoading && reposError) {
    repoState = (
      <QueryError
        variant="server"
        placement={fullBodyState ? 'center' : 'top'}
        title={t('common.couldNotLoadRepositories')}
        onRetry={refetchRepos}
        isRetrying={reposFetching}
      />
    );
  } else if (!reposLoading && bitbucketNotReady) {
    repoState = (
      <CenteredState>
        <View className="items-center gap-2 px-6">
          <Text variant="muted" className="text-center text-xs">
            {t('codeReviewer.repos.unavailable')}
          </Text>
          <Button
            variant="outline"
            size="sm"
            onPress={() => {
              void openExternalUrl(getBitbucketIntegrationUrl(WEB_BASE_URL, scope), {
                label: t('codeReviewer.bitbucket.setup'),
              });
            }}
          >
            <Text>{t('codeReviewer.repos.finishSetup')}</Text>
          </Button>
        </View>
      </CenteredState>
    );
  } else if (confirmedEmpty) {
    repoState = (
      <EmptyState
        placement={fullBodyState ? 'center' : 'top'}
        icon={FolderGit2}
        title={emptyStateCopy.title}
        description={emptyStateCopy.description}
        action={
          manageAccess ? (
            <Button className={STATE_ACTION_CLASS} variant="outline" onPress={manageAccess}>
              <Text>{t('codeReviewer.repos.manageAccess')}</Text>
            </Button>
          ) : undefined
        }
      />
    );
  }

  const showRepositoryFooter =
    !reposLoading && !reposError && !bitbucketNotReady && repoRows.length > 0;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.repositories')} />
      {fullBodyState ? (
        repoState
      ) : (
        <TabScreenScrollView
          className="flex-1"
          contentContainerClassName="px-6 pt-4"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refreshRepositories} />
          }
        >
          {capabilities.selectionModePicker && (
            <RadioGroup label={t('common.repositories')}>
              {(['all', 'selected'] as const).map(option => (
                <ChoiceRow
                  key={option}
                  label={
                    option === 'all'
                      ? t('common.allRepositories')
                      : t('common.selectedRepositories')
                  }
                  selected={mode === option}
                  disabled={configDisabled}
                  className="border-b-[0.5px] border-hair-soft"
                  onPress={() => {
                    setMode(option);
                  }}
                />
              ))}
            </RadioGroup>
          )}

          {(!capabilities.selectionModePicker || mode === 'selected') && (
            <View className={capabilities.selectionModePicker ? 'mt-6' : undefined}>
              <Text variant="small" className="mb-1 uppercase tracking-wide text-muted-foreground">
                {t('common.repositories')}
              </Text>
              {reposLoading && (
                <View className="gap-3 pt-2">
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-12 w-full rounded-lg" />
                </View>
              )}

              {repoState}

              {repoRows.map(repo => (
                <RepoToggleRow
                  key={repo.id}
                  repo={repo}
                  selected={selectedIds.includes(repo.id)}
                  disabled={configDisabled}
                  className="border-b-[0.5px] border-hair-soft"
                  onPress={() => {
                    toggleRepo(repo.id);
                  }}
                />
              ))}

              {showRepositoryFooter && (
                <RepositorySyncFooter
                  syncedLabel={syncedLabel}
                  refreshing={refreshing}
                  onRefresh={refreshRepositories}
                  manageAccess={manageAccess}
                />
              )}
            </View>
          )}
        </TabScreenScrollView>
      )}
    </View>
  );
}
