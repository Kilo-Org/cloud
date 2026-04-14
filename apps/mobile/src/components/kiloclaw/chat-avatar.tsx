import { View } from 'react-native';
import { type MessageAvatarProps, useMessageContext } from 'stream-chat-expo';

import logo from '@/../assets/images/logo.png';
import { Image } from '@/components/ui/image';

export function KiloClawMessageAvatar(_props: MessageAvatarProps) {
  const { message, lastGroupMessage } = useMessageContext();
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- message can be undefined at runtime in reply swipe context
  const isBotMessage = message?.user?.id?.startsWith('bot-');

  if (!lastGroupMessage) {
    return <View className="w-8" />;
  }

  if (isBotMessage) {
    return (
      <View className="mr-2 h-8 w-8">
        <Image
          source={logo}
          className="h-8 w-8 rounded-full"
          accessibilityLabel="KiloClaw"
          transition={0}
        />
      </View>
    );
  }

  return <View className="w-8" />;
}
