import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { KiloClawChat } from '@/components/kiloclaw/chat';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawStatus } from '@/lib/hooks/use-kiloclaw-queries';

export default function ChatScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const { organizationId } = useInstanceContext(instanceId);
  const { data: status } = useKiloClawStatus(organizationId);
  const isRunning = status?.status === 'running';
  const machineName = status?.name ?? 'Chat';

  return (
    <View className="flex-1 bg-background">
      <KiloClawChat
        instanceId={instanceId}
        name={machineName}
        enabled={isRunning}
        organizationId={organizationId}
      />
    </View>
  );
}
