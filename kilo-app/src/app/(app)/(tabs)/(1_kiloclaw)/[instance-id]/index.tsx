import { useLocalSearchParams } from 'expo-router';
import { MessageSquare } from 'lucide-react-native';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';

export default function ChatScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Chat" />
      <View className="flex-1 items-center justify-center px-6">
        <EmptyState
          icon={MessageSquare}
          title="Chat coming soon"
          description={`Instance: ${instanceId}`}
        />
      </View>
    </View>
  );
}
