import { useLocalSearchParams } from 'expo-router';
import { FolderGit2 } from 'lucide-react-native';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { RepoToggleRow } from '@/components/repo-toggle-row';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { PLATFORM_CAPABILITIES, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import {
  PERSONAL_SCOPE,
  useBitbucketReadiness,
  useGitHubRepositories,
  useGitLabRepositories,
  useReviewConfig,
  useReviewConfigCacheReader,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { getBitbucketIntegrationUrl, getGitLabIntegrationUrl } from '@/lib/integration-urls';

export default function ReposRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const readConfig = useReviewConfigCacheReader(scope, platform);
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
  const manageRepoAccessUrlByPlatform: Partial<Record<ReviewerPlatform, string>> = {
    github: getGitHubIntegrationUrl(WEB_BASE_URL, orgScope),
    gitlab: getGitLabIntegrationUrl(WEB_BASE_URL, orgScope),
  };
  const manageRepoAccessUrl = manageRepoAccessUrlByPlatform[platform];
  const emptyStateCopyByPlatform: Record<ReviewerPlatform, { title: string; description: string }> =
    {
      github: {
        title: 'Install the GitHub app on repositories',
        description: 'Grant the Kilo GitHub App access to the repositories you want reviewed.',
      },
      gitlab: {
        title: 'No repositories found',
        description: 'You may need to grant access to more groups or projects on GitLab.',
      },
      bitbucket: {
        title: 'No repositories found',
        description: 'No repositories are available in this Bitbucket workspace.',
      },
    };
  const emptyStateCopy = emptyStateCopyByPlatform[platform];

  const setMode = (nextMode: 'all' | 'selected') => {
    save.mutate({ repositorySelectionMode: nextMode });
  };

  const toggleRepo = (id: number | string) => {
    // Read the cache at call time, not the render-time snapshot above, so
    // two rapid taps each build the next array from the latest committed
    // selection instead of dropping one another.
    const current = readConfig()?.selectedRepositoryIds ?? [];
    const next = current.includes(id)
      ? current.filter(existing => existing !== id)
      : [...current, id];
    save.mutate({ selectedRepositoryIds: next });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Repositories" />
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="pt-4">
        {capabilities.selectionModePicker &&
          (['all', 'selected'] as const).map(option => (
            <ChoiceRow
              key={option}
              label={option === 'all' ? 'All repositories' : 'Selected repositories'}
              selected={mode === option}
              disabled={configDisabled}
              className="border-b-[0.5px] border-hair-soft"
              onPress={() => {
                setMode(option);
              }}
            />
          ))}

        {(!capabilities.selectionModePicker || mode === 'selected') && (
          <View className={capabilities.selectionModePicker ? 'mt-6' : undefined}>
            <Text variant="small" className="mb-1 uppercase tracking-wide text-muted-foreground">
              Repositories
            </Text>
            {reposLoading && (
              <View className="gap-3 pt-2">
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </View>
            )}

            {!reposLoading && reposError && (
              <QueryError
                variant="server"
                placement="top"
                title="Could not load repositories"
                onRetry={refetchRepos}
                isRetrying={reposFetching}
              />
            )}

            {!reposLoading && !reposError && bitbucketNotReady && (
              <View className="items-center gap-2 pt-2">
                <Text variant="muted" className="text-center text-xs">
                  Repositories unavailable — finish Bitbucket setup on kilo.ai.
                </Text>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    void openExternalUrl(getBitbucketIntegrationUrl(WEB_BASE_URL, scope), {
                      label: 'Bitbucket setup',
                    });
                  }}
                >
                  <Text>Finish setup</Text>
                </Button>
              </View>
            )}

            {confirmedEmpty && (
              <EmptyState
                placement="top"
                icon={FolderGit2}
                title={emptyStateCopy.title}
                description={emptyStateCopy.description}
                action={
                  manageRepoAccessUrl ? (
                    <Button
                      variant="outline"
                      onPress={() => {
                        void openExternalUrl(manageRepoAccessUrl, { label: 'repository access' });
                      }}
                    >
                      <Text>Manage access</Text>
                    </Button>
                  ) : undefined
                }
              />
            )}

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
    </View>
  );
}
