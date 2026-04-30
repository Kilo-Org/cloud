export function shouldApplyConversationRead(
  currentUserId: string | null,
  eventMemberId: string
): boolean {
  return currentUserId !== null && eventMemberId === currentUserId;
}
