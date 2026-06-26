import { createAssistantMessage } from './agent-conversation';
import type { AgentConversationEvent } from './agent-conversation';
import type { FetchLike } from './auth';
import { fetchKiloGatewayChatCompletionStream } from './kilo-api-client';
import type { KiloGatewayChatMessage } from './kilo-gateway-chat-client';

export const KEEP_RECENT_EXCHANGES = 2;
/*
 * Manual "Compact now" is explicit, so it keeps only the latest exchange. This lets a user compact
 * a short conversation (2 exchanges) instead of clicking an enabled-but-inert button;
 * auto-compaction stays at KEEP_RECENT_EXCHANGES for safer continuity near the context limit.
 */
export const KEEP_RECENT_EXCHANGES_MANUAL = 1;
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

  const boundary = userIndexes[userIndexes.length - keepRecentExchanges] ?? 0;

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

const renderEvent = (event: AgentConversationEvent): string | undefined => {
  switch (event.type) {
    case 'message': {
      return `${event.role === 'user' ? 'User' : 'Assistant'}: ${event.text}`;
    }
    case 'thinking': {
      return undefined;
    }
    case 'tool-call': {
      return `Tool call (${event.name})`;
    }
    case 'tool-result': {
      return `Tool result (${event.ok ? 'ok' : 'error'})`;
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
