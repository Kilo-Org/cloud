import { createAssistantMessage } from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import {
  isPersistedScreenshotStub,
  isViewportScreenshotValue,
} from './agent-conversation-persistence';
import type { FetchLike } from './auth';
import { fetchKiloGatewayChatCompletionStream } from './kilo-api-client';
import type { KiloGatewayChatMessage } from './kilo-gateway-chat-client';

export const KEEP_RECENT_EXCHANGES = 2;
/*
 * Manual "Compact now" is explicit: it summarizes the whole conversation (keeps no recent exchange),
 * so the user can compact whenever there is anything to compact. Auto-compaction keeps
 * KEEP_RECENT_EXCHANGES for safer continuity near the context limit.
 */
export const KEEP_RECENT_EXCHANGES_MANUAL = 0;
export const SUMMARY_PREFIX = '🗜️ Compacted earlier context\n\n';

const SUMMARY_SYSTEM_PROMPT =
  'You compress a browser-agent conversation. Produce a concise but complete summary that preserves: the user’s goals and open requests, key findings about the inspected page(s), decisions made, tool actions taken and their results, and anything needed to continue the task. Use compact prose or bullet points. Do not add new actions or speculation.';

const isUserMessage = (event: AgentConversationEvent): boolean =>
  event.type === 'message' && event.role === 'user';

// Keep complete exchanges only: cut just before the Nth-from-last user message so kept
// Events always begin at a user turn and no tool-call/tool-result pair is split.
export const splitEventsForCompaction = (
  events: AgentConversationEvent[],
  keepRecentExchanges: number = KEEP_RECENT_EXCHANGES
): { toKeep: AgentConversationEvent[]; toSummarize: AgentConversationEvent[] } => {
  const userIndexes = events
    .map((event, index) => (isUserMessage(event) ? index : -1))
    .filter(index => index !== -1);

  if (userIndexes.length <= keepRecentExchanges) {
    return { toKeep: events, toSummarize: [] };
  }

  // A keep count of 0 keeps nothing: the cut falls past the last user message (whole transcript).
  const boundary = userIndexes[userIndexes.length - keepRecentExchanges] ?? events.length;

  return {
    toKeep: events.slice(boundary),
    toSummarize: events.slice(0, boundary),
  };
};

/*
 * Whether compacting would actually summarize anything. Gates the "Compact now" button so it is
 * never enabled-but-inert.
 */
export const hasCompactableHistory = (
  events: AgentConversationEvent[],
  keepRecentExchanges: number = KEEP_RECENT_EXCHANGES
): boolean => splitEventsForCompaction(events, keepRecentExchanges).toSummarize.length > 0;

// Cap each tool input/output so a big snapshot or screenshot can't blow up the summarization prompt.
const MAX_TOOL_TEXT_CHARS = 2000;
const truncateToolText = (text: string): string =>
  text.length <= MAX_TOOL_TEXT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_TEXT_CHARS)}… [truncated ${text.length - MAX_TOOL_TEXT_CHARS} chars]`;

const stringifyToolValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const renderEvent = (event: AgentConversationEvent): string | undefined => {
  switch (event.type) {
    case 'message': {
      return `${event.role === 'user' ? 'User' : 'Assistant'}: ${event.text}`;
    }
    case 'thinking': {
      return undefined;
    }
    case 'tool-call': {
      // The tool input carries the facts the next turn needs (the eval code, the query/element).
      const detail =
        event.name === 'eval' ? event.code : (event.query ?? event.elementId ?? event.snapshotId);

      return detail === undefined || detail === ''
        ? `Tool call (${event.name})`
        : `Tool call (${event.name}): ${truncateToolText(detail)}`;
    }
    case 'tool-result': {
      if (!event.ok) {
        return `Tool result (error): ${event.error ?? 'unknown error'}`;
      }

      if (event.value === undefined) {
        return 'Tool result (ok)';
      }

      // A screenshot value is a base64 data URL (live) or a stripped {mediaType, note} stub
      // (after a reload); keep a placeholder out of the summary either way, never the PNG or its JSON.
      if (isViewportScreenshotValue(event.value) || isPersistedScreenshotStub(event.value)) {
        return `Tool result (ok): [${event.value.mediaType} screenshot omitted]`;
      }

      // The result payload (snapshot text, eval return, element details) is often the only record.
      return `Tool result (ok): ${truncateToolText(stringifyToolValue(event.value))}`;
    }
  }
};

export const renderEventsAsTranscript = (events: AgentConversationEvent[]): string =>
  events
    .map(event => renderEvent(event))
    .filter((line): line is string => line !== undefined)
    .join('\n');

export const buildSummarizationMessages = (
  events: AgentConversationEvent[]
): KiloGatewayChatMessage[] => [
  { content: SUMMARY_SYSTEM_PROMPT, role: 'system' },
  {
    content: `Summarize the following conversation so it can continue with less context.\n\n${renderEventsAsTranscript(events)}`,
    role: 'user',
  },
];

interface CompactConversationOptions {
  readonly apiBaseUrl: string;
  readonly events: AgentConversationEvent[];
  readonly fetch: FetchLike;
  readonly keepRecentExchanges?: number;
  readonly model: string;
  readonly organizationId?: string | undefined;
  readonly token: string;
}

export const compactConversationEvents = async ({
  apiBaseUrl,
  events,
  fetch,
  keepRecentExchanges = KEEP_RECENT_EXCHANGES,
  model,
  organizationId,
  token,
}: CompactConversationOptions): Promise<AgentConversationEvent[] | undefined> => {
  const { toKeep, toSummarize } = splitEventsForCompaction(events, keepRecentExchanges);

  if (toSummarize.length === 0) {
    return undefined;
  }

  const completion = await fetchKiloGatewayChatCompletionStream({
    apiBaseUrl,
    fetch,
    messages: buildSummarizationMessages(toSummarize),
    model,
    onContentDelta: () => {},
    organizationId,
    token,
    tools: [],
  });

  const summary = completion.content ?? '';

  if (summary.trim() === '') {
    return undefined;
  }

  return [createAssistantMessage(`${SUMMARY_PREFIX}${summary}`), ...toKeep];
};
