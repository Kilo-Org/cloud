import { type LucideIcon } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type ActionButtonTone = 'accent' | 'warn' | 'danger' | 'neutral';

type ActionButtonProps = {
  icon: LucideIcon;
  label: string;
  tone?: ActionButtonTone;
  onPress?: () => void;
  disabled?: boolean;
  className?: string;
};

const TONE_TEXT: Record<ActionButtonTone, string> = {
  accent: 'text-foreground',
  warn: 'text-warn',
  danger: 'text-destructive',
  neutral: 'text-foreground',
};

const TONE_ICON: Record<ActionButtonTone, keyof ThemeColors> = {
  accent: 'foreground',
  warn: 'warn',
  danger: 'destructive',
  neutral: 'foreground',
};

/**
 * Flex-1 outlined action button for dashboard grids.
 * Background stays `card`; tone only tints icon + label.
 */
export function ActionButton({
  icon: Icon,
  label,
  tone = 'neutral',
  onPress,
  disabled,
  className,
}: Readonly<ActionButtonProps>) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cn(
        'flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-border bg-card py-3 active:opacity-70',
        disabled && 'opacity-50',
        className
      )}
    >
      <Icon size={16} color={colors[TONE_ICON[tone]]} />
      <Text className={cn('text-[13px] font-semibold', TONE_TEXT[tone])}>{label}</Text>
      <View />
    </Pressable>
  );
}
