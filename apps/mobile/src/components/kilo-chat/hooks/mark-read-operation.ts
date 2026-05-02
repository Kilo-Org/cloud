import { type MarkConversationReadResponse } from '@kilocode/kilo-chat';
import { type BadgeCountRow } from '@kilocode/notifications';

type MarkReadConversationInput = {
  conversationId: string;
  lastSeenMessageId: string;
  markConversationRead: (input: {
    conversationId: string;
    lastSeenMessageId: string;
  }) => Promise<MarkConversationReadResponse>;
};

export async function markReadConversation({
  conversationId,
  lastSeenMessageId,
  markConversationRead,
}: MarkReadConversationInput): Promise<MarkConversationReadResponse> {
  const result = await markConversationRead({ conversationId, lastSeenMessageId });
  return result;
}

type ApplyBadgeClearResultInput = {
  badgeBucket: string;
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
  badgeBucket: string,
  badgeClear: MarkConversationReadResponse['badgeClear']
): BadgeCountRow[] | undefined {
  if (badgeClear === null) {
    return badges;
  }

  return badges?.filter(row => row.badgeBucket !== badgeBucket);
}

export function applyBadgeClearResult({
  badgeBucket,
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
    updateBadgeRows(['badges', userId], badges =>
      filterClearedBadgeBucket(badges, badgeBucket, badgeClear)
    );
  }

  if (currentBadgeFreshnessEpoch !== startBadgeFreshnessEpoch) {
    return false;
  }

  void setBadgeCount(badgeClear.badgeCount);
  return true;
}
