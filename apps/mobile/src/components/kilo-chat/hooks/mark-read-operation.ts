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
  startBadgeFreshnessEpoch: number;
  currentBadgeFreshnessEpoch: number;
  userId: string | null;
  updateBadgeRows: (
    queryKey: readonly ['badges', string],
    updater: (badges: BadgeCountRow[] | undefined) => BadgeCountRow[] | undefined
  ) => void;
  setBadgeCount: (badgeCount: number) => Promise<unknown>;
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
  startBadgeFreshnessEpoch,
  currentBadgeFreshnessEpoch,
  userId,
  updateBadgeRows,
  setBadgeCount,
}: ApplyBadgeClearResultInput): boolean {
  if (badgeClear === null) {
    return false;
  }

  if (userId !== null) {
    updateBadgeRows(['badges', userId], badges => filterClearedBadgeBucket(badges, badgeClear));
  }

  if (currentBadgeFreshnessEpoch !== startBadgeFreshnessEpoch) {
    return false;
  }

  void setBadgeCount(badgeClear.badgeCount);
  return true;
}
