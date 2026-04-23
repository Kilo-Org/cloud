import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

import { type BotIdentity, DEFAULT_BOT_IDENTITY } from './state';

type CompleteStepProps = {
  botIdentity: BotIdentity | null;
  onOpen: () => void;
};

export function CompleteStep({ botIdentity, onOpen }: Readonly<CompleteStepProps>) {
  const name = botIdentity?.botName ?? DEFAULT_BOT_IDENTITY.botName;
  const emoji = botIdentity?.botEmoji ?? DEFAULT_BOT_IDENTITY.botEmoji;

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      className="flex-1 items-center justify-center gap-6 px-6"
    >
      <View className="h-24 w-24 items-center justify-center rounded-3xl bg-secondary">
        <Text className="text-5xl">{emoji}</Text>
      </View>
      <View className="gap-2">
        <Text variant="large" className="text-center">
          {name} is ready
        </Text>
        <Text variant="muted" className="text-center">
          Your agent is set up and waiting. Say hi.
        </Text>
      </View>
      <Button size="lg" className="w-full" onPress={onOpen}>
        <Text>Chat with {name}</Text>
      </Button>
    </Animated.View>
  );
}
