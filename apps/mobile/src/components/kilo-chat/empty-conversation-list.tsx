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
    <View className="min-h-[420px] flex-1 items-center justify-center px-6">
      <EmptyState
        icon={MessageSquarePlus}
        title="No conversations yet"
        description="Create a conversation to start chatting with your KiloClaw instance."
        action={
          <Button className="h-11 px-5" onPress={onStart} disabled={isStarting}>
            <Text>{isStarting ? 'Starting…' : 'Create conversation'}</Text>
          </Button>
        }
      />
    </View>
  );
}
