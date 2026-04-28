import { useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

export function useMarkRead() {
  const trpc = useTRPC();
  const { mutate } = useMutation(
    trpc.user.markChatRead.mutationOptions({
      onSuccess: ({ badgeCount }) => {
        try {
          void Notifications.setBadgeCountAsync(badgeCount);
        } catch {
          // badge update failure must not block
        }
      },
      onError: err => {
        toast.error(err.message || 'Failed to update badge count');
      },
    })
  );

  return useCallback(
    (badgeBucket: string) => {
      mutate({ badgeBucket });
    },
    [mutate]
  );
}
