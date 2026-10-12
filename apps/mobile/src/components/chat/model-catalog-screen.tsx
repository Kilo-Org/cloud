import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Cpu, Download, Eye, SearchX, Star } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type DeviceBudget, deviceFit } from '@/lib/chat/device-fit';
import { type CatalogModel, GGUF_CATALOG } from '@/lib/chat/gguf-catalog';
import { useGgufModels } from '@/lib/chat/gguf-models';
import { type HfListedModel, hfModelName } from '@/lib/chat/hf-catalog';
import {
  useDeviceBudget,
  useHfModelSearch,
  useHfSmallestDownload,
} from '@/lib/chat/use-hf-catalog';
import { formatFileSize } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { GgufDownloadControls } from './gguf-model-section';
import { CatalogStat, compactNumber, FitBadge, useCatalogDownload } from './model-catalog-parts';
import { ModelSearchField, useModelSearch } from './model-catalog-search';

type Tab = 'fits' | 'all';

const SKELETON_ROWS = 6;

const downloadBytes = (model: CatalogModel) => model.sizeBytes + (model.projector?.sizeBytes ?? 0);

function RecommendedRow({
  model,
  budget,
}: Readonly<{ model: CatalogModel; budget: DeviceBudget }>) {
  const { t, i18n } = useTranslation();
  const snapshot = useGgufModels();
  const download = useCatalogDownload();
  const fit = deviceFit(downloadBytes(model), budget);
  return (
    <View className="gap-2 rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <Text className="min-w-0 shrink font-semibold">{model.name}</Text>
        <FitBadge fit={fit} />
      </View>
      <Text variant="muted">
        {t('modelChat.gguf.details', {
          size: formatFileSize(downloadBytes(model), i18n.language),
          license: model.license,
        })}
      </Text>
      <GgufDownloadControls
        fileId={model.fileId}
        name={model.name}
        snapshot={snapshot}
        onDownload={
          fit === 'noStorage'
            ? undefined
            : () => {
                download(model, fit);
              }
        }
      />
    </View>
  );
}

function ModelRow({
  model,
  budget,
  fitsOnly,
}: Readonly<{ model: HfListedModel; budget: DeviceBudget; fitsOnly: boolean }>) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const smallest = useHfSmallestDownload(model.id);
  const fit =
    smallest.data === undefined || smallest.data === null
      ? undefined
      : deviceFit(smallest.data, budget);
  if (fitsOnly && (fit === 'tooLarge' || fit === 'noStorage')) {
    return null;
  }
  const [owner = '', repo = ''] = model.id.split('/');
  const name = hfModelName(model.id);
  const downloads = compactNumber(model.downloads, i18n.language);
  const likes = compactNumber(model.likes, i18n.language);
  const parameters =
    model.parameters === undefined ? undefined : compactNumber(model.parameters, i18n.language);
  return (
    <Pressable
      onPress={() => {
        router.push({ pathname: '/model-catalog/[owner]/[repo]', params: { owner, repo } });
      }}
      accessibilityRole="button"
      className="flex-row items-center gap-3 border-b-[0.5px] border-hair-soft px-6 py-3 active:opacity-70"
    >
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 shrink text-sm font-medium" numberOfLines={1}>
            {name}
          </Text>
          <FitBadge fit={fit} />
        </View>
        <Text variant="muted" className="text-xs" numberOfLines={1}>
          {owner}
        </Text>
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          {parameters !== undefined && (
            <CatalogStat
              icon={Cpu}
              value={parameters}
              label={t('modelChat.catalog.parameters', { value: parameters })}
            />
          )}
          <CatalogStat
            icon={Download}
            value={downloads}
            label={t('modelChat.catalog.downloads', { value: downloads })}
          />
          <CatalogStat
            icon={Star}
            value={likes}
            label={t('modelChat.catalog.likes', { value: likes })}
          />
          {model.vision && (
            <CatalogStat
              icon={Eye}
              value={t('modelChat.catalog.vision')}
              label={t('modelChat.catalog.vision')}
            />
          )}
        </View>
      </View>
      <DirectionalChevronRight size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

function LoadingRows() {
  const { t } = useTranslation();
  return (
    <View accessibilityLabel={t('modelChat.catalog.loading')}>
      {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
        // eslint-disable-next-line react/no-array-index-key -- skeleton placeholders have no stable id
        <View key={index} className="gap-2 border-b-[0.5px] border-hair-soft px-6 py-3">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-2/3" />
        </View>
      ))}
    </View>
  );
}

/** Hugging Face GGUF models: the pinned ones first, then search and pages. */
export function ModelCatalogScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const budget = useDeviceBudget();
  const [tab, setTab] = useState<Tab>('fits');
  const search = useModelSearch();
  const models = useHfModelSearch({
    search: search.query,
    fitsOnly: tab === 'fits',
    memoryBytes: budget.memoryBytes,
  });
  const rows = useMemo(
    () => models.data?.pages.flatMap(page => page.models) ?? [],
    [models.data?.pages]
  );
  const recommended =
    search.query === ''
      ? GGUF_CATALOG.filter(model => {
          const fit = deviceFit(downloadBytes(model), budget);
          return tab === 'all' || fit === 'fits' || fit === 'tight' || fit === undefined;
        })
      : [];
  const hasPages = (models.data?.pages.length ?? 0) > 0;

  let empty = <LoadingRows />;
  if (models.isError && !hasPages) {
    empty = (
      <QueryError
        variant="server"
        title={t('agentChat.newSession.couldNotLoadModels')}
        placement="top"
        onRetry={() => void models.refetch()}
        isRetrying={models.isFetching}
      />
    );
  } else if (hasPages) {
    empty = (
      <EmptyState
        icon={SearchX}
        title={t(tab === 'fits' ? 'modelChat.catalog.noFits' : 'modelChat.catalog.noResults')}
        {...(tab === 'fits' ? { description: t('modelChat.catalog.noFitsDescription') } : {})}
        placement="top"
      />
    );
  }

  let footer = <View className="h-12" />;
  if (models.isError && hasPages) {
    footer = (
      <View className="items-center gap-2 px-6 py-4">
        <Text variant="muted" className="text-center text-xs">
          {t('common.couldnTLoadMore')}
        </Text>
        <Button
          size="sm"
          variant="outline"
          onPress={() => void models.fetchNextPage()}
          accessibilityLabel={t('common.retryLoadingMore')}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  } else if (models.isFetchingNextPage) {
    footer = (
      <View className="items-center py-4">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('modelChat.catalog.title')} />
      <ModelSearchField search={search} />
      <View className="px-[22px] pb-2">
        <SegmentedControl
          options={[
            { value: 'fits', label: t('modelChat.catalog.fitsTab') },
            { value: 'all', label: t('common.all') },
          ]}
          value={tab}
          onChange={setTab}
          accessibilityLabel={t('modelChat.catalog.tabs')}
        />
      </View>
      <FlashList
        data={hasPages ? rows : []}
        keyExtractor={model => model.id}
        renderItem={({ item }) => (
          <ModelRow model={item} budget={budget} fitsOnly={tab === 'fits'} />
        )}
        ListHeaderComponent={
          <View className="gap-3 pt-2">
            {recommended.length > 0 && (
              <View className="gap-3 px-6 pb-3">
                <Eyebrow>{t('common.recommended')}</Eyebrow>
                {recommended.map(model => (
                  <RecommendedRow key={model.fileId} model={model} budget={budget} />
                ))}
              </View>
            )}
            <Eyebrow className="px-6 pb-1">{t('modelChat.catalog.fromHuggingFace')}</Eyebrow>
          </View>
        }
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={() => {
          if (models.hasNextPage && !models.isFetchingNextPage && !models.isError) {
            void models.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      />
    </View>
  );
}
