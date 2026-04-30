import { type MarkBadgeReadResponse } from '@kilocode/notifications';

type MarkConversationAndBadgeReadInput = {
  conversationId: string;
  badgeBucket: string;
  markConversationRead: (conversationId: string) => Promise<void>;
  markBadgeRead: (badgeBucket: string) => Promise<MarkBadgeReadResponse>;
};

export async function markConversationAndBadgeRead({
  conversationId,
  badgeBucket,
  markConversationRead,
  markBadgeRead,
}: MarkConversationAndBadgeReadInput): Promise<MarkBadgeReadResponse> {
  await markConversationRead(conversationId);
  return markBadgeRead(badgeBucket);
}
