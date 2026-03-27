import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { KiloClawChat } from '@/components/kiloclaw/chat';
import { useKiloClawStatus } from '@/lib/hooks/use-kiloclaw';

export default function ChatScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const { data: status } = useKiloClawStatus();
  const isRunning = status?.status === 'running';

  return (
    <View className="flex-1 bg-background">
      <KiloClawChat instanceId={instanceId} enabled={isRunning} />
    </View>
  );
}
