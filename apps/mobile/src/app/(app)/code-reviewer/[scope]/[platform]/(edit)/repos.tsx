import { type Href } from 'expo-router';
import { FolderGit2, ShieldCheck } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { repositoryEmptyCopy } from '@/components/code-reviewer/repository-empty-copy';
import { RepositoryModelOverrides } from '@/components/code-reviewer/repository-model-overrides';
import { RepositoryRowsList } from '@/components/code-reviewer/repository-rows-list';
import { RepositorySyncFooter } from '@/components/code-reviewer/repository-sync-footer';
import { EmptyState, StateAction } from '@/components/empty-state';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import {
  AllRepositoriesSummary,
  RepositoryModeChoice,
} from '@/components/code-reviewer/repository-selection-mode';
import { RefreshControl } from '@/components/ui/refresh-control';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { TAB_SCREEN_TRAILING_GAP, useTabScreenFrame } from '@/components/tab-screen';
import { PLATFORM_CAPABILITIES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { BitbucketRepositoriesState } from '@/components/code-reviewer/bitbucket-repositories-state';
import { classifyBitbucketConnection } from '@/lib/code-reviewer-bitbucket';
import { repositoryModelOverrideHandlers } from '@/lib/code-reviewer-repo-models';
import {
  isPersonal,
  useBitbucketIntegrationStatus,
  useBitbucketReadiness,
  useGitHubRepositories,
  useGitLabRepositories,
  useReviewConfig,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { useRepositoryAccessSync } from '@/lib/hooks/use-repository-access-sync';
import { useRepoSelectionToggle } from '@/lib/hooks/use-code-reviewer-repo-selection';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { useReviewerModels } from '@/lib/hooks/use-reviewer-models';
import { queryBodyFailure, useQueryBodyState } from '@/lib/hooks/use-query-body-state';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';
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
  const configBody = useQueryBodyState(config);
  const { data } = config;
  const configFailure = queryBodyFailure(configBody, config.isFetching);
  const save = useSaveReviewConfig(scope, platform);
  const toggleRepo = useRepoSelectionToggle(scope, platform);
  const { models, isLoading: modelsLoading } = useReviewerModels(scope);
  const { t } = useTranslation();
  const { frameStyle, measureFrame } = useTabScreenFrame();
  const capabilities = PLATFORM_CAPABILITIES[platform];
  const mode = data?.repositorySelectionMode ?? 'all';
  const githubRepos = useGitHubRepositories(scope, platform === 'github');
  const gitlabRepos = useGitLabRepositories(scope, platform === 'gitlab');
  const bitbucketReadiness = useBitbucketReadiness(scope);
  // The readiness read describes workspace access tokens only, so the
  // integration status beside it names a Bitbucket OAuth connection.
  const bitbucketStatus = useBitbucketIntegrationStatus(scope, platform === 'bitbucket');
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
  // The readiness read covers workspace tokens only, so the status read beside
  // it is what names an OAuth connection. Until that read answers, the recovery
  // card's token form is not the truth — an OAuth organization would be given a
  // form the server refuses — so the body waits or retries exactly as it does
  // for its own read.
  const bitbucketConnection =
    platform === 'bitbucket'
      ? classifyBitbucketConnection({ readiness: bitbucketReadiness, status: bitbucketStatus })
      : null;
  const statusFailure = bitbucketConnection?.kind === 'error' ? bitbucketConnection : null;
  const reposLoading = reposQuery.isLoading || bitbucketConnection?.kind === 'loading';
  const reposError = reposQuery.isError;
  const reposFetching = reposQuery.isFetching || statusFailure?.isRetrying === true;
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
  // The rows body is the only body with rows to narrow; in all mode the summary
  // stands where they would, so a field there would filter nothing.
  const rowsBody = !capabilities.selectionModePicker || mode === 'selected';
  // The field arrives with the rows it filters: a control that narrowed an
  // empty, failed or still-loading snapshot would have nothing to narrow.
  const showSearchField = rowsBody && !reposLoading && !reposError && repoRows.length > 0;
  const confirmedEmpty =
    !reposLoading && !reposError && !bitbucketNotReady && repoRows.length === 0;
  // Without the GitHub app the account can review nothing, so the two modes
  // differ only in a setting nobody can act on: their picker above an install
  // prompt offers a choice that changes nothing. The prompt owns the body, as
  // it does for the other platforms' empty surfaces.
  const githubAppMissing =
    platform === 'github' && githubRepos.data?.integrationInstalled === false;
  const { manageAccess, resync, resyncing } = useRepositoryAccessSync(scope, platform);
  // Bitbucket has no provider sync to force, so its pull re-reads the snapshot.
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

  const setMode = (nextMode: 'all' | 'selected') => {
    save.mutate({ repositorySelectionMode: nextMode });
  };

  // The config read owns the body: without it the selection is unusable, so
  // its failure paints the whole surface and the repositories read stays below.
  const fullBodyState =
    configFailure != null ||
    githubAppMissing ||
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
        // In all mode the state follows the explanation and the reserved count
        // row, so the surface-level top air of a 'top' placement only doubles
        // the gap above it.
        className={allMode ? 'pt-4' : undefined}
        title={t('common.couldNotLoadRepositories')}
        onRetry={isRetryableTrpcError(reposQuery.error) ? refetchRepos : undefined}
        isRetrying={reposFetching}
      />
    );
  } else if (!reposLoading && bitbucketNotReady && bitbucketConnection !== null) {
    // Both reads decide the body when the snapshot is not readable: an OAuth
    // connection has no token to repair, a failed status read retries it, and
    // only a token workspace offers the recovery card.
    repoState = (
      <BitbucketRepositoriesState
        scope={scope}
        connection={bitbucketConnection}
        onRetry={() => {
          void reposQuery.refetch();
        }}
      />
    );
  } else if (confirmedEmpty) {
    repoState = (
      <EmptyState
        placement={fullBodyState ? 'center' : 'top'}
        // Only an in-body state drops the surface-level air; the install prompt
        // that replaces the whole body keeps it.
        className={allMode && !fullBodyState ? 'pt-4' : undefined}
        icon={FolderGit2}
        title={emptyStateCopy.title}
        description={emptyStateCopy.description}
        action={
          manageAccess ? (
            <StateAction
              label={t('codeReviewer.repos.manageAccess')}
              icon={ShieldCheck}
              loading={manageAccess.pending}
              disabled={manageAccess.pending}
              onPress={manageAccess.handlePress}
            />
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

  // Everything the scroll body stacked above the rows rides on the list's
  // header, so the same frame carries the mode choice and the states that own
  // the body when there are none. The rows' own section gap follows the mode
  // choice when the platform has one.
  let headerGapClass = 'pb-2';
  if (rowsBody && capabilities.selectionModePicker) {
    headerGapClass = 'pb-6';
  }
  const listHeader = (
    <View>
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

      {rowsBody && reposLoading && (
        <View className="gap-3 pt-2">
          <RowSkeleton subtitle />
          <RowSkeleton subtitle />
        </View>
      )}

      {rowsBody && repoState}
    </View>
  );

  // Per-repository model + effort (the web form's Advanced section): GitLab has
  // no 'all' mode, so it always offers this; GitHub offers it in 'selected' mode
  // only, which is the screen's own gate for the repository rows.
  const repositoryModelOverrides = data?.repositoryModelOverrides ?? [];
  const overridableRepositories = rowsBody
    ? repoRows
        .filter(repo => selectedIds.includes(repo.id))
        .map(repo => ({ id: repo.id, fullName: repo.fullName }))
    : [];
  const { set: handleSetRepositoryOverride, remove: handleRemoveRepositoryOverride } =
    repositoryModelOverrideHandlers(repositoryModelOverrides, save.mutate);

  const listFooter = (
    <>
      {showFooter && (
        <RepositorySyncFooter
          // All mode already ended on the status block above, so the sync line
          // continues it at the small gap the explanation and the count share;
          // selected mode starts a section below its list.
          className={allMode ? 'mt-2' : 'mt-6'}
          syncedLabel={syncedLabel}
          refreshing={refreshing}
          onRefresh={refreshRepositories}
          manageAccess={manageAccess}
        />
      )}
      {overridableRepositories.length > 0 && (
        <RepositoryModelOverrides
          repositories={overridableRepositories}
          overrides={repositoryModelOverrides}
          defaultModelSlug={data?.modelSlug ?? ''}
          models={models}
          modelsLoading={modelsLoading}
          disabled={save.isPending}
          onSet={handleSetRepositoryOverride}
          onRemove={handleRemoveRepositoryOverride}
        />
      )}
      <View style={{ height: TAB_SCREEN_TRAILING_GAP }} pointerEvents="none" />
    </>
  );

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader title={t('common.repositories')} />
      {fullBodyState ? (
        repoState
      ) : (
        // The body is a list rather than a scroll view, framed by the same
        // clearance a tab scroll view reserves: the tab bar's band, or the IME
        // while the keyboard is up, so a filtered result never hides behind the
        // keyboard. A several-hundred-repository snapshot then mounts only the
        // rows on screen.
        <RepositoryRowsList
          // All mode draws no rows: the summary counts them instead.
          repositories={rowsBody ? repoRows : []}
          selectedIds={selectedIds}
          disabled={configDisabled}
          onToggle={toggleRepo}
          searchable={showSearchField}
          header={listHeader}
          headerGapClass={headerGapClass}
          footer={listFooter}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refreshRepositories} />
          }
          style={frameStyle}
          onLayout={measureFrame}
        />
      )}
    </View>
  );
}
