import { MessageSquarePlus } from 'lucide-react-native';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type Props = {
  onStart: () => void;
  isStarting: boolean;
};

export function EmptyConversationList({ onStart, isStarting }: Props) {
  return (
    <View className="flex-1 items-center justify-center px-6">
      <EmptyState
        icon={MessageSquarePlus}
        title="No conversations yet"
        description="Start your first conversation with the agent."
        action={
          <Button onPress={onStart} disabled={isStarting}>
            <Text>{isStarting ? 'Starting…' : 'Start a conversation'}</Text>
          </Button>
        }
      />
    </View>
  );
}
