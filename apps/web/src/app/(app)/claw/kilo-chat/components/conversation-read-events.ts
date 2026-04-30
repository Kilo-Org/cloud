export function shouldApplyConversationRead(currentUserId: string, eventMemberId: string): boolean {
  return currentUserId !== '' && eventMemberId === currentUserId;
}
