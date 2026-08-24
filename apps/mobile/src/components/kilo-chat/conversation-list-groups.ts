import { type ConversationListItem } from '@kilocode/kilo-chat';

import { i18n } from '@/i18n';

type ConversationListGroupKey = 'today' | 'yesterday' | 'thisWeek' | 'older';

type ConversationListGroup = {
  label: string;
  items: ConversationListItem[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUP_ORDER: readonly ConversationListGroupKey[] = [
  'today',
  'yesterday',
  'thisWeek',
  'older',
];

const GROUP_LABEL_KEYS = {
  today: 'chat.conversationList.today',
  yesterday: 'chat.conversationList.yesterday',
  thisWeek: 'chat.conversationList.thisWeek',
  older: 'chat.conversationList.older',
} as const;

function conversationTimestamp(conversation: ConversationListItem): number {
  return conversation.lastActivityAt ?? conversation.joinedAt;
}

function emptyConversationGroup(): ConversationListItem[] {
  return [];
}

export function groupConversationsByActivity(
  conversations: ConversationListItem[],
  nowMs: number
): ConversationListGroup[] {
  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - DAY_MS;
  const weekStart = todayStart - 6 * DAY_MS;
  const groups = {
    today: emptyConversationGroup(),
    yesterday: emptyConversationGroup(),
    thisWeek: emptyConversationGroup(),
    older: emptyConversationGroup(),
  } satisfies Record<ConversationListGroupKey, ConversationListItem[]>;

  for (const conversation of conversations) {
    const timestamp = conversationTimestamp(conversation);
    if (timestamp >= todayStart) {
      groups.today.push(conversation);
    } else if (timestamp >= yesterdayStart) {
      groups.yesterday.push(conversation);
    } else if (timestamp >= weekStart) {
      groups.thisWeek.push(conversation);
    } else {
      groups.older.push(conversation);
    }
  }

  return GROUP_ORDER.filter(key => groups[key].length > 0).map(key => ({
    label: i18n.t(GROUP_LABEL_KEYS[key]),
    items: groups[key],
  }));
}
