import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { formatTypingIndicatorText } from './typing-indicator-text';

type Props = {
  botName?: string | null;
  typingMembers: Map<string, number>;
};

export function TypingIndicator({ botName, typingMembers }: Props) {
  const text = formatTypingIndicatorText({
    botName,
    typingMemberIds: [...typingMembers.keys()],
  });

  return (
    <View className="h-5 justify-center">
      {text ? <Text className="text-xs text-muted-foreground">{text}</Text> : null}
    </View>
  );
}
