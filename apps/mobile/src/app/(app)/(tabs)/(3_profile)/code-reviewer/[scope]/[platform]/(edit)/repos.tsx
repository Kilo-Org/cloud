import { useLocalSearchParams } from 'expo-router';
import { FolderGit2 } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { RepoToggleRow } from '@/components/repo-toggle-row';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { PLATFORM_CAPABILITIES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { trpcClient } from '@/lib/trpc';
import {
  PERSONAL_SCOPE,
  useBitbucketReadiness,
  useGitHubRepositories,
  useGitLabRepositories,
  useReviewConfig,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { useRepoSelectionToggle } from '@/lib/hooks/use-code-reviewer-repo-selection';
import { getBitbucketIntegrationUrl, getGitLabIntegrationUrl } from '@/lib/integration-urls';

export default function ReposRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
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
      rows: githubRepos.data?.repositories ?? [],
    },
    gitlab: {
      isLoading: gitlabRepos.isLoading,
      isError: gitlabRepos.isError,
      isFetching: gitlabRepos.isFetching,
      refetch: () => void gitlabRepos.refetch(),
      rows: gitlabRepos.data?.repositories ?? [],
    },
    bitbucket: {
      isLoading: bitbucketReadiness.isLoading,
      isError: bitbucketReadiness.isError,
      isFetching: bitbucketReadiness.isFetching,
      refetch: () => void bitbucketReadiness.refetch(),
      rows: bitbucketRepos,
    },
  };
  const {
    isLoading: reposLoading,
    isError: reposError,
    isFetching: reposFetching,
    refetch: refetchRepos,
    rows: repoRows,
  } = reposByPlatform[platform];
  const selectedIds = data?.selectedRepositoryIds ?? [];
  const configDisabled = data == null;
  const bitbucketNotReady =
    platform === 'bitbucket' && bitbucketReadiness.data?.repositoryCache.status !== 'available';
  const confirmedEmpty =
    !reposLoading && !reposError && !bitbucketNotReady && repoRows.length === 0;
  const orgScope = scope === PERSONAL_SCOPE ? undefined : scope;
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- deliberately partial (bitbucket has no entry); lookup must accept the full ReviewerPlatform key set
  const manageRepoAccessLabelByPlatform: Partial<Record<ReviewerPlatform, string>> = {
    github: t('codeReviewer.repos.repositoryAccess'),
    gitlab: t('codeReviewer.repos.repositoryAccess'),
  };
  const manageRepoAccessLabel = manageRepoAccessLabelByPlatform[platform];
  const emptyStateCopyByPlatform = {
    github: {
      title: t('codeReviewer.repos.installGithubApp'),
      description: t('codeReviewer.repos.installGithubAppDescription'),
    },
    gitlab: {
      title: t('codeReviewer.repos.noRepositoriesFound'),
      description: t('codeReviewer.repos.gitlabNoRepositoriesDescription'),
    },
    bitbucket: {
      title: t('codeReviewer.repos.noRepositoriesFound'),
      description: t('codeReviewer.repos.bitbucketNoRepositoriesDescription'),
    },
  } satisfies Record<ReviewerPlatform, { title: string; description: string }>;
  const emptyStateCopy = emptyStateCopyByPlatform[platform];

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
          manageRepoAccessLabel ? (
            <Button
              variant="outline"
              onPress={() => {
                void (async () => {
                  if (platform === 'github') {
                    try {
                      const { token } = await trpcClient.githubApps.mintInstallState.mutate({
                        organizationId: orgScope ?? undefined,
                        returnTo: '/cloud/sessions',
                      });
                      await openExternalUrl(
                        getGitHubIntegrationUrl(WEB_BASE_URL, orgScope, token),
                        { label: t('codeReviewer.repos.repositoryAccess') }
                      );
                    } catch {
                      toast.error(t('prReview.couldNotOpenGitHubAppSettings'));
                    }
                  } else if (platform === 'gitlab') {
                    await openExternalUrl(getGitLabIntegrationUrl(WEB_BASE_URL, orgScope), {
                      label: t('codeReviewer.repos.repositoryAccess'),
                    });
                  }
                })();
              }}
            >
              <Text>{t('codeReviewer.repos.manageAccess')}</Text>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.repositories')} />
      {fullBodyState ? (
        repoState
      ) : (
        <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
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
            </View>
          )}
        </TabScreenScrollView>
      )}
    </View>
  );
}
