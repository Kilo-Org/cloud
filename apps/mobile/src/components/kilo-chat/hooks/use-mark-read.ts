import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Sentry from '@sentry/react-native';
import * as Notifications from 'expo-notifications';

import { type KiloChatClient, type MarkConversationReadResponse } from '@kilocode/kilo-chat';
import { type BadgeCountRow } from '@kilocode/notifications';
import { useMarkConversationRead } from '@kilocode/kilo-chat-hooks';

import { useCurrentUserId } from './use-current-user-id';
import { applyBadgeClearResult, markReadConversation } from './mark-read-operation';
import { advanceBadgeFreshnessEpoch, readBadgeFreshnessEpoch } from '@/lib/badge-freshness';

type MarkReadInput = {
  sandboxId: string;
  conversationId: string;
  lastSeenMessageId: string;
};

export function useMarkRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const markConversationRead = useMarkConversationRead(client);

  const mutation = useMutation({
    mutationFn: async ({
      sandboxId,
      conversationId,
      lastSeenMessageId,
    }: MarkReadInput): Promise<MarkConversationReadResponse> => {
      const result = await markReadConversation({
        sandboxId,
        conversationId,
        lastSeenMessageId,
        markConversationRead: markConversationRead.mutateAsync,
      });
      return result;
    },
    // Mark-read runs in the background (e.g. on scroll/focus) — a user-visible
    // toast for a background failure is noise. Retry happens naturally on the
    // next mark-read trigger; just log so we can see failure rates.
    onError: error => {
      Sentry.captureException(error);
    },
    onMutate: () => ({ startBadgeFreshnessEpoch: advanceBadgeFreshnessEpoch() }),
    onSuccess: (result, _variables, context) => {
      const currentBadgeFreshnessEpoch = readBadgeFreshnessEpoch();
      applyBadgeClearResult({
        badgeClear: result.badgeClear,
        startBadgeFreshnessEpoch: context.startBadgeFreshnessEpoch,
        currentBadgeFreshnessEpoch,
        userId,
        updateBadgeRows: (queryKey, updater) => {
          queryClient.setQueryData<BadgeCountRow[]>(queryKey, updater);
        },
        setBadgeCount: Notifications.setBadgeCountAsync,
      });
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
      });
      return result;
    },
    [mutation]
  );
}
