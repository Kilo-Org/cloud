import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { SearchX } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { deviceFit, fitsDevice } from '@/lib/chat/device-fit';
import { GGUF_CATALOG } from '@/lib/chat/gguf-catalog';
import { type HfListedModel } from '@/lib/chat/hf-catalog';
import { isHfGone, isHfRestricted } from '@/lib/chat/hf-request';
import { useDeviceBudget, useHfModelSearch } from '@/lib/chat/use-hf-catalog';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { catalogEmptyCopy, type CatalogTab } from './model-catalog-empty';
import { downloadBytes, LoadingRows, ModelRow, RecommendedRow } from './model-catalog-rows';
import { ModelSearchField, useModelSearch } from './model-catalog-search';

/** Hugging Face GGUF models: the pinned ones first, then search and pages. */
export function ModelCatalogScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const budget = useDeviceBudget();
  const [tab, setTab] = useState<CatalogTab>('fits');
  const search = useModelSearch();
  const listRef = useRef<FlashListRef<HfListedModel>>(null);
  // Changing the filter or the paused search text swaps the search query's
  // key, so the list briefly empties while the fresh pages load. The stale
  // offset would otherwise land the regrown list mid-card, hiding the
  // recommended section above it.
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [tab, search.query]);
  const query = search.query;
  const models = useHfModelSearch({
    search: query,
    fitsOnly: tab === 'fits',
    memoryBytes: budget.memoryBytes,
  });
  const rows = useMemo(
    () => models.data?.pages.flatMap(page => page.models) ?? [],
    [models.data?.pages]
  );
  const recommended =
    query === ''
      ? GGUF_CATALOG.filter(model => {
          const fit = deviceFit(downloadBytes(model), budget);
          return tab === 'all' || fitsDevice(fit);
        })
      : [];
  const hasPages = (models.data?.pages.length ?? 0) > 0;
  // The device cap is a server-side filter, so an empty Fits answer alone
  // cannot say whether the search matched anything. The same search without
  // the cap answers it, and its cache also serves the All tab.
  const capMayHideMatches = tab === 'fits' && query !== '' && hasPages && rows.length === 0;
  const wider = useHfModelSearch({
    search: query,
    fitsOnly: false,
    memoryBytes: budget.memoryBytes,
    enabled: capMayHideMatches,
  });
  const emptyCopy = catalogEmptyCopy({
    tab,
    query,
    widerMatch: (wider.data?.pages.flatMap(page => page.models).length ?? 0) > 0,
  });

  let empty = <LoadingRows />;
  if (models.isError && !hasPages) {
    if (isHfGone(models.error)) {
      empty = <QueryError variant="not-found" placement="top" />;
    } else if (isHfRestricted(models.error)) {
      empty = <QueryError variant="permission" placement="top" />;
    } else {
      empty = (
        <QueryError
          variant="server"
          title={t('agentChat.newSession.couldNotLoadModels')}
          placement="top"
          onRetry={() => void models.refetch()}
          isRetrying={models.isFetching}
        />
      );
    }
  } else if (hasPages) {
    empty = (
      <EmptyState
        icon={SearchX}
        title={t(emptyCopy.titleKey, { query })}
        {...(emptyCopy.descriptionKey ? { description: t(emptyCopy.descriptionKey) } : {})}
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
      <FlashList<HfListedModel>
        ref={listRef}
        maintainVisibleContentPosition={{ disabled: true }}
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
                <Text variant="muted" className="text-xs">
                  {t('modelChat.catalog.recommendationsHelp')}
                </Text>
                <Text variant="muted" className="text-xs">
                  {t('modelChat.catalog.quantizationsHelp')}
                </Text>
                {recommended.map(model => (
                  <RecommendedRow key={model.fileId} model={model} budget={budget} />
                ))}
              </View>
            )}
            <Eyebrow className="px-6 pb-1">{t('modelChat.catalog.fromHuggingFace')}</Eyebrow>
            <Text variant="muted" className="px-6 pb-1 text-xs">
              {t('modelChat.catalog.compatibilityHelp')}
            </Text>
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
