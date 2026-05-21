const DEFAULT_TIMEZONE = 'UTC';
const ULID_TIME_LENGTH = 10;
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BOT_SENDER_PREFIX = 'bot:';

export type ChatSummaryMessage = {
  id: string;
  senderId: string;
  deleted: boolean;
};

export type ChatSummaryConversation = {
  conversationId: string;
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

function utcMillisForWallTime(dateKey: string, time: string, timezone: string): number {
  const tz = timezone || DEFAULT_TIMEZONE;
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  const targetWallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcMs = targetWallMs;

  // Iterate from a UTC guess until formatting that instant in the target zone
  // produces the requested local wall time. This keeps midnight boundaries
  // correct on days where the offset changes between local and UTC midnight.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const renderedWallMs = Date.UTC(
      Number(readDatePart(parts, 'year')),
      Number(readDatePart(parts, 'month')) - 1,
      Number(readDatePart(parts, 'day')),
      Number(parts.find(part => part.type === 'hour')?.value ?? '0'),
      Number(parts.find(part => part.type === 'minute')?.value ?? '0'),
      Number(parts.find(part => part.type === 'second')?.value ?? '0')
    );
    const delta = targetWallMs - renderedWallMs;
    if (delta === 0) return utcMs;
    utcMs += delta;
  }

  return utcMs;
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
  return senderId.startsWith(BOT_SENDER_PREFIX);
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
    // The deleted count overlaps the user/bot totals above; call that out so
    // the breakdown does not read as additional messages.
    const deleted = stats.deletedMessageCount;
    lines.push(
      deleted === 1
        ? '- 1 of those messages was later deleted; its content is excluded from summaries.'
        : `- ${deleted} of those messages were later deleted; their content is excluded from summaries.`
    );
  }

  return lines;
}

/**
 * Italic empty-state lines for the chat-activity sections. Wrapped in
 * `_..._` so they render italic and survive the channel flattener.
 */
export const CHAT_EMPTY_YESTERDAY = '_No Kilo Chat activity yesterday._';
export const CHAT_EMPTY_TODAY = '_No Kilo Chat activity so far today._';

/**
 * Short TL;DR fragment built from yesterday's chat stats. Returns an
 * empty string when there was no activity so the caller can drop it.
 */
export function formatChatTldr(stats: ChatSummaryStats): string {
  if (stats.messageCount <= 0) return '';
  return stats.messageCount === 1
    ? '1 chat message yesterday'
    : `${stats.messageCount} chat messages yesterday`;
}

export function buildChatSummaryStatus(stats: ChatSummaryStats, periodLabel: string): string {
  if (stats.messageCount === 0) return `0 Kilo Chat messages ${periodLabel}`;
  return `${pluralize(stats.messageCount, 'Kilo Chat message')} across ${pluralize(
    stats.activeConversationCount,
    'conversation'
  )}`;
}
