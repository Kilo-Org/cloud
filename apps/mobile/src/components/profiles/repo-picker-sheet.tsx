import { type Href, useRouter } from 'expo-router';
import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { EmptyState, StateAction } from '@/components/empty-state';
import {
  filterRepositoryOptions,
  type RepoOption,
  repositoryOptionKey,
} from '@/components/profiles/repo-bindings-model';
import { QueryError } from '@/components/query-error';
import { SheetHeader } from '@/components/sheet-header';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Eyebrow } from '@/components/ui/eyebrow';
import { GitBranch, Lock, Plug, SearchX, Unlock } from '@/components/ui/icons';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { SearchField } from '@/components/ui/search-field';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { dismissSearchPickerKeyboard, SEARCHABLE_PICKER_LIST_PROPS } from '@/lib/picker-list';

type RepoPickerSheetProps = Readonly<{
  repositories: readonly RepoOption[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  selectedKey: string | null;
  onSelect: (repo: RepoOption) => void;
  onClose: () => void;
  /**
   * Where the empty state sends the reader to connect a repository service: the
   * Connected services screen for this scope, so a person with no repository to
   * pick is not left with an empty list and no way forward.
   */
  connectedServicesHref: Href;
}>;

/** Content-shaped rows in the same slot and height as a loaded repo row. */
function RepoPickerSkeleton() {
  return (
    <View className="gap-1">
      {[0, 1, 2, 3].map(index => (
        <RowSkeleton key={index} />
      ))}
    </View>
  );
}

/**
 * One repo option: a private/public lock, the full name, the provider badge and
 * a check on the selected row. The accessible name is the full name — plus the
 * localized privacy qualifier for a private row, because the lock is decorative
 * and a screen reader would otherwise read both kinds of row the same way.
 */
function RepoOptionRow({
  repo,
  isSelected,
  onSelect,
}: Readonly<{ repo: RepoOption; isSelected: boolean; onSelect: () => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <ChoiceRow
      accessibleName={
        repo.private ? t('common.privateRepositoryA11y', { name: repo.fullName }) : repo.fullName
      }
      selected={isSelected}
      onPress={onSelect}
    >
      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        <View
          className="shrink-0"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {repo.private ? (
            <Lock size={14} color={colors.mutedForeground} />
          ) : (
            <Unlock size={14} color={colors.mutedForeground} />
          )}
        </View>
        <Text variant="mono" className="min-w-0 flex-1 text-xs" numberOfLines={1}>
          {repo.fullName}
        </Text>
        <Eyebrow>{repo.platform === 'gitlab' ? 'GL' : 'GH'}</Eyebrow>
      </View>
    </ChoiceRow>
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
  connectedServicesHref,
}: Readonly<RepoPickerSheetProps>) {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  // The sheet presents in place and the caller unmounts it from `onClose`, so
  // the dismissal animation needs a `visible` of its own: closing sets it false,
  // the native sheet slides out, and the caller's close runs from the dismissal
  // report. The sheet therefore stays mounted through that animation.
  const [visible, setVisible] = useState(true);
  // A navigation waits for the same report: pushing while the native sheet is
  // still presented leaves the tap looking dead, because the push lands under a
  // sheet the reader cannot see past (`review-memory-proposal-sheet` and
  // `backend-settings-sheet` hand a route over this way too).
  const afterDismissRef = useRef<Href | null>(null);
  // `Sheet` forwards its own close edge — the finish of the close asked for
  // here — before the finished-dismissal report, so that edge only withdraws
  // the sheet. Clearing the queued route there would drop the navigation the
  // press asked for; `dismissed` owns it.
  const hide = () => {
    setVisible(false);
  };
  const close = (then?: Href) => {
    afterDismissRef.current = then ?? null;
    hide();
  };
  const dismissed = () => {
    const then = afterDismissRef.current;
    afterDismissRef.current = null;
    onClose();
    if (then !== null) {
      router.push(then);
    }
  };
  const visibleRepos = useMemo(
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
        inset="gutter"
        title={t('profiles.loadFailed')}
        onRetry={onRetry}
      />
    );
  } else if (visibleRepos.length === 0) {
    body = (
      <EmptyState
        placement="top"
        compact
        inset="gutter"
        icon={isSearching ? SearchX : GitBranch}
        title={
          isSearching ? t('common.noRepositoriesFound') : t('agentChat.repoPicker.noRepositories')
        }
        description={
          isSearching
            ? t('agents.sessionList.tryDifferentSearch')
            : t('agentChat.repoPicker.noRepositoriesDescription')
        }
        action={
          isSearching ? undefined : (
            <StateAction
              label={t('integrations.sectionTitle')}
              icon={Plug}
              onPress={() => {
                close(connectedServicesHref);
              }}
            />
          )
        }
      />
    );
  } else {
    body = visibleRepos.map(repo => (
      <RepoOptionRow
        key={repositoryOptionKey(repo)}
        repo={repo}
        isSelected={repositoryOptionKey(repo) === selectedKey}
        onSelect={() => {
          dismissSearchPickerKeyboard();
          onSelect(repo);
        }}
      />
    ));
  }

  return (
    <SessionPageSheet visible={visible} onClose={hide} onDismiss={dismissed}>
      <SheetHeader
        title={t('profiles.repoBindings.repo')}
        onDone={() => {
          close();
        }}
        onCancel={() => {
          close();
        }}
        doneLabel={t('common.done')}
        cancelLabel={t('common.cancel')}
        topInset="ios-page-sheet"
      />
      <SearchField
        className="mx-4 my-3"
        placeholder={t('profiles.repoBindings.search')}
        hasText={search !== ''}
        onChangeText={setSearch}
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-4"
        {...SEARCHABLE_PICKER_LIST_PROPS}
        showsVerticalScrollIndicator={false}
      >
        {body}
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
