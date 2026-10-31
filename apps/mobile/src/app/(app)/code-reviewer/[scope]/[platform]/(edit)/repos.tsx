import { type Href, useNavigation } from 'expo-router';
import { FolderGit2 } from '@/components/ui/icons';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { AppState, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CenteredState } from '@/components/centered-state';
import { repositoryEmptyCopy } from '@/components/code-reviewer/repository-empty-copy';
import { RepositorySyncFooter } from '@/components/code-reviewer/repository-sync-footer';
import { EmptyState } from '@/components/empty-state';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { RepoToggleRow } from '@/components/repo-toggle-row';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import {
  AllRepositoriesSummary,
  RepositoryModeChoice,
} from '@/components/code-reviewer/repository-selection-mode';
import { Button } from '@/components/ui/button';
import { RefreshControl } from '@/components/ui/refresh-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { PLATFORM_CAPABILITIES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import {
  isPersonal,
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
import { reviewConfigFailure, useReviewConfigBody } from '@/lib/hooks/use-review-config-body';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';
import { getBitbucketIntegrationUrl } from '@/lib/integration-urls';
import { isRetryableTrpcError, trpcErrorVariant } from '@/lib/trpc-error';
import { parseTimestamp, timeAgo } from '@/lib/utils';

export default function ReposRoute() {
  const params = useReviewerRouteParams();
  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }
  return <ReposScreen scope={params.scope} platform={params.platform} />;
}

function ReposScreen({ scope, platform }: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const config = useReviewConfig(scope, platform);
  const configBody = useReviewConfigBody(config);
  const { data } = config;
  const configFailure = reviewConfigFailure(configBody, config.isFetching);
  const save = useSaveReviewConfig(scope, platform);
  const toggleRepo = useRepoSelectionToggle(scope, platform);
  const { t } = useTranslation();
  const capabilities = PLATFORM_CAPABILITIES[platform];
  const mode = data?.repositorySelectionMode ?? 'all';
  const githubRepos = useGitHubRepositories(scope, platform === 'github');
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
      query: githubRepos,
      syncedAt: githubRepos.data?.syncedAt ?? null,
      rows: githubRepos.data?.repositories ?? [],
    },
    gitlab: {
      query: gitlabRepos,
      syncedAt: gitlabRepos.data?.syncedAt ?? null,
      rows: gitlabRepos.data?.repositories ?? [],
    },
    bitbucket: {
      query: bitbucketReadiness,
      syncedAt: null,
      rows: bitbucketRepos,
    },
  };
  const { query: reposQuery, rows: repoRows, syncedAt } = reposByPlatform[platform];
  const reposLoading = reposQuery.isLoading;
  const reposError = reposQuery.isError;
  const reposFetching = reposQuery.isFetching;
  const refetchRepos = () => void reposQuery.refetch();

  const selectedIds = data?.selectedRepositoryIds ?? [];
  const configDisabled = data == null;
  // Only GitHub offers the all/selected choice, and the config read decides
  // which body is real: an explanation shown while it is pending would
  // describe a mode the saved config may not be in.
  const allMode = capabilities.selectionModePicker && mode === 'all';
  const allModeBody = allMode && !configDisabled;
  const bitbucketNotReady =
    platform === 'bitbucket' && bitbucketReadiness.data?.repositoryCache.status !== 'available';
  const confirmedEmpty =
    !reposLoading && !reposError && !bitbucketNotReady && repoRows.length === 0;
  const resyncPlatform: SyncedRepoPlatform = platform === 'gitlab' ? 'gitlab' : 'github';
  const { resync, resyncing } = useReviewerRepositoriesResync(scope, resyncPlatform);
  // Set on the way to the provider's settings page, where installation access
  // may have widened. Two signals report the return and only the first syncs:
  // the awaited browser dismissal (the only one iOS reports, since its page
  // opens in-app) and the next foreground (Android).
  const pendingAccessChange = useRef(false);
  const navigation = useNavigation();
  const flushPendingSync = useCallback(() => {
    if (!pendingAccessChange.current) {
      return;
    }
    pendingAccessChange.current = false;
    void resync();
  }, [resync]);
  const manageAccess = useManageRepositoryAccess(scope, platform, {
    onOpen: () => {
      pendingAccessChange.current = true;
    },
    onReturn: flushPendingSync,
  });
  const refreshing = platform === 'bitbucket' ? reposFetching : resyncing;
  const refreshRepositories = () => {
    if (platform === 'bitbucket') {
      refetchRepos();
    } else {
      void resync();
    }
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
  const emptyStateCopy = repositoryEmptyCopy(platform, t);

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

  // The config read owns the body: without it the selection is unusable, so
  // its failure paints the whole surface and the repositories read stays below.
  const fullBodyState =
    configFailure != null ||
    (!capabilities.selectionModePicker && !reposLoading && repoRows.length === 0);
  let repoState: ReactNode = null;
  if (configFailure) {
    repoState = (
      <QueryError
        variant={configFailure.variant}
        onRetry={() => {
          configFailure.onRetry();
        }}
        isRetrying={configFailure.isRetrying}
      />
    );
  } else if (!reposLoading && reposError) {
    repoState = (
      <QueryError
        variant={trpcErrorVariant(reposQuery.error)}
        placement={fullBodyState ? 'center' : 'top'}
        title={t('common.couldNotLoadRepositories')}
        onRetry={isRetryableTrpcError(reposQuery.error) ? refetchRepos : undefined}
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
            <Button
              className={STATE_ACTION_CLASS}
              loading={manageAccess.pending}
              disabled={manageAccess.pending}
              onPress={manageAccess.handlePress}
            >
              <Text>{t('codeReviewer.repos.manageAccess')}</Text>
            </Button>
          ) : undefined
        }
      />
    );
  }

  // In all mode the footer follows the explanation, so it waits for the config
  // read with it: a footer that appeared first would be pushed down when the
  // block above it arrives.
  const showFooter =
    !reposLoading &&
    !reposError &&
    !bitbucketNotReady &&
    repoRows.length > 0 &&
    (!allMode || !configDisabled);

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader title={t('common.repositories')} />
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
            <RepositoryModeChoice mode={mode} disabled={configDisabled} onSelect={setMode} />
          )}

          {allModeBody && (
            <AllRepositoriesSummary
              personal={isPersonal(scope)}
              loading={reposLoading}
              // The skeleton, the error and the empty state own the body when
              // the snapshot is not a count yet.
              count={reposLoading || reposError || confirmedEmpty ? null : repoRows.length}
            >
              {repoState}
            </AllRepositoriesSummary>
          )}

          {(!capabilities.selectionModePicker || mode === 'selected') && (
            <View className={capabilities.selectionModePicker ? 'mt-6' : undefined}>
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
            </View>
          )}

          {showFooter && (
            <RepositorySyncFooter
              syncedLabel={syncedLabel}
              refreshing={refreshing}
              onRefresh={refreshRepositories}
              manageAccess={manageAccess}
            />
          )}
        </TabScreenScrollView>
      )}
    </View>
  );
}
