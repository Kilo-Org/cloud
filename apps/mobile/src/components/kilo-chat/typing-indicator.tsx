import { View } from 'react-native';
import { Text } from '@/components/ui/text';

type Props = { typingMembers: Map<string, number> };

export function TypingIndicator({ typingMembers }: Props) {
  if (typingMembers.size === 0) {
    return null;
  }

  const names = [...typingMembers.keys()].map(memberId =>
    memberId.startsWith('bot:') ? 'KiloClaw' : 'Someone'
  );
  const text =
    names.length === 1 ? `${names[0]} is typing...` : `${names.join(', ')} are typing...`;

  return (
    <View className="px-4 py-1">
      <Text className="text-xs text-muted-foreground">{text}</Text>
    </View>
  );
}
