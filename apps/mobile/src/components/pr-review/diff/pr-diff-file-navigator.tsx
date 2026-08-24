// File navigator sheet content. The orchestrator mounts this inside the
// `/(app)/pr-review/[owner]/[repo]/[number]/file-navigator` route file
// (which still shows the S4b stub until the orchestrator wires this
// component in at the barrier).
//
// Responsibilities:
//   - share `usePrReviewFileListQuery` with the mounted Files tab so
//     react-query dedupes by key and the navigator and the file list
//     stay in sync
//   - virtualize the file rows with `FlashList`; with no active search,
//     pages load on scroll via `onEndReached`
//   - with an active search, drive `useFetchToCompletion(...).run()` so
//     the filter still searches the full listed set
//   - render a search input (uncontrolled per iOS rules: ref +
//     onChangeText, no `value`) and a list of file rows
//   - on tap, `requestScrollToFile(...)` and dismiss
//   - render the four states: loading, retryable (fetch-to-completion
//     error), empty (0 listed files), happy

/* eslint-disable max-lines -- cohesive navigator component: the four states plus the search and pagination rules */

import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Search } from '@/components/ui/icons';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { NavigatorFileRow } from '@/components/pr-review/diff/pr-diff-navigator-file-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { requestScrollToFile } from '@/lib/pr-review/file-navigator-bridge';
import {
  useFetchToCompletion,
  usePrReviewFileListQuery,
  usePrReviewViewedFiles,
} from '@/lib/pr-review/diff/pr-review-file-list-state';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { filterNavigatorFiles } from '@/lib/pr-review/diff/navigator-file-filter';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// Memoized row so recycled cells do not re-render on every keystroke: `file`
// and `viewed` are stable across a search re-render, and the callbacks below
// are `useCallback`-stable.
const MemoNavigatorFileRow = memo(NavigatorFileRow);

// Identity-stable per-path row callbacks (the row's `onSelect`/`onToggleViewed`
// take no args, so the path is bound once and cached in a ref map).
type RowCallbacks = { handleSelect: () => void; handleToggleViewed: () => void };

type PrDiffFileNavigatorProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  /** Overview `changedFiles` count: the authoritative total for progress + truncation. */
  readonly changedFiles: number;
  readonly onDismiss?: () => void;
};

function countViewed(files: PrReviewFile[], isViewed: (path: string) => boolean): number {
  let count = 0;
  for (const file of files) {
    if (isViewed(file.path)) {
      count += 1;
    }
  }
  return count;
}

export function PrDiffFileNavigator({
  owner,
  repo,
  number,
  headSha,
  changedFiles,
  onDismiss,
}: PrDiffFileNavigatorProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const searchRef = useRef<string>('');
  // The navigator is a formSheet whose bottom edge sits on the Android system
  // bar, so the list's bottom content padding carries the system inset.
  const { bottom } = useSafeAreaInsets();
  const listContentStyle = useMemo<ViewStyle>(
    () => ({ paddingBottom: 32 + (Platform.OS === 'android' ? bottom : 0), paddingTop: 8 }),
    [bottom]
  );
  // Re-render trigger when the uncontrolled search field changes — refs
  // alone don't cause re-renders, but we don't want to re-mount the
  // TextInput on every keystroke (per iOS rule), so the value lives in
  // a ref and a version counter drives the filtered list.
  const [searchVersion, setSearchVersion] = useState(0);
  const inputRef = useRef<TextInput | null>(null);

  const { query, files, firstPageErrorState, laterPageError } = usePrReviewFileListQuery({
    owner,
    repo,
    number,
    enabled: true,
  });
  const viewed = usePrReviewViewedFiles({ owner, repo, number }, headSha);
  const fetchAll = useFetchToCompletion(query, changedFiles);

  const hasActiveSearch = searchRef.current.trim().length > 0;

  // Rule 2: an active search drives fetch-to-completion so the filter still
  // searches the full listed set. `run()` no-ops while the first page is in
  // flight, so re-run it reactively once the query becomes eligible (first
  // page settled, more pages remain), and stop once complete or after a
  // surfaced error (the user can then tap the "Failed to load all files"
  // retry to resume). With no active search, pages load on scroll via
  // `onEndReached` instead.
  const runRef = useRef(fetchAll.run);
  runRef.current = fetchAll.run;
  useEffect(() => {
    if (
      hasActiveSearch &&
      !query.isFetching &&
      query.hasNextPage &&
      !fetchAll.isRunning &&
      !fetchAll.error
    ) {
      void runRef.current();
    }
  }, [hasActiveSearch, query.isFetching, query.hasNextPage, fetchAll.isRunning, fetchAll.error]);

  const filtered = useMemo(
    () => filterNavigatorFiles(files, searchRef.current),
    // `searchVersion` is the only thing that signals "the ref changed",
    // so it has to be in the dep list even though `files` is the only
    // real data input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, searchVersion]
  );

  const viewedCount = useMemo(() => countViewed(files, viewed.isViewed), [files, viewed]);

  const handleSelectFile = useCallback(
    (path: string) => {
      requestScrollToFile({ owner, repo, number, path });
      if (onDismiss) {
        onDismiss();
        return;
      }
      if (router.canGoBack()) {
        router.back();
      }
    },
    [owner, repo, number, onDismiss, router]
  );

  const handleToggleViewed = useCallback(
    (path: string) => {
      void viewed.toggle(path);
    },
    [viewed]
  );

  // Cache per-path callbacks so `MemoNavigatorFileRow`'s memo hits across a
  // search re-render. The closures read the latest handlers through refs, so
  // they stay identity-stable (memo keeps hitting) but never go stale when
  // `handleSelectFile` / `handleToggleViewed` change identity (e.g. a head-SHA
  // change swaps `viewed.toggle`).
  const handleSelectFileRef = useRef(handleSelectFile);
  handleSelectFileRef.current = handleSelectFile;
  const handleToggleViewedRef = useRef(handleToggleViewed);
  handleToggleViewedRef.current = handleToggleViewed;

  const rowCallbacksRef = useRef(new Map<string, RowCallbacks>());
  const getRowCallbacks = useCallback((path: string) => {
    let callbacks = rowCallbacksRef.current.get(path);
    if (!callbacks) {
      callbacks = {
        handleSelect: () => {
          handleSelectFileRef.current(path);
        },
        handleToggleViewed: () => {
          handleToggleViewedRef.current(path);
        },
      };
      rowCallbacksRef.current.set(path, callbacks);
    }
    return callbacks;
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: PrReviewFile }) => {
      const callbacks = getRowCallbacks(item.path);
      return (
        <MemoNavigatorFileRow
          file={item}
          viewed={viewed.isViewed(item.path)}
          onSelect={callbacks.handleSelect}
          onToggleViewed={callbacks.handleToggleViewed}
        />
      );
    },
    [viewed, getRowCallbacks]
  );

  if (firstPageErrorState?.kind === 'not-found') {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6 py-12">
          <Text className="text-lg font-semibold text-foreground">
            {t('prReview.pullRequestUnavailable')}
          </Text>
          <Text variant="muted" className="mt-1 text-center">
            {t('prReview.pullRequestUnavailableDescription')}
          </Text>
        </View>
      </View>
    );
  }
  if (firstPageErrorState?.kind === 'permission') {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6 py-12">
          <Text className="text-lg font-semibold text-foreground">
            {t('prReview.accessDenied')}
          </Text>
          <Text variant="muted" className="mt-1 text-center">
            {t('prReview.accessDeniedDescription')}
          </Text>
        </View>
      </View>
    );
  }
  if (firstPageErrorState?.kind === 'retryable' || firstPageErrorState?.kind === 'reconnect') {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-3 px-6 py-12">
          <Text className="text-lg font-semibold text-foreground">
            {t('prReview.fileNavigator.couldNotLoadFiles')}
          </Text>
          <Text variant="muted" className="text-center">
            {t('prReview.fileNavigator.checkConnection')}
          </Text>
          <Pressable
            onPress={() => {
              void query.refetch();
            }}
            className="mt-1 rounded-md border border-border bg-card px-4 py-2 active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={t('prReview.fileNavigator.retryLoadingFiles')}
          >
            <Text className="text-sm font-medium text-foreground">{t('common.retry')}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (query.isLoading && files.length === 0) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-1 gap-3 px-4 pt-2">
          <View className="flex-row items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
            <Search size={16} color={colors.mutedForeground} />
            <TextInput
              ref={inputRef}
              defaultValue=""
              editable={false}
              placeholder={t('prReview.fileNavigator.filterPlaceholder')}
              placeholderTextColor={colors.mutedForeground}
              accessibilityLabel={t('prReview.fileNavigator.filterPlaceholder')}
              className="flex-1 text-sm leading-[normal] text-foreground"
            />
          </View>
          {[0, 1, 2, 3, 4].map(index => (
            <View key={`skeleton-${index}`} className="flex-row items-center gap-3 px-2 py-2">
              <Skeleton className="h-5 w-5 rounded-md" />
              <View className="flex-1 gap-1.5">
                <Skeleton className="h-3.5 w-3/4 rounded-md" />
                <Skeleton className="h-3 w-1/4 rounded-md" />
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }

  if (!query.isLoading && files.length === 0) {
    return (
      <View className="flex-1 bg-background">
        <EmptyState
          icon={Search}
          title={t('prReview.noFilesChanged')}
          description={t('prReview.noFilesChangedDescription')}
        />
      </View>
    );
  }

  const showLoadAllRetry = Boolean(fetchAll.error) && !fetchAll.isRunning && query.hasNextPage;
  // A scroll-triggered later-page failure (no search) retries just that page.
  // `!fetchAll.error` keeps it mutually exclusive with the load-all banner.
  const showLaterPageRetry = laterPageError && !hasActiveSearch && !fetchAll.error;
  const showRetry = showLoadAllRetry || showLaterPageRetry;
  const retryMessage = showLoadAllRetry
    ? t('prReview.fileNavigator.failedToLoadAllFiles')
    : t('prReview.fileNavigator.couldNotLoadMoreFiles');
  const retryLabel = showLoadAllRetry
    ? t('prReview.fileNavigator.retryLoadingAllFiles')
    : t('prReview.fileNavigator.retryLoadingMoreFiles');
  const retryAction = showLoadAllRetry ? fetchAll.run : query.fetchNextPage;
  // Truncated when pagination hasn't finished, errored, or GitHub's 3,000-file
  // listing cap left fewer listed files than the overview's changed-file count.
  const isTruncated = query.hasNextPage || Boolean(fetchAll.error) || changedFiles > files.length;

  return (
    <View className="flex-1 bg-background">
      <View className="mx-4 mt-2 flex-row items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
        <Search size={16} color={colors.mutedForeground} />
        <TextInput
          ref={inputRef}
          defaultValue=""
          placeholder={t('prReview.fileNavigator.filterPlaceholder')}
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel={t('prReview.fileNavigator.filterPlaceholder')}
          onChangeText={value => {
            searchRef.current = value;
            setSearchVersion(version => version + 1);
          }}
          className="flex-1 text-sm leading-[normal] text-foreground"
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>

      <View className="mx-4 mt-2 flex-row items-center justify-between">
        <Text variant="muted" className="text-xs">
          {isTruncated
            ? t('prReview.fileNavigator.viewedOfListed', {
                viewed: viewedCount.toLocaleString(),
                total: files.length.toLocaleString(),
              })
            : t('prReview.fileNavigator.viewedCount', {
                viewed: viewedCount.toLocaleString(),
                total: files.length.toLocaleString(),
              })}
        </Text>
        {fetchAll.isRunning ? (
          <View className="flex-row items-center gap-1.5">
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text variant="muted" className="text-xs">
              {t('prReview.fileNavigator.loadingFiles', {
                loaded: fetchAll.loadedFiles.toLocaleString(),
                total: changedFiles.toLocaleString(),
              })}
            </Text>
          </View>
        ) : null}
      </View>

      {showRetry ? (
        <View className="mx-4 mt-2 flex-row items-center justify-between rounded-md border border-border bg-card px-3 py-2">
          <Text className="text-xs text-destructive">{retryMessage}</Text>
          <Pressable
            onPress={() => void retryAction()}
            className="rounded-md border border-border bg-card px-3 py-1 active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={retryLabel}
          >
            <Text className="text-xs font-medium text-foreground">{t('common.retry')}</Text>
          </Pressable>
        </View>
      ) : null}

      <FlashList
        data={filtered}
        renderItem={renderItem}
        keyExtractor={file => file.path}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={listContentStyle}
        onEndReached={() => {
          // During a search, fetch-to-completion loads pages; a scroll fetch would race it.
          if (!hasActiveSearch && query.hasNextPage && !query.isFetchingNextPage) {
            void query.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          <View className="px-6 py-12">
            <Text variant="muted" className="text-center text-sm">
              {t('prReview.fileNavigator.noMatches', { query: searchRef.current })}
            </Text>
          </View>
        }
      />
    </View>
  );
}
