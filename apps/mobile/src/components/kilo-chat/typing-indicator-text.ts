import { i18n } from '@/i18n';
import { formatList } from '@/lib/format';

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
  return i18n.t('chat.typingIndicator.typing', {
    count: names.length,
    name: names[0],
    names: formatList(names, i18n.language),
  });
}
