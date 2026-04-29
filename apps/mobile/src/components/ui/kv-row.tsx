import { type LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type KvRowProps = {
  icon?: LucideIcon;
  label: string;
  value: string;
  valueTone?: 'default' | 'good' | 'warn' | 'danger' | 'muted';
  /** Suppress bottom divider on the last row of a group. */
  last?: boolean;
  className?: string;
};

const VALUE_TONE: Record<NonNullable<KvRowProps['valueTone']>, string> = {
  default: 'text-foreground',
  good: 'text-good',
  warn: 'text-warn',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
};

/** Label-left / mono-value-right row with hair-soft bottom divider. */
export function KvRow({
  icon: Icon,
  label,
  value,
  valueTone = 'default',
  last,
  className,
}: Readonly<KvRowProps>) {
  const colors = useThemeColors();
  return (
    <View
      className={cn(
        'flex-row items-center justify-between py-3',
        !last && 'border-b-[0.5px] border-hair-soft',
        className
      )}
    >
      <View className="flex-row items-center gap-2">
        {Icon ? <Icon size={14} color={colors.mutedForeground} /> : null}
        <Text className="text-sm text-muted-foreground">{label}</Text>
      </View>
      <Text variant="mono" className={cn('text-[13px]', VALUE_TONE[valueTone])}>
        {value}
      </Text>
    </View>
  );
}
