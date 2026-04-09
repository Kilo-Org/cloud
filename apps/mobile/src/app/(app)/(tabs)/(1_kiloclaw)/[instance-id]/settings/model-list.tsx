import { useQuery } from '@tanstack/react-query';
import { Check, Eye } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useKiloClawConfig, useKiloClawMutations } from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { addModelPrefix, stripModelPrefix } from '@/lib/model-id';
import { useTRPC } from '@/lib/trpc';

type ModelItem = {
  id: string;
  name: string;
  supportsVision: boolean;
  isPreferred: boolean;
};

export default function ModelListScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const trpc = useTRPC();
  const [searchFilter, setSearchFilter] = useState('');

  const { data: config } = useKiloClawConfig();
  const mutations = useKiloClawMutations();
  const currentModel = stripModelPrefix(config?.kilocodeDefaultModel);

  const {
    data: models,
    isLoading,
    isError,
    refetch,
  } = useQuery(trpc.models.list.queryOptions(undefined, { staleTime: 5 * 60_000 }));

  const filtered = (models ?? []).filter((m: ModelItem) => {
    if (!searchFilter) {
      return true;
    }
    const q = searchFilter.toLowerCase();
    return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });

  const preferred = filtered.filter(m => m.isPreferred);
  const rest = filtered.filter(m => !m.isPreferred);

  const handleSelect = useCallback(
    (modelId: string) => {
      mutations.updateModel.mutate(
        { kilocodeDefaultModel: addModelPrefix(modelId) },
        {
          onSuccess: () => {
            toast.success(`Model set to ${modelId}`);
            router.back();
          },
        }
      );
    },
    [mutations.updateModel, router]
  );

  const renderItem = useCallback(
    ({ item }: { item: ModelItem }) => {
      const selected = currentModel === item.id;
      return (
        <Pressable
          className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
          onPress={() => {
            handleSelect(item.id);
          }}
          disabled={mutations.updateModel.isPending}
        >
          <View className="flex-1">
            <Text className="text-sm font-medium">{item.name}</Text>
            <Text className="text-xs text-muted-foreground">{item.id}</Text>
          </View>
          {item.supportsVision && <Eye size={14} color={colors.mutedForeground} />}
          {selected && <Check size={16} color="#3b82f6" />}
        </Pressable>
      );
    },
    [currentModel, handleSelect, mutations.updateModel.isPending, colors.mutedForeground]
  );

  const sections = [
    ...(preferred.length > 0
      ? [
          { type: 'header' as const, title: 'Recommended' },
          ...preferred.map(m => ({ type: 'model' as const, model: m })),
        ]
      : []),
    ...(rest.length > 0
      ? [
          { type: 'header' as const, title: 'All Models' },
          ...rest.map(m => ({ type: 'model' as const, model: m })),
        ]
      : []),
  ];

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="All Models" />
      <View className="px-4 pb-2 pt-2">
        <TextInput
          className="rounded-lg bg-secondary px-4 py-3 text-sm text-foreground"
          placeholder="Search models..."
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          defaultValue=""
          onChangeText={setSearchFilter}
        />
      </View>
      {isLoading && (
        <View className="gap-2 px-4 pt-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </View>
      )}
      {isError && (
        <View className="flex-1 items-center justify-center">
          <QueryError message="Could not load models" onRetry={() => void refetch()} />
        </View>
      )}
      {!isLoading && !isError && (
        <FlatList
          data={sections}
          keyExtractor={(item, index) =>
            item.type === 'header' ? `header-${item.title}` : `model-${item.model.id}-${index}`
          }
          contentContainerStyle={{ paddingBottom: Math.max(bottom, 16) }}
          renderItem={({ item }) => {
            if (item.type === 'header') {
              return (
                <View className="px-4 pb-1 pt-4">
                  <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {item.title}
                  </Text>
                </View>
              );
            }
            return renderItem({ item: item.model });
          }}
        />
      )}
    </View>
  );
}
