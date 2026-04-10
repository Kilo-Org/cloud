import { View } from 'react-native';

import { Text } from '@/components/ui/text';

export function ChatPlaceholder({ message }: { message: string }) {
  return (
    <View className="flex-1 items-center justify-center px-6">
      <Text className="text-center text-sm text-muted-foreground">{message}</Text>
    </View>
  );
}
