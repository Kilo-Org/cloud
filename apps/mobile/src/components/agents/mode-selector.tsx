import { Pressable } from 'react-native';
import { type Href, useRouter } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';

import { getModeIcon, MODE_OPTIONS, normalizeAgentMode } from '@/components/agents/mode-options';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { setModePickerBridge } from '@/lib/picker-bridge';
import { cn } from '@/lib/utils';

export type AgentMode = 'code' | 'plan' | 'debug' | 'orchestrator' | 'ask';

type ModeSelectorProps = {
  value: AgentMode;
  onChange: (mode: AgentMode) => void;
  disabled?: boolean;
};

export function ModeSelector({ value, onChange, disabled = false }: Readonly<ModeSelectorProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const selectedValue = normalizeAgentMode(value);
  const selectedLabel = MODE_OPTIONS.find(m => m.value === selectedValue)?.label ?? 'Code';
  const ModeIcon = getModeIcon(selectedValue);

  function handlePress() {
    if (disabled) {
      return;
    }
    setModePickerBridge({
      currentValue: selectedValue,
      onSelect: onChange,
    });
    router.push('/(app)/agent-chat/mode-picker' as Href);
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      className={cn(
        'flex-row items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 active:opacity-70',
        disabled && 'opacity-50'
      )}
    >
      <ModeIcon size={14} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{selectedLabel}</Text>
      <ChevronDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}
