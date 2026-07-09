import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { Check, Lock } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { asReviewerPlatform, PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import {
  useBitbucketReadiness,
  useGitHubRepositories,
  useGitLabRepositories,
  useReviewConfig,
  useReviewConfigCacheReader,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function ReposRoute() {
  const { scope, platform: rawPlatform } = useLocalSearchParams<{
    scope: string;
    platform: string;
  }>();
  const platform = asReviewerPlatform(rawPlatform);
  const colors = useThemeColors();
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
    github: { isLoading: githubRepos.isLoading, rows: githubRepos.data?.repositories ?? [] },
    gitlab: { isLoading: gitlabRepos.isLoading, rows: gitlabRepos.data?.repositories ?? [] },
    bitbucket: { isLoading: bitbucketReadiness.isLoading, rows: bitbucketRepos },
  };
  const { isLoading: reposLoading, rows: repoRows } = reposByPlatform[platform];
  const selectedIds = data?.selectedRepositoryIds ?? [];

  const setMode = (nextMode: 'all' | 'selected') => {
    void Haptics.selectionAsync();
    save.mutate({ repositorySelectionMode: nextMode });
  };

  const toggleRepo = (id: number | string) => {
    void Haptics.selectionAsync();
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
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
        {capabilities.selectionModePicker &&
          (['all', 'selected'] as const).map(option => (
            <Pressable
              key={option}
              className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3 active:opacity-70"
              onPress={() => {
                setMode(option);
              }}
            >
              <Text className="text-sm font-medium">
                {option === 'all' ? 'All repositories' : 'Selected repositories'}
              </Text>
              <Check size={18} color={mode === option ? colors.foreground : 'transparent'} />
            </Pressable>
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
            {!reposLoading &&
              platform === 'bitbucket' &&
              bitbucketReadiness.data?.repositoryCache.status !== 'available' && (
                <Text variant="muted" className="pt-2 text-xs">
                  Repositories unavailable — finish Bitbucket setup on kilo.ai.
                </Text>
              )}
            {repoRows.map(repo => (
              <Pressable
                key={repo.id}
                className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3 active:opacity-70"
                onPress={() => {
                  toggleRepo(repo.id);
                }}
              >
                <View className="flex-1 flex-row items-center gap-2 pr-3">
                  {repo.private ? <Lock size={12} color={colors.mutedForeground} /> : null}
                  <Text className="text-sm" numberOfLines={1}>
                    {repo.fullName}
                  </Text>
                </View>
                <Check
                  size={18}
                  color={selectedIds.includes(repo.id) ? colors.foreground : 'transparent'}
                />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
