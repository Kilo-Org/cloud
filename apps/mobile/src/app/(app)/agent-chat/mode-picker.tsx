import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { getModeIcon, MODE_OPTIONS, type ModeOption } from '@/components/agents/mode-options';
import { type AgentMode } from '@/components/agents/mode-selector';
import { PickerSheet } from '@/components/picker-sheet';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { clearModePickerBridge, getModePickerBridge } from '@/lib/picker-bridge';

export default function ModePickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  // Lazy init reads the bridge synchronously on first render — no effect, no
  // "No options available" flash before a later effect populates state.
  const [bridge] = useState(() => getModePickerBridge());

  useEffect(
    () => () => {
      clearModePickerBridge();
    },
    []
  );

  function handleSelect(mode: AgentMode) {
    void Haptics.selectionAsync();
    bridge?.onSelect(mode);
    clearModePickerBridge();
    router.back();
  }

  if (!bridge) {
    return (
      <PickerSheet
        title="Select mode"
        onDone={() => {
          router.back();
        }}
        scrollable={false}
        expired
      />
    );
  }

  const currentValue = bridge.currentValue;

  function renderItem({ item }: { item: ModeOption }) {
    const Icon = getModeIcon(item.value);
    const selected = item.value === currentValue;

    return (
      <Pressable
        className="flex-row items-center gap-3 px-4 py-3.5 active:bg-secondary"
        onPress={() => {
          handleSelect(item.value);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${item.label}: ${item.description}`}
      >
        <Icon size={20} color={colors.foreground} />
        <View className="flex-1">
          <Text className="text-base font-medium text-foreground">{item.label}</Text>
          <Text className="text-sm text-muted-foreground">{item.description}</Text>
        </View>
        {selected && <Check size={18} color={colors.primary} />}
      </Pressable>
    );
  }

  return (
    <PickerSheet
      title="Select mode"
      onDone={() => {
        router.back();
      }}
      scrollable={false}
    >
      <FlatList
        className="flex-1 bg-background"
        data={MODE_OPTIONS}
        keyExtractor={item => item.value}
        renderItem={renderItem}
        ItemSeparatorComponent={() => <View className="mx-4 border-b border-border" />}
      />
    </PickerSheet>
  );
}
