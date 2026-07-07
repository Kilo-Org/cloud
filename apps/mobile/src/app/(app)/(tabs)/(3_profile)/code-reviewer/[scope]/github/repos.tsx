import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { Check, Lock } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useGitHubRepositories,
  useReviewConfig,
  useReviewConfigCacheReader,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function ReposRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  const colors = useThemeColors();
  const { data } = useReviewConfig(scope, 'github');
  const save = useSaveReviewConfig(scope, 'github');
  const readConfig = useReviewConfigCacheReader(scope, 'github');
  const mode = data?.repositorySelectionMode ?? 'all';
  const repos = useGitHubRepositories(scope, mode === 'selected');
  const selectedIds = data?.selectedRepositoryIds ?? [];

  const setMode = (nextMode: 'all' | 'selected') => {
    void Haptics.selectionAsync();
    save.mutate({ repositorySelectionMode: nextMode });
  };

  const toggleRepo = (id: number) => {
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
        {(['all', 'selected'] as const).map(option => (
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
            {mode === option ? <Check size={18} color={colors.foreground} /> : null}
          </Pressable>
        ))}

        {mode === 'selected' && (
          <View className="mt-6">
            <Text variant="small" className="mb-1 uppercase tracking-wide text-muted-foreground">
              Repositories
            </Text>
            {repos.isLoading && (
              <View className="gap-3 pt-2">
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </View>
            )}
            {repos.data?.repositories.map(repo => (
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
                {selectedIds.includes(repo.id) ? (
                  <Check size={18} color={colors.foreground} />
                ) : null}
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
