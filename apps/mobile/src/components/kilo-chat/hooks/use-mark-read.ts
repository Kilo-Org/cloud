import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { toast } from 'sonner-native';

import { badgeBucketForConversation, type BadgeCountRow } from '@kilocode/notifications';
import { type KiloChatClient, type MarkConversationReadResponse } from '@kilocode/kilo-chat';
import { useMarkConversationRead } from '@kilocode/kilo-chat-hooks';

import { useCurrentUserId } from './use-current-user-id';

type MarkReadContext = {
  previousBadges?: BadgeCountRow[];
  queryKey?: readonly ['badges', string];
};

type MarkReadInput = {
  sandboxId: string;
  conversationId: string;
  badgeBucket: string;
};

export function useMarkRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const markConversationRead = useMarkConversationRead(client);

  const mutation = useMutation({
    mutationFn: async ({
      conversationId,
    }: MarkReadInput): Promise<MarkConversationReadResponse> => {
      const response = await markConversationRead.mutateAsync(conversationId);
      return response;
    },
    onMutate: async ({ badgeBucket }): Promise<MarkReadContext> => {
      if (userId === null) {
        return {};
      }

      const queryKey = ['badges', userId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previousBadges = queryClient.getQueryData<BadgeCountRow[]>(queryKey);

      queryClient.setQueryData<BadgeCountRow[]>(queryKey, badges => {
        if (!badges) {
          return badges;
        }
        return badges.filter(row => row.badgeBucket !== badgeBucket);
      });

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
      mutation.mutate({
        sandboxId,
        conversationId,
        badgeBucket: badgeBucketForConversation(sandboxId, conversationId),
      });
    },
    [mutation]
  );
}
