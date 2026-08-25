import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check, Info, Lock, Search, SearchX, Unlock } from '@/components/ui/icons';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { repoPickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';
import { filterRepoPickerOptions } from '@/lib/repo-picker-filter';

export default function RepoPickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
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

      return () => {
        repoPickerSlot.clear(UNFENCED_ROUTE_KEY);
        bridgeRef.current = undefined;
      };
    }, [])
  );

  const filtered = useMemo(
    () => filterRepoPickerOptions({ repositories: bridge?.repositories ?? [], search }),
    [bridge, search]
  );

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
    <PickerSheet title={t('agentChat.repoPicker.title')} onDone={closePicker} scrollable={false}>
      <FlatList
        className="flex-1 bg-background"
        data={filtered}
        keyExtractor={repo => `${repo.platform}:${repo.fullName}`}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: bottom }}
        ListHeaderComponent={
          <View className="flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2 mx-4 mb-3 mt-3">
            <Search size={18} color={colors.mutedForeground} />
            <TextInput
              accessibilityLabel={t('agentChat.repoPicker.searchLabel')}
              placeholder={t('agentChat.repoPicker.searchPlaceholder')}
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
              className="h-8 flex-1 p-0 text-base text-foreground"
              style={{ color: colors.foreground }}
              onChangeText={setSearch}
            />
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon={search.trim() ? SearchX : Info}
            placement="top"
            title={
              search.trim()
                ? t('agentChat.repoPicker.noMatches')
                : t('agentChat.repoPicker.noRepositories')
            }
            description={
              search.trim()
                ? t('agentChat.repoPicker.tryDifferentSearch')
                : t('agentChat.repoPicker.noRepositoriesDescription')
            }
          />
        }
        renderItem={({ item: repo }) => (
          <Pressable
            className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary will-change-pressable"
            onPress={() => {
              handleSelect(`${repo.platform}:${repo.fullName}`);
            }}
            accessibilityRole="button"
            accessibilityLabel={repo.fullName}
          >
            {repo.isPrivate ? (
              <Lock size={14} color={colors.mutedForeground} />
            ) : (
              <Unlock size={14} color={colors.mutedForeground} />
            )}
            <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
              {repo.fullName}
            </Text>
            {bridge.currentValue === `${repo.platform}:${repo.fullName}` ? (
              <Check size={18} color={colors.primary} />
            ) : null}
          </Pressable>
        )}
      />
    </PickerSheet>
  );
}
