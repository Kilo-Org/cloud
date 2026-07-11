import { formatKiloChatError } from '@kilocode/kilo-chat';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

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
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) {
      router.back();
    }
  }, [conversationId, router]);

  if (!conversationId) {
    return null;
  }

  return (
    <RenameConversationSheet
      initialTitle={initialTitle}
      isSaving={renameConversation.isPending}
      errorText={errorText}
      onCancel={() => {
        router.back();
      }}
      onSave={nextTitle => {
        setErrorText(null);
        renameConversation.mutate(
          { conversationId, title: nextTitle, sandboxId },
          {
            onSuccess: () => {
              router.back();
            },
            onError: err => {
              setErrorText(formatKiloChatError(err, 'Failed to rename conversation'));
            },
          }
        );
      }}
    />
  );
}
