import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Check } from '@/components/ui/icons';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';

import { getModeIcon, MODE_OPTIONS } from '@/components/agents/mode-options';
import { type AgentMode } from '@/components/agents/mode-selector';
import {
  dedupeCustomModeOptions,
  ensureSelectedCustomOption,
  type ModeOption,
} from '@/components/agents/mode-normalize';
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
  const custom = ensureSelectedCustomOption(
    dedupeCustomModeOptions(bridge.customOptions ?? []),
    currentValue
  );

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

  const separator = <View className="mx-4 border-b border-border" />;

  return (
    <PickerSheet
      title="Select mode"
      onDone={() => {
        router.back();
      }}
      scrollable={false}
    >
      {custom.length === 0 ? (
        <FlatList
          className="flex-1 bg-background"
          data={MODE_OPTIONS}
          keyExtractor={item => item.value}
          renderItem={renderItem}
          ItemSeparatorComponent={() => separator}
        />
      ) : (
        <ScrollView className="flex-1 bg-background">
          {MODE_OPTIONS.map((item, index) => (
            <View key={item.value}>
              {index > 0 ? separator : null}
              {renderItem({ item })}
            </View>
          ))}
          <Text className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Custom modes
          </Text>
          {custom.map((item, index) => (
            <View key={item.value}>
              {index > 0 ? separator : null}
              {renderItem({ item })}
            </View>
          ))}
        </ScrollView>
      )}
    </PickerSheet>
  );
}
