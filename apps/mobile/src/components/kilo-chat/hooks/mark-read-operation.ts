import { type MarkConversationReadResponse } from '@kilocode/kilo-chat';
import { type BadgeCountRow } from '@kilocode/notifications';

type MarkReadConversationInput = {
  sandboxId: string;
  conversationId: string;
  lastSeenMessageId: string;
  markConversationRead: (input: {
    sandboxId: string;
    conversationId: string;
    lastSeenMessageId: string;
  }) => Promise<MarkConversationReadResponse>;
};

export async function markReadConversation({
  sandboxId,
  conversationId,
  lastSeenMessageId,
  markConversationRead,
}: MarkReadConversationInput): Promise<MarkConversationReadResponse> {
  const result = await markConversationRead({ sandboxId, conversationId, lastSeenMessageId });
  return result;
}

type ApplyBadgeClearResultInput = {
  badgeClear: MarkConversationReadResponse['badgeClear'];
  userId: string | null;
  updateBadgeRows: (
    queryKey: readonly ['badges', string],
    updater: (badges: BadgeCountRow[] | undefined) => BadgeCountRow[] | undefined
  ) => void;
};

export function filterClearedBadgeBucket(
  badges: BadgeCountRow[] | undefined,
  badgeClear: MarkConversationReadResponse['badgeClear']
): BadgeCountRow[] | undefined {
  if (badgeClear === null) {
    return badges;
  }

  return badges?.filter(row => row.badgeBucket !== badgeClear.badgeBucket);
}

export function applyBadgeClearResult({
  badgeClear,
  userId,
  updateBadgeRows,
}: ApplyBadgeClearResultInput): void {
  if (badgeClear === null || userId === null) {
    return;
  }

  updateBadgeRows(['badges', userId], badges => filterClearedBadgeBucket(badges, badgeClear));
}
