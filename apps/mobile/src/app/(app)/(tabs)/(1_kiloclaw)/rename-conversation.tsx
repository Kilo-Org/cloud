import { useLocalSearchParams, useRouter } from 'expo-router';

import { RenameConversationSheet } from '@/components/kilo-chat/rename-conversation-sheet';
import { useKiloChatClient } from '@/components/kilo-chat/hooks/use-kilo-chat-client';
import { useRenameConversation } from '@/components/kilo-chat/hooks/use-conversations';

export default function RenameConversationRoute() {
  const router = useRouter();
  const client = useKiloChatClient();
  const { sandboxId, conversationId, title } = useLocalSearchParams<{
    sandboxId: string;
    conversationId?: string;
    title?: string;
  }>();
  const renameConversation = useRenameConversation(client);
  const initialTitle = typeof title === 'string' ? title : '';

  return (
    <RenameConversationSheet
      initialTitle={initialTitle}
      isSaving={renameConversation.isPending}
      onCancel={() => {
        router.back();
      }}
      onSave={nextTitle => {
        if (!conversationId) {
          return;
        }
        renameConversation.mutate(
          { conversationId, title: nextTitle, sandboxId },
          {
            onSuccess: () => {
              router.back();
            },
          }
        );
      }}
    />
  );
}
