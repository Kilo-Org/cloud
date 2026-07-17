import { type FindingIconKey, type FindingTone } from '@kilocode/app-shared/security-agent';
import { View } from 'react-native';

import {
  FINDING_ICONS,
  FINDING_TONE_TEXT_CLASS,
  findingToneColor,
} from '@/components/security-agent/finding-tone';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type FindingStatusBadgeProps = {
  icon: FindingIconKey;
  label: string;
  tone: FindingTone;
  size?: number;
  /** Set from the presentation's `spinning` field for in-progress states (e.g. queued/analyzing). */
  spinning?: boolean;
};

export function FindingStatusBadge({
  icon,
  label,
  tone,
  size = 14,
  spinning = false,
}: Readonly<FindingStatusBadgeProps>) {
  const colors = useThemeColors();
  const Icon = FINDING_ICONS[icon];

  return (
    <View className="flex-row items-center gap-1.5">
      <SpinningIcon
        icon={Icon}
        size={size}
        color={findingToneColor(colors, tone)}
        spinning={spinning}
      />
      <Text className={cn('text-sm font-medium', FINDING_TONE_TEXT_CLASS[tone])}>{label}</Text>
    </View>
  );
}
