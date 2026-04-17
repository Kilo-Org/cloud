import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check, Lock, Search } from 'lucide-react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { clearRepoPickerBridge, getRepoPickerBridge } from '@/lib/picker-bridge';

export default function RepoPickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
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

  const filtered = useMemo(() => {
    if (!bridge) {
      return [];
    }
    if (!search) {
      return bridge.repositories;
    }
    const q = search.toLowerCase();
    return bridge.repositories.filter(r => r.fullName.toLowerCase().includes(q));
  }, [bridge, search]);

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
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-muted-foreground">No repositories available</Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <View className="border-b border-border bg-background px-4 pb-3 pt-4">
        <View className="h-11 flex-row items-center justify-center">
          <Text className="text-lg font-semibold text-foreground">Select Repository</Text>
          <Pressable
            onPress={closePicker}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close repository picker"
            className="absolute right-0 rounded-full bg-secondary px-4 py-2 active:opacity-70 will-change-pressable"
          >
            <Text className="text-base font-medium text-foreground">Done</Text>
          </Pressable>
        </View>
        <View className="mt-2 flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2">
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
      </View>

      {filtered.length === 0 ? (
        <View className="items-center justify-center px-6 py-16">
          <Text className="text-center text-sm text-muted-foreground">
            {search.trim() ? 'No repositories match your search' : 'No repositories available'}
          </Text>
        </View>
      ) : (
        filtered.map(repo => (
          <Pressable
            key={repo.fullName}
            className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-secondary will-change-pressable"
            onPress={() => {
              handleSelect(repo.fullName);
            }}
            accessibilityRole="button"
            accessibilityLabel={repo.fullName}
          >
            {repo.isPrivate && <Lock size={14} color={colors.mutedForeground} />}
            <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
              {repo.fullName}
            </Text>
            {bridge.currentValue === repo.fullName ? (
              <Check size={18} color={colors.primary} />
            ) : null}
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}
