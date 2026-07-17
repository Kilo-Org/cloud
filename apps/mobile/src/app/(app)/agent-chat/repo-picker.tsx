import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check, Info, Lock, Search, SearchX, Unlock } from 'lucide-react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { clearRepoPickerBridge, getRepoPickerBridge } from '@/lib/picker-bridge';
import { filterRepoPickerOptions } from '@/lib/repo-picker-filter';

export default function RepoPickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [bridge, setBridge] = useState(() => getRepoPickerBridge());

  const bridgeRef = useRef(bridge);

  const closePicker = useCallback(() => {
    router.back();
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      const nextBridge = getRepoPickerBridge();
      bridgeRef.current = nextBridge;
      setBridge(nextBridge);
      setSearch('');

      return () => {
        clearRepoPickerBridge();
        bridgeRef.current = null;
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
      clearRepoPickerBridge();
      bridgeRef.current = null;
      closePicker();
    },
    [closePicker]
  );

  if (!bridge) {
    return (
      <PickerSheet title="Select repository" onDone={closePicker} scrollable={false} expired />
    );
  }

  return (
    <PickerSheet title="Select repository" onDone={closePicker} scrollable={false}>
      <FlatList
        className="flex-1 bg-background"
        data={filtered}
        keyExtractor={repo => repo.fullName}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: bottom }}
        ListHeaderComponent={
          <View className="flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2 mx-4 mb-3 mt-3">
            <Search size={18} color={colors.mutedForeground} />
            <TextInput
              placeholder="Search repositories..."
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
            title={search.trim() ? 'No matches' : 'No repositories available'}
            description={
              search.trim()
                ? 'Try a different search term.'
                : 'No repositories are connected to your account.'
            }
          />
        }
        renderItem={({ item: repo }) => (
          <Pressable
            className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary will-change-pressable"
            onPress={() => {
              handleSelect(repo.fullName);
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
            {bridge.currentValue === repo.fullName ? (
              <Check size={18} color={colors.primary} />
            ) : null}
          </Pressable>
        )}
      />
    </PickerSheet>
  );
}
