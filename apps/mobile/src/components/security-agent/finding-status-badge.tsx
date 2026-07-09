import { View } from 'react-native';

import {
  FINDING_ICONS,
  FINDING_TONE_TEXT_CLASS,
  findingToneColor,
} from '@/components/security-agent/finding-tone';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type FindingIconKey, type FindingTone } from '@/lib/security-agent-presentation';
import { cn } from '@/lib/utils';

type FindingStatusBadgeProps = {
  icon: FindingIconKey;
  label: string;
  tone: FindingTone;
  size?: number;
};

export function FindingStatusBadge({
  icon,
  label,
  tone,
  size = 14,
}: Readonly<FindingStatusBadgeProps>) {
  const colors = useThemeColors();
  const Icon = FINDING_ICONS[icon];

  return (
    <View className="flex-row items-center gap-1.5">
      <Icon size={size} color={findingToneColor(colors, tone)} />
      <Text className={cn('text-sm font-medium', FINDING_TONE_TEXT_CLASS[tone])}>{label}</Text>
    </View>
  );
}
