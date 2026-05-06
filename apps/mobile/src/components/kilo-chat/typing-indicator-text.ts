export function formatTypingIndicatorText({
  botName,
  typingMemberIds,
}: {
  botName?: string | null;
  typingMemberIds: readonly string[];
}): string | null {
  if (typingMemberIds.length === 0) {
    return null;
  }

  const names = typingMemberIds.map(memberId =>
    memberId.startsWith('bot:') ? (botName ?? 'KiloClaw') : 'Someone'
  );
  return names.length === 1 ? `${names[0]} is typing...` : `${names.join(', ')} are typing...`;
}
