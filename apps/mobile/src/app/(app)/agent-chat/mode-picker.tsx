import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { getModeIcon, MODE_OPTIONS, type ModeOption } from '@/components/agents/mode-options';
import { type AgentMode } from '@/components/agents/mode-selector';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { clearModePickerBridge, getModePickerBridge } from '@/lib/picker-bridge';

export default function ModePickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const [currentValue, setCurrentValue] = useState<AgentMode | null>(null);
  const [onSelect, setOnSelect] = useState<((mode: AgentMode) => void) | null>(null);

  useEffect(() => {
    const bridge = getModePickerBridge();
    if (bridge) {
      setCurrentValue(bridge.currentValue);
      // Wrap in a thunk so React doesn't call the function
      setOnSelect(() => bridge.onSelect);
    }
  }, []);

  function handleSelect(mode: AgentMode) {
    void Haptics.selectionAsync();
    onSelect?.(mode);
    clearModePickerBridge();
    router.back();
  }

  if (!onSelect) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-muted-foreground" style={{ color: colors.mutedForeground }}>
          No options available
        </Text>
      </View>
    );
  }

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
          <Text className="text-sm text-muted-foreground" style={{ color: colors.mutedForeground }}>
            {item.description}
          </Text>
        </View>
        {selected && <Check size={18} color={colors.primary} />}
      </Pressable>
    );
  }

  return (
    <FlatList
      className="flex-1 bg-background"
      data={MODE_OPTIONS}
      keyExtractor={item => item.value}
      renderItem={renderItem}
      contentInsetAdjustmentBehavior="automatic"
      ItemSeparatorComponent={() => <View className="mx-4 border-b border-border" />}
    />
  );
}
