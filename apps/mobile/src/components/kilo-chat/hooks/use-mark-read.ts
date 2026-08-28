import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Sentry from '@sentry/react-native';
import * as Notifications from 'expo-notifications';

import {
  type KiloChatClient,
  type KiloChatOperation,
  type MarkConversationReadResponse,
} from '@kilocode/kilo-chat';
import { type BadgeCountRow } from '@kilocode/notifications';
import { useMarkConversationRead } from '@kilocode/kilo-chat-hooks';

import { useCurrentUserId } from './use-current-user-id';
import { applyBadgeClearResult, markReadConversation } from './mark-read-operation';
import { advanceBadgeFreshnessEpoch, readBadgeFreshnessEpoch } from '@/lib/badge-freshness';

type MarkReadInput = {
  sandboxId: string;
  conversationId: string;
  lastSeenMessageId: string;
  operation: KiloChatOperation;
  userId: string | null;
  markConversationRead: ReturnType<typeof useMarkConversationRead>['mutateAsync'];
};

export function useMarkRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const markConversationRead = useMarkConversationRead(client);
  const mutation = useMutation({
    mutationFn: async ({
      operation,
      markConversationRead: mark,
      ...input
    }: MarkReadInput): Promise<MarkConversationReadResponse> => {
      operation.assertDispatch();
      const result = await markReadConversation({
        ...input,
        markConversationRead: async variables => {
          const response = await mark(variables, undefined, operation);
          return response;
        },
      });
      return result;
    },
    // Background failures retain the existing error state; they never announce locked content.
    onError: (error, input) => {
      if (!input.operation.canPublish()) {
        return;
      }
      Sentry.captureException(error, {
        tags: { 'error.subsystem': 'kilo-chat', 'error.operation': 'mark-conversation-read' },
        extra: { hasUser: input.userId !== null },
      });
    },
    onMutate: input => {
      input.operation.assertDispatch();
      return { startBadgeFreshnessEpoch: advanceBadgeFreshnessEpoch() };
    },
    onSuccess: (result, input, context) => {
      if (!input.operation.canPublish()) {
        return;
      }
      applyBadgeClearResult({
        badgeClear: result.badgeClear,
        startBadgeFreshnessEpoch: context.startBadgeFreshnessEpoch,
        currentBadgeFreshnessEpoch: readBadgeFreshnessEpoch(),
        userId: input.userId,
        updateBadgeRows: (queryKey, updater) => {
          if (input.operation.canPublish()) {
            queryClient.setQueryData<BadgeCountRow[]>(queryKey, updater);
          }
        },
        setBadgeCount: async count => {
          if (input.operation.canPublish()) {
            await Notifications.setBadgeCountAsync(count);
          }
        },
      });
    },
    onSettled: (_data, _error, input) => {
      if (input.userId !== null && input.operation.canPublish()) {
        void queryClient.invalidateQueries({ queryKey: ['badges', input.userId] });
      }
    },
  });

  const sharedMutationRef = useRef(markConversationRead.mutateAsync);
  sharedMutationRef.current = markConversationRead.mutateAsync;
  const { mutateAsync } = mutation;
  return useCallback(
    // eslint-disable-next-line max-params -- preserve the positional API and carry an outer admission
    async (
      sandboxId: string,
      conversationId: string,
      lastSeenMessageId: string,
      supplied?: KiloChatOperation
    ) => {
      // This capture precedes the OUTER mutation's offline/onMutate queue.
      const operation = client.captureOperation(supplied);
      const result = await mutateAsync({
        sandboxId,
        conversationId,
        lastSeenMessageId,
        operation,
        userId,
        markConversationRead: sharedMutationRef.current,
      });
      client.assertOwner();
      return result;
    },
    [client, mutateAsync, userId]
  );
}
