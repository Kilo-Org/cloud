import { View } from 'react-native';

import { Text } from '@/components/ui/text';

type TypingIndicatorProps = {
  isTyping: boolean;
  assistantName?: string;
};

export function TypingIndicator({ isTyping, assistantName }: Readonly<TypingIndicatorProps>) {
  return (
    <View className="h-6 shrink-0 px-4 justify-center">
      {isTyping ? (
        <Text className="text-xs text-muted-foreground animate-pulse">
          {assistantName ?? 'Bot'} is typing...
        </Text>
      ) : null}
    </View>
  );
}
