import { useFocusEffect, useRouter } from 'expo-router';
import { Info, Lock, SearchX, Unlock } from '@/components/ui/icons';
import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Card } from '@/components/ui/card';
import { SearchField } from '@/components/ui/search-field';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { REPO_PLATFORM_LABEL_KEYS, type RepoOption } from '@/lib/picker-bridge';
import { dismissSearchPickerKeyboard, SEARCHABLE_PICKER_LIST_PROPS } from '@/lib/picker-list';
import { repoPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';
import { filterRepoPickerOptions } from '@/lib/repo-picker-filter';
import { withRtlParagraphMark } from '@/lib/rtl-text';
import { useDetailScreenBottomPadding, useSideInsetMarginStyle } from '@/lib/screen-insets';

type PickerListItem =
  | { key: string; kind: 'header'; titleKey: string }
  | { key: string; kind: 'repo'; repo: RepoOption; showPlatform: boolean };

/**
 * Satisfies the adapter's failure parameter; this surface has no failure arm —
 * a refused tap is the same as the first tap, so it never publishes one.
 */
type PickerSelectionFailure = { readonly kind: 'select-failed' };

export default function RepoPickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const bottomClearance = useDetailScreenBottomPadding();
  const sideInsetMarginStyle = useSideInsetMarginStyle();
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  // The input stays urgent; the filtered list trails behind so a typing burst
  // on a large repository list does not filter/reconcile on every key.
  const deferredSearch = useDeferredValue(search);
  const [bridge, setBridge] = useState(() => repoPickerSlot.get(UNFENCED_ROUTE_KEY));

  const bridgeRef = useRef(bridge);
  useRouteRegistry(UNFENCED_ROUTE_KEY);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      const nextBridge = repoPickerSlot.get(UNFENCED_ROUTE_KEY);
      bridgeRef.current = nextBridge;
      setBridge(nextBridge);
      setSearch('');

      // The bridge outlives a blur: `useRouteRegistry` clears this route's
      // slots when the route unmounts, so a return to a sheet that is still on
      // screen shows its options again instead of the "options expired" shell.
    }, [])
  );

  const filtered = useMemo(
    () =>
      filterRepoPickerOptions({ repositories: bridge?.repositories ?? [], search: deferredSearch }),
    [bridge, deferredSearch]
  );

  // When the search box is empty, render grouped sections (Recently used, then
  // per-provider); when it is non-empty, render the flat filtered list exactly
  // as before.
  const listItems = useMemo<PickerListItem[]>(() => {
    if (deferredSearch.trim()) {
      return filtered.map(repo => ({
        key: `${repo.platform}:${repo.fullName}`,
        kind: 'repo',
        repo,
        // A flat search result has no section header, so the row names its
        // provider itself.
        showPlatform: true,
      }));
    }
    const sections = bridge?.sections ?? [];
    const items: PickerListItem[] = [];
    for (const section of sections) {
      if (section.repos.length > 0) {
        items.push({ key: `header:${section.key}`, kind: 'header', titleKey: section.titleKey });
        for (const repo of section.repos) {
          items.push({
            key: `${repo.platform}:${repo.fullName}`,
            kind: 'repo',
            repo,
            // A provider section header already carries the provider, so
            // repeating it on every row only steals width from the repository
            // name. "Recently used" mixes providers under a header that names
            // none of them, so those rows keep their provider cell.
            showPlatform: section.key === 'recents',
          });
        }
      }
    }
    return items;
  }, [bridge, filtered, deferredSearch]);

  const selection = useSurfaceFeedback<PickerSelectionFailure>();

  const handleSelect = useCallback(
    (repo: string) => {
      if (selection.begin() === null) {
        // A second tap in the dismissal burst must not select and pop again.
        // The attempt stays pending until this route unmounts, which is the
        // adapter's invalidation; a picker that fails to pop therefore keeps
        // refusing rather than popping the screen beneath it.
        return;
      }
      dismissSearchPickerKeyboard();
      bridgeRef.current?.onSelect(repo);
      repoPickerSlot.clear(UNFENCED_ROUTE_KEY);
      bridgeRef.current = undefined;
      closePicker();
    },
    [closePicker, selection]
  );

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.repoPicker.title')}
        onDone={closePicker}
        onCancel={closePicker}
        scrollable={false}
        expired
      />
    );
  }

  return (
    <PickerSheet
      title={t('agentChat.repoPicker.title')}
      onDone={closePicker}
      onCancel={closePicker}
      scrollable={false}
      headerContent={
        <SearchField
          className="mx-4 my-3"
          accessibilityLabel={t('agentChat.repoPicker.searchLabel')}
          placeholder={t('agentChat.repoPicker.searchPlaceholder')}
          hasText={search.length > 0}
          onChangeText={setSearch}
        />
      }
    >
      {listItems.length === 0 ? (
        <EmptyState
          icon={deferredSearch.trim() ? SearchX : Info}
          title={
            deferredSearch.trim()
              ? t('agentChat.repoPicker.noMatches')
              : t('agentChat.repoPicker.noRepositories')
          }
          description={
            deferredSearch.trim()
              ? t('agents.sessionList.tryDifferentSearch')
              : t('agentChat.repoPicker.noRepositoriesDescription')
          }
        />
      ) : (
        // Mapped rows inside the list's own scroll view rather than a virtualized
        // list: the shell keeps its header and the pinned search field above the
        // scroller, so a row can never paint over them. The list owns the sheet's
        // scroll so its search field and rows share one tap contract — the first
        // tap on a row arrives even while the search keyboard is up.
        <ScrollView
          style={sideInsetMarginStyle}
          className="flex-1"
          nestedScrollEnabled
          {...SEARCHABLE_PICKER_LIST_PROPS}
          contentContainerStyle={{ paddingBottom: bottomClearance }}
        >
          {listItems.map(item => {
            if (item.kind === 'header') {
              return <SectionHeader key={item.key} inset label={t(item.titleKey)} />;
            }
            const repo = item.repo;
            const platformName = t(REPO_PLATFORM_LABEL_KEYS[repo.platform]);
            const rowLabel = `${platformName} ${repo.fullName}`;
            const isSelected = bridge.currentValue === `${repo.platform}:${repo.fullName}`;
            return (
              <ChoiceRow
                key={item.key}
                className="border-b-[0.5px] border-hair-soft"
                selected={isSelected}
                accessibleName={rowLabel}
                onPress={() => {
                  handleSelect(`${repo.platform}:${repo.fullName}`);
                }}
              >
                <View className="min-w-0 flex-1 flex-row items-center gap-3">
                  {repo.isPrivate ? (
                    <Lock size={14} color={colors.mutedForeground} />
                  ) : (
                    <Unlock size={14} color={colors.mutedForeground} />
                  )}
                  {/* Middle ellipsis keeps both ends of the name: long names in a
                      large organization share a prefix, so a tail cut made every
                      row look identical and hid the distinguishing suffix. The
                      min-w-0 box truncates inside the row, so the name can never
                      run into the trailing check. */}
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-medium" numberOfLines={1} ellipsizeMode="middle">
                      {repo.fullName}
                    </Text>
                  </View>
                  {/* A recently-used row mixes providers under a header that
                      names none, so it names its own — after the name, where the
                      provider sections put nothing, so every repository name in
                      this list starts on one edge instead of two. */}
                  {item.showPlatform ? (
                    <Text
                      className="shrink-0 text-xs font-medium text-muted-foreground"
                      numberOfLines={1}
                    >
                      {platformName}
                    </Text>
                  ) : null}
                </View>
              </ChoiceRow>
            );
          })}
          {renderBitbucketNote()}
        </ScrollView>
      )}
    </PickerSheet>
  );

  /**
   * Personal Bitbucket never lists repositories (organization-only), so the
   * grouped list would end at GitLab with nothing explaining the gap. The
   * note renders once, after the provider sections, for the scope the rows
   * were published under — the global organization selection can differ from
   * the opening screen's scope (a Continue screen carries the session's own
   * organization), and keying on the global one would contradict real
   * Bitbucket rows or hide the explanation for the scope actually listed.
   * An absent Bitbucket section says nothing about scope: all its rows may
   * be in Recents, or an organization may have no Bitbucket repositories.
   */
  function renderBitbucketNote() {
    if (search.trim() || bridge?.organizationId !== null) {
      return null;
    }
    return (
      <Card className="mx-4 mt-3">
        {/* One sentence, which already names the product: the note carried a
            'Bitbucket' title above it and the body repeated the name. */}
        <Text variant="muted">
          {withRtlParagraphMark(t('agentChat.newSession.bitbucketOrganizationsOnly'))}
        </Text>
      </Card>
    );
  }
}
