import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check, Info, Lock, Search, SearchX, Unlock, X } from '@/components/ui/icons';
import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Pressable, type TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { REPO_PLATFORM_LABEL_KEYS, type RepoOption } from '@/lib/picker-bridge';
import { repoPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';
import { filterRepoPickerOptions } from '@/lib/repo-picker-filter';

type PickerListItem =
  | { key: string; kind: 'header'; titleKey: string }
  | { key: string; kind: 'repo'; repo: RepoOption };

export default function RepoPickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  // The input stays urgent; the filtered list trails behind so a typing burst
  // on a large repository list does not filter/reconcile on every key.
  const deferredSearch = useDeferredValue(search);
  const [bridge, setBridge] = useState(() => repoPickerSlot.get(UNFENCED_ROUTE_KEY));
  // The input stays uncontrolled (iOS TextInput rules), so the in-field X
  // clears the native text imperatively while `search` stays the list source.
  const searchInputRef = useRef<TextInput>(null);

  const bridgeRef = useRef(bridge);
  useRouteRegistry(UNFENCED_ROUTE_KEY);

  const handleClearSearch = useCallback(() => {
    searchInputRef.current?.clear();
    setSearch('');
  }, []);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      const nextBridge = repoPickerSlot.get(UNFENCED_ROUTE_KEY);
      bridgeRef.current = nextBridge;
      setBridge(nextBridge);
      setSearch('');
      searchInputRef.current?.clear();

      return () => {
        repoPickerSlot.clear(UNFENCED_ROUTE_KEY);
        bridgeRef.current = undefined;
      };
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
      }));
    }
    const sections = bridge?.sections ?? [];
    const items: PickerListItem[] = [];
    for (const section of sections) {
      if (section.repos.length > 0) {
        items.push({ key: `header:${section.key}`, kind: 'header', titleKey: section.titleKey });
        for (const repo of section.repos) {
          items.push({ key: `${repo.platform}:${repo.fullName}`, kind: 'repo', repo });
        }
      }
    }
    return items;
  }, [bridge, filtered, deferredSearch]);

  const handleSelect = useCallback(
    (repo: string) => {
      void Haptics.selectionAsync();
      bridgeRef.current?.onSelect(repo);
      repoPickerSlot.clear(UNFENCED_ROUTE_KEY);
      bridgeRef.current = undefined;
      closePicker();
    },
    [closePicker]
  );

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.repoPicker.title')}
        onDone={closePicker}
        scrollable={false}
        expired
      />
    );
  }

  return (
    <PickerSheet
      title={t('agentChat.repoPicker.title')}
      onDone={closePicker}
      headerContent={
        <View className="flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2 mx-4 mb-3 mt-3">
          <Search size={18} color={colors.mutedForeground} />
          {/* The placeholder is a single-line Text overlay, not the input's own
              placeholder: Android lays the native hint out at the field's width
              with no line cap, so copy wider than a narrow field wraps onto a
              second line. A tail-ellipsized Text truncates the copy at any width
              instead. The shared box draws the value on one line box and centres
              it, and both texts share `px-0` so the overlay sits exactly where
              the typed text will. */}
          <View className="relative flex-1">
            <Input
              ref={searchInputRef}
              accessibilityLabel={t('agentChat.repoPicker.searchLabel')}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              textAlignVertical="center"
              className="px-0 text-base text-foreground"
              style={{ color: colors.foreground }}
              onChangeText={setSearch}
            />
            {search.length === 0 ? (
              <View className="absolute inset-0 justify-center" pointerEvents="none">
                <Text
                  accessible={false}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  className="text-base leading-[normal] font-normal text-muted-foreground"
                >
                  {t('agentChat.repoPicker.searchPlaceholder')}
                </Text>
              </View>
            ) : null}
          </View>
          {/* In-field clear on every platform: `clearButtonMode` is iOS only,
              so Android otherwise had no way to reset a typed query. */}
          {search.length > 0 ? (
            <Pressable
              onPress={handleClearSearch}
              accessibilityLabel={t('common.clearSearch')}
              accessibilityRole="button"
              hitSlop={12}
              className="active:opacity-70"
            >
              <X size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
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
        // Mapped rows inside the shell ScrollView instead of a FlatList: the
        // FlatList stretches into the space the formSheet offers and its rows
        // painted over the pinned search header while scrolling. The shell
        // scroll view starts below the header, so a row can never overlap it.
        <View>
          {listItems.map(item => {
            if (item.kind === 'header') {
              return (
                <Text
                  key={item.key}
                  className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {t(item.titleKey)}
                </Text>
              );
            }
            const repo = item.repo;
            const platformName = t(REPO_PLATFORM_LABEL_KEYS[repo.platform]);
            const rowLabel = `${platformName} ${repo.fullName}`;
            return (
              <Pressable
                key={item.key}
                className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary will-change-pressable"
                onPress={() => {
                  handleSelect(`${repo.platform}:${repo.fullName}`);
                }}
                accessibilityRole="button"
                accessibilityLabel={rowLabel}
              >
                {repo.isPrivate ? (
                  <Lock size={14} color={colors.mutedForeground} />
                ) : (
                  <Unlock size={14} color={colors.mutedForeground} />
                )}
                <Text
                  className="w-16 shrink-0 text-xs font-medium text-muted-foreground"
                  numberOfLines={1}
                >
                  {platformName}
                </Text>
                <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                  {repo.fullName}
                </Text>
                {bridge.currentValue === `${repo.platform}:${repo.fullName}` ? (
                  <Check size={18} color={colors.primary} />
                ) : null}
              </Pressable>
            );
          })}
          {renderBitbucketNote()}
        </View>
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
      <View className="mx-4 mt-3 gap-1 rounded-lg border border-border bg-card p-3">
        <Text className="text-sm font-semibold text-foreground">
          {t('agentChat.repoPicker.platformBitbucket')}
        </Text>
        <Text variant="muted">{t('agentChat.newSession.bitbucketOrganizationsOnly')}</Text>
      </View>
    );
  }
}
