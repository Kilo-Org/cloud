import { Settings } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { StatusBadge } from '@/components/kiloclaw/status-badge';
import { Text } from '@/components/ui/text';
import { type InstanceStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type InstanceRowProps = {
  name: string | null | undefined;
  sandboxId: string | null | undefined;
  status: InstanceStatus | null | undefined;
  disabled?: boolean;
  onPress: () => void;
  onSettingsPress: () => void;
};

export function InstanceRow({
  name,
  sandboxId,
  status,
  disabled,
  onPress,
  onSettingsPress,
}: Readonly<InstanceRowProps>) {
  const colors = useThemeColors();

  return (
    <Pressable
      disabled={disabled}
      className="flex-row items-center gap-3 rounded-lg bg-secondary p-3 active:opacity-70 disabled:opacity-50"
      onPress={onPress}
      accessibilityLabel={`Instance ${sandboxId ?? 'unknown'}`}
    >
      <View className="flex-1 gap-1">
        <Text className="text-sm font-medium" numberOfLines={1}>
          {name ?? sandboxId ?? 'Instance'}
        </Text>
        <StatusBadge status={status} />
      </View>
      <Pressable
        disabled={disabled}
        className="items-center justify-center rounded-md bg-muted p-2 active:opacity-70"
        onPress={onSettingsPress}
        accessibilityLabel="Instance settings"
        hitSlop={8}
      >
        <Settings size={18} color={colors.mutedForeground} />
      </Pressable>
    </Pressable>
  );
}
