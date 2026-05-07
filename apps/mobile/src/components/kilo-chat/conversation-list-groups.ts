import { type ConversationListItem } from '@kilocode/kilo-chat';

type ConversationListGroupLabel = 'Today' | 'Yesterday' | 'This Week' | 'Older';

type ConversationListGroup = {
  label: ConversationListGroupLabel;
  items: ConversationListItem[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUP_LABELS: readonly ConversationListGroupLabel[] = [
  'Today',
  'Yesterday',
  'This Week',
  'Older',
];

function conversationTimestamp(conversation: ConversationListItem): number {
  return conversation.lastActivityAt ?? conversation.joinedAt;
}

export function groupConversationsByActivity(
  conversations: ConversationListItem[],
  nowMs: number
): ConversationListGroup[] {
  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - DAY_MS;
  const weekStart = todayStart - 6 * DAY_MS;
  const groups: Record<ConversationListGroupLabel, ConversationListItem[]> = {
    Today: [],
    Yesterday: [],
    'This Week': [],
    Older: [],
  };

  for (const conversation of conversations) {
    const timestamp = conversationTimestamp(conversation);
    if (timestamp >= todayStart) {
      groups.Today.push(conversation);
    } else if (timestamp >= yesterdayStart) {
      groups.Yesterday.push(conversation);
    } else if (timestamp >= weekStart) {
      groups['This Week'].push(conversation);
    } else {
      groups.Older.push(conversation);
    }
  }

  return GROUP_LABELS.filter(label => groups[label].length > 0).map(label => ({
    label,
    items: groups[label],
  }));
}
