import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

export default function SessionDetailScreen() {
  const { 'session-id': sessionId } = useLocalSearchParams<{ 'session-id': string }>();

  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
      <Text variant="h2">Agent Session</Text>
      <Text variant="muted">Session: {sessionId}</Text>
      <Text variant="muted">Coming soon</Text>
    </View>
  );
}
