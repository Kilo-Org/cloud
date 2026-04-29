import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/status-dot';
import { Text } from '@/components/ui/text';
import { agentColor } from '@/lib/agent-color';
import { cn } from '@/lib/utils';

import { type BotIdentity, DEFAULT_BOT_IDENTITY } from './state';

type CompleteStepProps = {
  botIdentity: BotIdentity | null;
  onOpen: () => void;
};

const WAVE_DELAY_MS = 450;

export function CompleteStep({ botIdentity, onOpen }: Readonly<CompleteStepProps>) {
  const name = botIdentity?.botName ?? DEFAULT_BOT_IDENTITY.botName;
  const emoji = botIdentity?.botEmoji ?? DEFAULT_BOT_IDENTITY.botEmoji;
  const tint = agentColor(emoji);

  // One-shot greeting: the emoji waves hello ~half a second after the tile
  // lands. Subtle but celebratory — signals "your agent just showed up".
  const wave = useSharedValue(0);
  useEffect(() => {
    wave.value = withDelay(
      WAVE_DELAY_MS,
      withSequence(
        withTiming(-12, { duration: 140 }),
        withTiming(12, { duration: 140 }),
        withTiming(-6, { duration: 120 }),
        withTiming(0, { duration: 120 })
      )
    );
  }, [wave]);
  const waveStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${wave.value}deg` }],
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      className="flex-1 items-center justify-center gap-6 px-6"
    >
      <Animated.View
        entering={ZoomIn.springify().damping(10).stiffness(120)}
        className={cn(
          'h-24 w-24 items-center justify-center rounded-3xl border',
          tint.tileBgClass,
          tint.tileBorderClass
        )}
      >
        <Animated.View style={waveStyle}>
          <Text className="text-5xl">{emoji}</Text>
        </Animated.View>
      </Animated.View>

      <View className="items-center gap-2">
        <View className="flex-row items-center gap-2">
          <StatusDot tone="good" />
          <Text variant="eyebrow" className="text-xs">
            Online
          </Text>
        </View>
        <Text className="text-center text-2xl font-semibold">{name} is ready</Text>
        <Text variant="muted" className="text-center text-base">
          All warmed up. Say hi whenever you&apos;re ready.
        </Text>
      </View>

      <Button size="lg" className="w-full" onPress={onOpen}>
        <Text className="text-base">Chat with {name}</Text>
      </Button>
    </Animated.View>
  );
}
