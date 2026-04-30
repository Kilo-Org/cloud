import { useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';

import { badgeBucketForConversation } from '@kilocode/notifications';

import { useTRPC } from '@/lib/trpc';

export function useMarkRead() {
  const trpc = useTRPC();
  const mutation = useMutation(
    trpc.user.markChatRead.mutationOptions({
      onSuccess: result => {
        if (typeof result.badgeCount === 'number') {
          void Notifications.setBadgeCountAsync(result.badgeCount);
        }
      },
    })
  );

  return useCallback(
    (sandboxId: string, conversationId: string) => {
      mutation.mutate({
        badgeBucket: badgeBucketForConversation(sandboxId, conversationId),
      });
    },
    [mutation]
  );
}
