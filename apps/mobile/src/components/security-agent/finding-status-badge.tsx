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
  /**
   * The label's own text class, for a line that already sets the size of every
   * other item in it. The meta line under a finding's title paints the severity
   * and the lifecycle status at the caption size, so the deadline this badge
   * carries joins them instead of standing a step larger beside the same line.
   */
  textClassName?: string;
};

export function FindingStatusBadge({
  icon,
  label,
  tone,
  size = 14,
  spinning = false,
  textClassName,
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
      <Text className={cn('text-sm font-medium', FINDING_TONE_TEXT_CLASS[tone], textClassName)}>
        {label}
      </Text>
    </View>
  );
}
