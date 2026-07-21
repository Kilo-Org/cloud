import { type Href, useRouter } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import { Pressable } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type InstancePickerInstance, setInstancePickerBridge } from '@/lib/picker-bridge';
import { cn } from '@/lib/utils';

type InstanceSelectorProps = {
  /**
   * `null` means the user has the default Cloud Agent target selected.
   * Any non-null value is a live `kilo remote` CLI instance the picker
   * chose.
   */
  value: InstancePickerInstance | null;
  /**
   * The list the picker will open with. The route owns the data; the
   * selector just hands it across the bridge. When the list is empty the
   * selector still opens (the picker shows the empty state + Refresh).
   */
  instances: InstancePickerInstance[];
  isLoading: boolean;
  onChange: (value: InstancePickerInstance | null) => void;
  disabled?: boolean;
};

function selectorLabel({
  value,
  isLoading,
}: {
  value: InstancePickerInstance | null;
  isLoading: boolean;
}): string {
  if (value) {
    return `${value.name} · ${value.projectName}`;
  }
  if (isLoading) {
    return 'Loading…';
  }
  return 'Cloud Agent';
}

export function InstanceSelector({
  value,
  instances,
  isLoading,
  onChange,
  disabled = false,
}: Readonly<InstanceSelectorProps>) {
  const router = useRouter();
  const colors = useThemeColors();

  // The Cloud Agent default is always selectable, even when the list is
  // loading or empty — only the "open the picker" path is gated.
  const canOpenPicker = !disabled;
  const label = selectorLabel({ value, isLoading });

  function handlePress() {
    if (!canOpenPicker) {
      return;
    }
    setInstancePickerBridge({
      instances,
      currentValue: value,
      onSelect: onChange,
    });
    router.push('/(app)/agent-chat/instance-picker' as Href);
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={!canOpenPicker}
      accessibilityRole="button"
      accessibilityLabel={`Run on: ${label}`}
      accessibilityState={{ disabled: !canOpenPicker }}
      className={cn(
        'flex-row items-center justify-between rounded-lg border border-border bg-secondary px-3 py-3',
        !canOpenPicker && 'opacity-50'
      )}
    >
      <Text
        className={cn('flex-1 text-base', value ? 'text-foreground' : 'text-muted-foreground')}
        numberOfLines={1}
      >
        {label}
      </Text>
      <ChevronDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}
