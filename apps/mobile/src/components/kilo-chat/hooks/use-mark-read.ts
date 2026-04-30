import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { toast } from 'sonner-native';

import { type ListBadgesResponse } from '@kilocode/notifications';
import { type KiloChatClient, type MarkConversationReadResponse } from '@kilocode/kilo-chat';
import { useMarkConversationRead } from '@kilocode/kilo-chat-hooks';

import { useCurrentUserId } from './use-current-user-id';

type MarkReadContext = {
  previousBadges?: ListBadgesResponse;
  queryKey?: readonly ['badges', string];
};

type MarkReadInput = {
  sandboxId: string;
  conversationId: string;
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
    onMutate: async ({ sandboxId, conversationId }): Promise<MarkReadContext> => {
      if (userId === null) {
        return {};
      }

      const queryKey = ['badges', userId] as const;
      await queryClient.cancelQueries({ queryKey });
      const previousBadges = queryClient.getQueryData<ListBadgesResponse>(queryKey);

      queryClient.setQueryData<ListBadgesResponse>(queryKey, badges => {
        if (!badges) {
          return badges;
        }
        const cleared =
          badges.conversations.find(
            row => row.sandboxId === sandboxId && row.conversationId === conversationId
          )?.unreadCount ?? 0;
        return {
          conversations: badges.conversations.filter(
            row => row.sandboxId !== sandboxId || row.conversationId !== conversationId
          ),
          instances: badges.instances
            .map(row =>
              row.sandboxId === sandboxId
                ? { ...row, unreadCount: Math.max(0, row.unreadCount - cleared) }
                : row
            )
            .filter(row => row.unreadCount > 0),
        };
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
  const { mutate } = mutation;

  return useCallback(
    (sandboxId: string, conversationId: string) => {
      mutate({
        sandboxId,
        conversationId,
      });
    },
    [mutate]
  );
}
