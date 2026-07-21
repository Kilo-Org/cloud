// File navigator sheet content. The orchestrator mounts this inside the
// `/(app)/pr-review/[owner]/[repo]/[number]/file-navigator` route file
// (which still shows the S4b stub until the orchestrator wires this
// component in at the barrier).
//
// Responsibilities:
//   - share `usePrReviewFileListQuery` with the mounted Files tab so
//     react-query dedupes by key and the navigator and the file list
//     stay in sync
//   - drive `useFetchToCompletion(...).run()` on mount so the full
//     listed file set is available for search/jump
//   - render a search input (uncontrolled per iOS rules: ref +
//     onChangeText, no `value`) and a list of file rows
//   - on tap, `requestScrollToFile(...)` and dismiss
//   - render the four states: loading, retryable (fetch-to-completion
//     error), empty (0 listed files), happy

import { useRouter } from 'expo-router';
import { Search } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

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
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type PrDiffFileNavigatorProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  /** Overview `changedFiles` count: the authoritative total for progress + truncation. */
  readonly changedFiles: number;
  readonly onDismiss?: () => void;
};

function filterFiles(files: PrReviewFile[], query: string): PrReviewFile[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return files;
  }
  return files.filter(file => file.path.toLowerCase().includes(needle));
}

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
  const searchRef = useRef<string>('');
  // Re-render trigger when the uncontrolled search field changes — refs
  // alone don't cause re-renders, but we don't want to re-mount the
  // TextInput on every keystroke (per iOS rule), so the value lives in
  // a ref and a version counter drives the filtered list.
  const [searchVersion, setSearchVersion] = useState(0);
  const inputRef = useRef<TextInput | null>(null);

  const { query, firstPageErrorState } = usePrReviewFileListQuery({
    owner,
    repo,
    number,
    enabled: true,
  });
  const viewed = usePrReviewViewedFiles({ owner, repo, number }, headSha);
  const fetchAll = useFetchToCompletion(query, changedFiles);

  // Drive the query to completion so search/navigation cover the full listed
  // set. `run()` no-ops while the first page is in flight, so re-run it
  // reactively once the query becomes eligible (first page settled, more pages
  // remain), and stop once complete or after a surfaced error (the user can
  // then tap the "Failed to load all files" retry to resume).
  const runRef = useRef(fetchAll.run);
  runRef.current = fetchAll.run;
  useEffect(() => {
    if (!query.isFetching && query.hasNextPage && !fetchAll.isRunning && !fetchAll.error) {
      void runRef.current();
    }
  }, [query.isFetching, query.hasNextPage, fetchAll.isRunning, fetchAll.error]);

  const files = useMemo(() => {
    const all: PrReviewFile[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const f of page.files) {
        all.push(f);
      }
    }
    return all;
  }, [query.data]);

  const filtered = useMemo(
    () => filterFiles(files, searchRef.current),
    // `searchVersion` is the only thing that signals "the ref changed",
    // so it has to be in the dep list even though `files` is the only
    // real data input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, searchVersion]
  );

  const viewedCount = useMemo(() => countViewed(files, viewed.isViewed), [files, viewed]);

  const handleSelectFile = (path: string) => {
    requestScrollToFile({ owner, repo, number, path });
    if (onDismiss) {
      onDismiss();
      return;
    }
    if (router.canGoBack()) {
      router.back();
    }
  };

  if (firstPageErrorState?.kind === 'not-found') {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6 py-12">
          <Text className="text-lg font-semibold text-foreground">Pull request unavailable</Text>
          <Text variant="muted" className="mt-1 text-center">
            This PR can't be opened. It may have been deleted, the repository is private, or the
            Kilo GitHub App isn't installed on it.
          </Text>
        </View>
      </View>
    );
  }
  if (firstPageErrorState?.kind === 'permission') {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6 py-12">
          <Text className="text-lg font-semibold text-foreground">Access denied</Text>
          <Text variant="muted" className="mt-1 text-center">
            You don't have permission to view this pull request.
          </Text>
        </View>
      </View>
    );
  }
  if (firstPageErrorState?.kind === 'retryable' || firstPageErrorState?.kind === 'reconnect') {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-3 px-6 py-12">
          <Text className="text-lg font-semibold text-foreground">Couldn't load files</Text>
          <Text variant="muted" className="text-center">
            Check your connection and try again.
          </Text>
          <Pressable
            onPress={() => {
              void query.refetch();
            }}
            className="mt-1 rounded-md border border-border bg-card px-4 py-2 active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel="Retry loading files"
          >
            <Text className="text-sm font-medium text-foreground">Retry</Text>
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
              placeholder="Filter files by path"
              placeholderTextColor={colors.mutedForeground}
              accessibilityLabel="Filter files by path"
              className="flex-1 text-sm leading-5 text-foreground"
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
          title="No files changed"
          description="This pull request has no file changes."
        />
      </View>
    );
  }

  const showLoadAllRetry = Boolean(fetchAll.error) && !fetchAll.isRunning && query.hasNextPage;
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
          placeholder="Filter files by path"
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel="Filter files by path"
          onChangeText={value => {
            searchRef.current = value;
            setSearchVersion(version => version + 1);
          }}
          className="flex-1 text-sm leading-5 text-foreground"
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>

      <View className="mx-4 mt-2 flex-row items-center justify-between">
        <Text variant="muted" className="text-xs">
          {viewedCount.toLocaleString()} of {files.length.toLocaleString()} viewed
          {isTruncated ? ' of listed files' : ''}
        </Text>
        {fetchAll.isRunning ? (
          <View className="flex-row items-center gap-1.5">
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text variant="muted" className="text-xs">
              Loading {fetchAll.loadedFiles.toLocaleString()} of {changedFiles.toLocaleString()}…
            </Text>
          </View>
        ) : null}
      </View>

      {showLoadAllRetry ? (
        <View className="mx-4 mt-2 flex-row items-center justify-between rounded-md border border-border bg-card px-3 py-2">
          <Text className="text-xs text-destructive">Failed to load all files</Text>
          <Pressable
            onPress={() => {
              void fetchAll.run();
            }}
            className="rounded-md border border-border bg-card px-3 py-1 active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel="Retry loading all files"
          >
            <Text className="text-xs font-medium text-foreground">Retry</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-8 pt-2"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {filtered.length === 0 ? (
          <View className="px-6 py-12">
            <Text variant="muted" className="text-center text-sm">
              No files match "{searchRef.current}"
            </Text>
          </View>
        ) : null}
        {filtered.map(file => (
          <NavigatorFileRow
            key={file.path}
            file={file}
            viewed={viewed.isViewed(file.path)}
            onSelect={() => {
              handleSelectFile(file.path);
            }}
            onToggleViewed={() => {
              void viewed.toggle(file.path);
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}
