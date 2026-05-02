export function shouldApplyConversationRead(
  currentUserId: string | null,
  memberId: string
): boolean {
  return currentUserId !== null && currentUserId === memberId;
}
