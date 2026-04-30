import { View } from 'react-native';
import { Text } from '@/components/ui/text';

type Props = { isTyping: boolean; name?: string };

export function TypingIndicator({ isTyping, name }: Props) {
  if (!isTyping) {
    return null;
  }
  return (
    <View className="px-4 py-1">
      <Text className="text-xs text-muted-foreground">{name ?? 'Bot'} is typing…</Text>
    </View>
  );
}
