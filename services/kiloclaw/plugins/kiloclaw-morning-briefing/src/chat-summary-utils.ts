const DEFAULT_TIMEZONE = 'UTC';
const ULID_TIME_LENGTH = 10;
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type ChatSummaryMessage = {
  id: string;
  senderId: string;
  deleted: boolean;
};

export type ChatSummaryConversation = {
  conversationId: string;
  title: string | null;
  lastActivityAt: number | null;
  messages: ChatSummaryMessage[];
};

export type ChatSummaryWindow = {
  startMs: number;
  endMs: number;
  dateKey: string;
};

export type ChatSummaryStats = {
  activeConversationCount: number;
  messageCount: number;
  userMessageCount: number;
  botMessageCount: number;
  deletedMessageCount: number;
};

function readDatePart(parts: Intl.DateTimeFormatPart[], type: 'year' | 'month' | 'day'): string {
  const value = parts.find(part => part.type === type)?.value;
  if (!value) throw new Error(`Unable to format ${type}`);
  return value;
}

function dateKeyInZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return `${readDatePart(parts, 'year')}-${readDatePart(parts, 'month')}-${readDatePart(parts, 'day')}`;
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate()
  ).padStart(2, '0')}`;
}

function getTimezoneOffset(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || DEFAULT_TIMEZONE,
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const offset = parts.find(part => part.type === 'timeZoneName')?.value ?? '';
    const match = offset.match(/GMT([+-]\d{2}:\d{2})/);
    if (!match) return 'Z';
    return match[1] === '+00:00' || match[1] === '-00:00' ? 'Z' : match[1];
  } catch {
    return 'Z';
  }
}

function utcMillisForWallTime(dateKey: string, time: string, timezone: string): number {
  const offset = getTimezoneOffset(new Date(`${dateKey}T${time}Z`), timezone || DEFAULT_TIMEZONE);
  return Date.parse(`${dateKey}T${time}${offset}`);
}

export function buildYesterdayChatWindow(now: Date, timezone: string): ChatSummaryWindow {
  const tz = timezone || DEFAULT_TIMEZONE;
  const todayKey = dateKeyInZone(now, tz);
  const yesterdayKey = addDays(todayKey, -1);
  return {
    startMs: utcMillisForWallTime(yesterdayKey, '00:00:00', tz),
    endMs: utcMillisForWallTime(todayKey, '00:00:00', tz),
    dateKey: yesterdayKey,
  };
}

export function buildTodaySoFarChatWindow(now: Date, timezone: string): ChatSummaryWindow {
  const tz = timezone || DEFAULT_TIMEZONE;
  const todayKey = dateKeyInZone(now, tz);
  return {
    startMs: utcMillisForWallTime(todayKey, '00:00:00', tz),
    endMs: now.getTime(),
    dateKey: todayKey,
  };
}

export function ulidToTimestampMs(ulid: string): number | null {
  if (ulid.length < ULID_TIME_LENGTH) return null;
  let value = 0;
  for (const rawChar of ulid.slice(0, ULID_TIME_LENGTH).toUpperCase()) {
    const digit = CROCKFORD_BASE32.indexOf(rawChar);
    if (digit < 0) return null;
    value = value * 32 + digit;
  }
  return Number.isSafeInteger(value) ? value : null;
}

function isBotSender(senderId: string): boolean {
  return senderId.startsWith('bot:');
}

export function summarizeChatActivity(
  conversations: ChatSummaryConversation[],
  window: ChatSummaryWindow
): ChatSummaryStats {
  let messageCount = 0;
  let userMessageCount = 0;
  let botMessageCount = 0;
  let deletedMessageCount = 0;
  const activeConversationIds = new Set<string>();

  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      const timestamp = ulidToTimestampMs(message.id);
      if (timestamp === null || timestamp < window.startMs || timestamp >= window.endMs) {
        continue;
      }

      messageCount += 1;
      if (message.deleted) deletedMessageCount += 1;
      if (isBotSender(message.senderId)) {
        botMessageCount += 1;
      } else {
        userMessageCount += 1;
      }

      activeConversationIds.add(conversation.conversationId);
    }
  }

  return {
    activeConversationCount: activeConversationIds.size,
    messageCount,
    userMessageCount,
    botMessageCount,
    deletedMessageCount,
  };
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function buildChatSummarySectionLines(
  stats: ChatSummaryStats,
  emptyMessage: string
): string[] {
  if (stats.messageCount === 0) {
    return [emptyMessage];
  }

  const lines = [
    `- ${pluralize(stats.messageCount, 'message')} across ${pluralize(
      stats.activeConversationCount,
      'conversation'
    )}.`,
    `- ${pluralize(stats.userMessageCount, 'message')} from you; ${pluralize(
      stats.botMessageCount,
      'reply',
      'replies'
    )} from Kilo.`,
  ];

  if (stats.deletedMessageCount > 0) {
    lines.push(
      `- ${pluralize(stats.deletedMessageCount, 'deleted message')} excluded from content summaries.`
    );
  }

  return lines;
}

export function buildChatSummaryStatus(stats: ChatSummaryStats, periodLabel: string): string {
  if (stats.messageCount === 0) return `0 Kilo Chat messages ${periodLabel}`;
  return `${stats.messageCount} Kilo Chat message(s) across ${stats.activeConversationCount} conversation(s)`;
}
