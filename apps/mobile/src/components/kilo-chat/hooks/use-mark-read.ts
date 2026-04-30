import { useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';

import { badgeBucketForConversation } from '@kilocode/notifications';

import { NOTIFICATIONS_URL } from '@/lib/config';

import { useKiloChatTokenGetter } from './use-kilo-chat-token';

export function useMarkRead() {
  const getToken = useKiloChatTokenGetter();

  const mutation = useMutation({
    mutationFn: async (badgeBucket: string): Promise<{ badgeCount: number }> => {
      const token = await getToken();
      const response = await fetch(`${NOTIFICATIONS_URL}/v1/badges/mark-read`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ badgeBucket }),
      });
      if (!response.ok) {
        throw new Error(`Failed to mark badge read: ${response.status}`);
      }
      return (await response.json()) as { badgeCount: number };
    },
    onSuccess: result => {
      if (typeof result.badgeCount === 'number') {
        void Notifications.setBadgeCountAsync(result.badgeCount);
      }
    },
  });

  return useCallback(
    (sandboxId: string, conversationId: string) => {
      mutation.mutate(badgeBucketForConversation(sandboxId, conversationId));
    },
    [mutation]
  );
}
