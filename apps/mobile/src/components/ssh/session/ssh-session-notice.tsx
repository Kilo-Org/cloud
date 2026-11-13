import { type ReactNode } from 'react';
import { View } from 'react-native';

import { type LucideIcon } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const TONE_CLASS = {
  warn: 'border-warn-tile-border bg-warn-tile-bg',
  danger: 'border-danger-tile-border bg-danger-tile-bg',
} as const;

type SshSessionNoticeProps = Readonly<{
  tone: keyof typeof TONE_CLASS;
  icon: LucideIcon;
  title: string;
  message: string;
  action?: ReactNode;
}>;

/**
 * The strip that names why a session is not usable and what to do about it. It
 * sits under the header rather than over the terminal, so the last lines the
 * shell printed stay readable while the connection is retried.
 */
export function SshSessionNotice({
  tone,
  icon: Icon,
  title,
  message,
  action,
}: SshSessionNoticeProps) {
  const colors = useThemeColors();
  const tint = tone === 'danger' ? colors.destructive : colors.warn;

  return (
    <View className={cn('gap-2 border-b px-4 py-3', TONE_CLASS[tone])}>
      <View className="flex-row items-center gap-2">
        <Icon size={16} color={tint} />
        <Text className="text-sm font-medium text-foreground">{title}</Text>
      </View>
      <Text className="text-xs text-muted-foreground">{message}</Text>
      {action}
    </View>
  );
}
