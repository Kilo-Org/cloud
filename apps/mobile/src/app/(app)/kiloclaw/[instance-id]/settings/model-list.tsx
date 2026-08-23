import { useQuery } from '@tanstack/react-query';
import { Check, Eye, Search } from '@/components/ui/icons';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { EmptyState } from '@/components/empty-state';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { instanceOrgId, useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawConfig, useKiloClawMutations } from '@/lib/hooks/use-kiloclaw-queries';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';
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
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const router = useRouter();
  const colors = useThemeColors();
  const paddingBottom = useDetailScreenBottomPadding();
  const trpc = useTRPC();
  const { t } = useTranslation();
  const [searchFilter, setSearchFilter] = useState('');
  const searchInputRef = useRef<TextInput>(null);

  const handleClearSearch = useCallback(() => {
    setSearchFilter('');
    searchInputRef.current?.clear();
  }, []);

  const configQuery = useKiloClawConfig(organizationId);
  const config = configQuery.data;
  const mutations = useKiloClawMutations(organizationId);
  const currentModel = stripModelPrefix(config?.kilocodeDefaultModel);

  const {
    data: models,
    isLoading: isModelsLoading,
    isError: isModelsError,
    refetch,
  } = useQuery(trpc.models.list.queryOptions(undefined, { staleTime: 5 * 60_000 }));

  // Instance context resolves organizationId — until it's ready, updateModel would
  // mutate with organizationId undefined (PERSONAL config) instead of the org's.
  const isLoading = isModelsLoading || instanceContext.status === 'loading';
  // Without a known current model, rows would render selectable with no
  // indication of what's actually selected — treat a config load failure
  // the same as a models load failure.
  const isError = isModelsError || configQuery.isError;

  const filtered = (models ?? []).filter((m: ModelItem) => {
    if (!searchFilter) {
      return true;
    }
    const q = searchFilter.toLowerCase();
    return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });

  const preferred = filtered.filter(m => m.isPreferred);
  const rest = filtered.filter(m => !m.isPreferred);

  const listContentContainerStyle = useMemo(
    () => ({ paddingBottom, flexGrow: 1 }) satisfies ViewStyle,
    [paddingBottom]
  );

  const handleSelect = useCallback(
    (modelId: string) => {
      mutations.updateModel.mutate(
        { kilocodeDefaultModel: addModelPrefix(modelId) },
        {
          onSuccess: () => {
            router.back();
          },
        }
      );
    },
    [mutations.updateModel, router]
  );

  const pendingModelId = mutations.updateModel.isPending
    ? stripModelPrefix(mutations.updateModel.variables.kilocodeDefaultModel)
    : undefined;

  const renderItem = useCallback(
    ({ item }: { item: ModelItem }) => {
      const selected = currentModel === item.id;
      const isRowPending = mutations.updateModel.isPending && pendingModelId === item.id;
      return (
        <Pressable
          className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
          onPress={() => {
            handleSelect(item.id);
          }}
          disabled={mutations.updateModel.isPending}
          accessibilityState={{ disabled: mutations.updateModel.isPending, busy: isRowPending }}
        >
          <View className="flex-1">
            <Text className="text-sm font-medium">{item.name}</Text>
            <Text className="text-xs text-muted-foreground">{item.id}</Text>
          </View>
          {isRowPending ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <>
              {item.supportsVision && <Eye size={14} color={colors.mutedForeground} />}
              {selected && <Check size={16} color={colors.primary} />}
            </>
          )}
        </Pressable>
      );
    },
    [
      currentModel,
      handleSelect,
      mutations.updateModel.isPending,
      pendingModelId,
      colors.mutedForeground,
      colors.primary,
    ]
  );

  const sections = [
    ...(preferred.length > 0
      ? [
          { type: 'header' as const, title: t('kiloclaw.modelList.recommended') },
          ...preferred.map(m => ({ type: 'model' as const, model: m })),
        ]
      : []),
    ...(rest.length > 0
      ? [
          { type: 'header' as const, title: t('kiloclaw.modelList.title') },
          ...rest.map(m => ({ type: 'model' as const, model: m })),
        ]
      : []),
  ];

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return <InstanceContextBoundary title={t('kiloclaw.modelList.title')} context={instanceContext} />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('kiloclaw.modelList.title')} />
      <View className="px-4 pb-2 pt-2">
        <TextInput
          ref={searchInputRef}
          className="rounded-lg bg-secondary px-4 py-3 text-sm text-foreground"
          placeholder={t('kiloclaw.modelList.searchPlaceholder')}
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
          <QueryError
            message={t('kiloclaw.modelList.couldNotLoad')}
            onRetry={() => {
              void refetch();
              void configQuery.refetch();
            }}
          />
        </View>
      )}
      {!isLoading && !isError && (
        <FlatList
          data={sections}
          keyExtractor={(item, index) =>
            item.type === 'header' ? `header-${item.title}` : `model-${item.model.id}-${index}`
          }
          contentContainerStyle={listContentContainerStyle}
          ListEmptyComponent={
            <EmptyState
              icon={Search}
              title={searchFilter ? t('kiloclaw.modelList.noMatches') : t('kiloclaw.modelList.noModels')}
              description={
                searchFilter
                  ? t('kiloclaw.modelList.noResultsFor', { query: searchFilter })
                  : t('kiloclaw.modelList.noModelsDescription')
              }
              placement="top"
              action={
                searchFilter ? (
                  <Button variant="outline" size="sm" onPress={handleClearSearch}>
                    <Text>{t('kiloclaw.modelList.clearSearch')}</Text>
                  </Button>
                ) : undefined
              }
            />
          }
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
