import { i18n } from '@/i18n';

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
    memberId.startsWith('bot:')
      ? (botName ?? i18n.t('kiloclaw.title'))
      : i18n.t('chat.typingIndicator.someone')
  );
  return names.length === 1
    ? i18n.t('chat.typingIndicator.oneTyping', { name: names[0] })
    : i18n.t('chat.typingIndicator.manyTyping', { names: names.join(', ') });
}
