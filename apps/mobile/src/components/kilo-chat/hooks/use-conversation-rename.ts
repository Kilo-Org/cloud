import { type KiloChatClient } from '@kilocode/kilo-chat';
import { useCallback, useState } from 'react';

import { useRenameConversation } from './use-conversations';

// Backs the RenameModal for a conversation's options-sheet "Rename" action.
export function useConversationRename(
  client: KiloChatClient,
  conversationId: string,
  sandboxId: string
) {
  const renameConversation = useRenameConversation(client);
  const [renaming, setRenaming] = useState(false);

  const openRename = useCallback(() => {
    setRenaming(true);
  }, []);
  const closeRename = useCallback(() => {
    setRenaming(false);
  }, []);
  const saveRename = useCallback(
    async (name: string) => {
      await renameConversation.mutateAsync({ conversationId, title: name, sandboxId });
    },
    [renameConversation, conversationId, sandboxId]
  );

  return { renaming, openRename, closeRename, saveRename };
}
