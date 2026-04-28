import { ActivityIndicator } from 'react-native';
import { MessageSquare } from 'lucide-react-native';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type EmptyConversationListProps = {
  onStart: () => Promise<void>;
  isCreating: boolean;
};

export function EmptyConversationList({
  onStart,
  isCreating,
}: Readonly<EmptyConversationListProps>) {
  const colors = useThemeColors();

  return (
    <EmptyState
      icon={MessageSquare}
      title="No conversations yet"
      description="Start a conversation to begin chatting with your sandbox."
      className="flex-1"
      action={
        <Button
          size="lg"
          disabled={isCreating}
          onPress={() => {
            void onStart();
          }}
        >
          {isCreating ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text>Start a conversation</Text>
          )}
        </Button>
      }
    />
  );
}
