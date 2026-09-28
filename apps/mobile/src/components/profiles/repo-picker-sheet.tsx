import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { EmptyState } from '@/components/empty-state';
import {
  filterRepositoryOptions,
  type RepoOption,
  repositoryOptionKey,
} from '@/components/profiles/repo-bindings-model';
import { QueryError } from '@/components/query-error';
import { SheetHeader } from '@/components/sheet-header';
import { Check, GitBranch, Lock, Search, SearchX, Unlock } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type RepoPickerSheetProps = Readonly<{
  repositories: readonly RepoOption[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  selectedKey: string | null;
  onSelect: (repo: RepoOption) => void;
  onClose: () => void;
}>;

/** Content-shaped rows in the same slot and height as a loaded repo row. */
function RepoPickerSkeleton() {
  return (
    <View className="gap-1 px-4">
      {[0, 1, 2, 3].map(index => (
        <Skeleton key={index} className="h-11 w-full rounded-md bg-muted-soft" />
      ))}
    </View>
  );
}

/**
 * One repo option: a private/public lock, the full name, the provider badge and
 * a check on the selected row. The `accessibilityLabel` is the full name, so a
 * screen reader matches the row by the repository it picks.
 */
function RepoOptionRow({
  repo,
  isSelected,
  onSelect,
}: Readonly<{ repo: RepoOption; isSelected: boolean; onSelect: () => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <Pressable
      className="min-h-11 flex-row items-center gap-2 px-4 active:opacity-70"
      accessibilityRole="button"
      accessibilityLabel={repo.fullName}
      accessibilityState={{ selected: isSelected }}
      onPress={onSelect}
    >
      {repo.private ? (
        <View accessibilityLabel={t('profiles.repoBindings.private')}>
          <Lock size={14} color={colors.mutedForeground} />
        </View>
      ) : (
        <Unlock size={14} color={colors.mutedForeground} />
      )}
      <Text variant="mono" className="min-w-0 flex-1 text-xs" numberOfLines={1}>
        {repo.fullName}
      </Text>
      <Text className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {repo.platform === 'gitlab' ? 'GL' : 'GH'}
      </Text>
      {isSelected ? <Check size={16} color={colors.primary} /> : null}
    </Pressable>
  );
}

/**
 * The repo picker sheet: a search field over the merged GitHub + GitLab options
 * and one tap-to-select row per repository. Mounted only while open, so the
 * search text seeds fresh each time and the provider queries run only then.
 *
 * Rendered through `SessionPageSheet`, so it is a real presented sheet from
 * either call site (the bindings screen or the Overview pins section) rather
 * than content laid into the caller's column. The search field stays urgent
 * while the filtered list trails on `useDeferredValue`, so a typing burst over
 * a large repository list does not filter and reconcile rows on every key.
 * Selection is a tap; there is no drag anywhere in the flow.
 */
export function RepoPickerSheet({
  repositories,
  isLoading,
  isError,
  onRetry,
  selectedKey,
  onSelect,
  onClose,
}: Readonly<RepoPickerSheetProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const visible = useMemo(
    () => filterRepositoryOptions(repositories, deferredSearch),
    [repositories, deferredSearch]
  );
  const isSearching = deferredSearch.trim().length > 0;

  let body = null;
  if (isLoading) {
    body = <RepoPickerSkeleton />;
  } else if (isError) {
    body = (
      <QueryError
        variant="server"
        placement="top"
        title={t('profiles.loadFailed')}
        onRetry={onRetry}
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        icon={isSearching ? SearchX : GitBranch}
        title={
          isSearching
            ? t('codeReviewer.repos.noRepositoriesFound')
            : t('agentChat.repoPicker.noRepositories')
        }
        description={
          isSearching
            ? t('agents.sessionList.tryDifferentSearch')
            : t('agentChat.repoPicker.noRepositoriesDescription')
        }
      />
    );
  } else {
    body = visible.map(repo => (
      <RepoOptionRow
        key={repositoryOptionKey(repo)}
        repo={repo}
        isSelected={repositoryOptionKey(repo) === selectedKey}
        onSelect={() => {
          onSelect(repo);
        }}
      />
    ));
  }

  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={t('profiles.repoBindings.repo')}
        onDone={onClose}
        onCancel={onClose}
        doneLabel={t('common.done')}
        cancelLabel={t('common.cancel')}
        topInset="ios-page-sheet"
      />
      <View className="mx-4 mb-3 mt-3 flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2">
        <Search size={18} color={colors.mutedForeground} />
        <Input
          placeholder={t('profiles.repoBindings.search')}
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
          accessibilityLabel={t('profiles.repoBindings.search')}
          className="flex-1 px-0 text-base text-foreground"
          onChangeText={setSearch}
        />
      </View>
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-4"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {body}
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
