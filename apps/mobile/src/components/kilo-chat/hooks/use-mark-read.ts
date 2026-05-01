import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { toast } from 'sonner-native';

import {
  badgeBucketForConversation,
  type BadgeCountRow,
  type MarkBadgeReadResponse,
} from '@kilocode/notifications';
import { type KiloChatClient } from '@kilocode/kilo-chat';
import { useMarkConversationRead } from '@kilocode/kilo-chat-hooks';

import { NOTIFICATIONS_URL } from '@/lib/config';

import { useCurrentUserId } from './use-current-user-id';
import { useKiloChatTokenGetter } from './use-kilo-chat-token';
import { markReadConversationAndBadge } from './mark-read-operation';

type MarkReadContext = {
  previousBadges?: BadgeCountRow[];
  queryKey?: readonly ['badges', string];
};

type MarkReadInput = {
  sandboxId: string;
  conversationId: string;
  lastSeenMessageId: string;
  badgeBucket: string;
};

export function useMarkRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const getToken = useKiloChatTokenGetter();
  const markConversationRead = useMarkConversationRead(client);

  const mutation = useMutation({
    mutationFn: async ({
      conversationId,
      lastSeenMessageId,
      badgeBucket,
    }: MarkReadInput): Promise<MarkBadgeReadResponse | null> => {
      const result = await markReadConversationAndBadge({
        conversationId,
        lastSeenMessageId,
        badgeBucket,
        notificationsUrl: NOTIFICATIONS_URL,
        markConversationRead: markConversationRead.mutateAsync,
        getToken,
        fetchBadgeRead: fetch,
      });
      return result;
    },
    onMutate: async ({ badgeBucket }): Promise<MarkReadContext> => {
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
      if (typeof result?.badgeCount === 'number') {
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
    async (sandboxId: string, conversationId: string, lastSeenMessageId: string) => {
      const result = await mutation.mutateAsync({
        sandboxId,
        conversationId,
        lastSeenMessageId,
        badgeBucket: badgeBucketForConversation(sandboxId, conversationId),
      });
      return result;
    },
    [mutation]
  );
}
