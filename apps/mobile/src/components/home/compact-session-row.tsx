import { ChevronRight } from 'lucide-react-native';
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type CompactSessionRowProps = {
  repoName: string | null;
  title: string;
  statusLabel: string | null;
  statusTone: 'running' | 'ready' | 'idle';
  timeLabel: string | null;
  isLive: boolean;
  onPress: () => void;
};

function LiveDot() {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.4, { duration: 1000 }), -1, true);
  }, [opacity]);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return <Animated.View style={pulseStyle} className="h-2 w-2 rounded-full bg-green-500" />;
}

const STATUS_TONE_CLASS: Record<CompactSessionRowProps['statusTone'], string> = {
  running: 'text-green-600 dark:text-green-400',
  ready: 'text-amber-600 dark:text-amber-400',
  idle: 'text-muted-foreground',
};

export function CompactSessionRow({
  repoName,
  title,
  statusLabel,
  statusTone,
  timeLabel,
  isLive,
  onPress,
}: Readonly<CompactSessionRowProps>) {
  const colors = useThemeColors();

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-lg bg-secondary p-3 active:opacity-70"
      accessibilityLabel={title}
    >
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          {repoName ? (
            <Text className="text-xs font-medium text-muted-foreground" numberOfLines={1}>
              {repoName}
            </Text>
          ) : null}
          {isLive ? <LiveDot /> : null}
        </View>
        <Text className="text-sm font-medium" numberOfLines={1}>
          {title}
        </Text>
        <View className="flex-row items-center gap-2">
          {statusLabel ? (
            <Text className={cn('text-xs', STATUS_TONE_CLASS[statusTone])} numberOfLines={1}>
              {statusLabel}
            </Text>
          ) : null}
          {statusLabel && timeLabel ? (
            <Text className="text-xs text-muted-foreground">·</Text>
          ) : null}
          {timeLabel ? <Text className="text-xs text-muted-foreground">{timeLabel}</Text> : null}
        </View>
      </View>
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}
