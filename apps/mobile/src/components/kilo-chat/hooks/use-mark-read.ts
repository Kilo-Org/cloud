import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { toast } from 'sonner-native';

import {
  badgeBucketForConversation,
  type BadgeCountRow,
  type MarkBadgeReadInput,
  type MarkBadgeReadResponse,
  markBadgeReadResponseSchema,
} from '@kilocode/notifications';

import { NOTIFICATIONS_URL } from '@/lib/config';

import { useCurrentUserId } from './use-current-user-id';
import { useKiloChatTokenGetter } from './use-kilo-chat-token';

type MarkReadContext = {
  previousBadges?: BadgeCountRow[];
  queryKey?: readonly ['badges', string];
};

export function useMarkRead() {
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const getToken = useKiloChatTokenGetter();

  const mutation = useMutation({
    mutationFn: async (badgeBucket: string): Promise<MarkBadgeReadResponse> => {
      const token = await getToken();
      const input = { badgeBucket } satisfies MarkBadgeReadInput;
      const response = await fetch(`${NOTIFICATIONS_URL}/v1/badges/mark-read`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error(`Failed to mark badge read: ${response.status}`);
      }
      return markBadgeReadResponseSchema.parse(await response.json());
    },
    onMutate: async (badgeBucket): Promise<MarkReadContext> => {
      if (userId === null) {
        return {};
      }

      const queryKey = ['badges', userId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previousBadges = queryClient.getQueryData<BadgeCountRow[]>(queryKey);

      queryClient.setQueryData<BadgeCountRow[]>(queryKey, badges =>
        badges?.filter(row => row.badgeBucket !== badgeBucket)
      );

      return { previousBadges, queryKey };
    },
    onError: (error, _badgeBucket, context) => {
      if (context?.queryKey && context.previousBadges) {
        queryClient.setQueryData(context.queryKey, context.previousBadges);
      }
      toast.error(error.message);
    },
    onSuccess: result => {
      if (typeof result.badgeCount === 'number') {
        void Notifications.setBadgeCountAsync(result.badgeCount);
      }
    },
    onSettled: () => {
      if (userId !== null) {
        void queryClient.invalidateQueries({ queryKey: ['badges', userId] });
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
