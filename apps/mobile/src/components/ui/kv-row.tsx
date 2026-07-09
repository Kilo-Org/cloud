import { type LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type KvTone = 'good' | 'warn' | 'danger' | 'muted';

type KvRowProps = {
  icon?: LucideIcon;
  label: string;
  value: string;
  valueTone?: 'default' | KvTone;
  /**
   * Renders a small colored status dot before the label to categorize the row,
   * leaving the value uncolored (mirrors the web dashboard's summary rows). Use
   * this instead of `valueTone` when the count itself shouldn't be tinted — a
   * red "0" or green "0" reads as alarming/false-positive.
   */
  dotTone?: KvTone;
  /** Suppress bottom divider on the last row of a group. */
  last?: boolean;
  className?: string;
  /** Allow the value text to be selected/copied (e.g. identifiers, versions, paths). */
  selectable?: boolean;
};

const VALUE_TONE: Record<NonNullable<KvRowProps['valueTone']>, string> = {
  default: 'text-foreground',
  good: 'text-good',
  warn: 'text-warn',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
};

const DOT_TONE: Record<KvTone, string> = {
  good: 'bg-good',
  warn: 'bg-warn',
  danger: 'bg-destructive',
  muted: 'bg-muted-foreground',
};

/** Label-left / mono-value-right row with hair-soft bottom divider. */
export function KvRow({
  icon: Icon,
  label,
  value,
  valueTone = 'default',
  dotTone,
  last,
  className,
  selectable,
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
        {dotTone ? <View className={cn('size-2 rounded-full', DOT_TONE[dotTone])} /> : null}
        {Icon ? <Icon size={14} color={colors.mutedForeground} /> : null}
        <Text className="text-sm text-muted-foreground">{label}</Text>
      </View>
      <Text
        variant="mono"
        selectable={selectable}
        className={cn('text-[13px]', VALUE_TONE[valueTone])}
      >
        {value}
      </Text>
    </View>
  );
}
