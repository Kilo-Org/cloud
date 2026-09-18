import { storage } from '#imports';
import type {
  AgentConversationEvent,
  KiloBrowserToolName,
  SafeToolName,
} from '@/src/shared/agent-conversation';
import { searchAgentMemories, toAgentMemorySnippet } from '@/src/shared/agent-memories';
import { loadAgentMemories } from '@/src/shared/agent-memories-storage';
import { executeKiloBrowserToolCall } from './browser-tool-runtime';
import type { EvalTabResult } from '@/src/shared/tab-debugger';

type SafeToolCall = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;
type BrowserToolCall = Extract<AgentConversationEvent, { readonly name: KiloBrowserToolName }>;
type DispatchableToolCall = SafeToolCall | BrowserToolCall;

/*
 * The browser tools live behind the background browser-tool session; the side
 * panel forwards the call and the upstream arguments verbatim. A call the
 * current mode does not expose never reaches here (the turn runner turns it
 * into a refusal tool result).
 */
const runBrowserToolCall = (toolCall: BrowserToolCall): Promise<EvalTabResult> =>
  executeKiloBrowserToolCall(toolCall);

const isBrowserToolCall = (toolCall: DispatchableToolCall): toolCall is BrowserToolCall =>
  'arguments' in toolCall;

const runSafeToolCall = async (toolCall: DispatchableToolCall): Promise<EvalTabResult> => {
  if (isBrowserToolCall(toolCall)) {
    return runBrowserToolCall(toolCall);
  }

  if (toolCall.name === 'web_search') {
    // Web search needs the caller's auth context; the turn runners route it to executeWebSearchToolCall before this dispatch.
    return { error: 'Web search is not available in this context.', ok: false };
  }

  if (toolCall.name === 'search_memories') {
    const query = toolCall.query?.trim();

    if (query === undefined || query === '') {
      return { error: 'Search query is required.', ok: false };
    }

    const memories = await loadAgentMemories(storage);
    const matches = searchAgentMemories(memories, query);
    const results = matches.map(memory => ({
      createdAt: memory.createdAt,
      id: memory.id,
      ...(memory.note === undefined ? {} : { note: memory.note }),
      pageTitle: memory.pageTitle,
      pageUrl: memory.pageUrl,
      snippet: toAgentMemorySnippet(memory),
      ...(memory.truncated === undefined ? {} : { truncated: memory.truncated }),
    }));

    return matches.length === 0
      ? { ok: true, value: { message: 'No memories matched.', results: [] } }
      : { ok: true, value: { results } };
  }

  if (toolCall.name === 'get_memory') {
    const memoryId = toolCall.memoryId?.trim();

    if (memoryId === undefined || memoryId === '') {
      return { error: 'Memory id is required.', ok: false };
    }

    const memories = await loadAgentMemories(storage);
    const memory = memories.find(entry => entry.id === memoryId);

    return memory === undefined
      ? { error: 'Memory not found.', ok: false }
      : { ok: true, value: memory };
  }

  // Every `SafeToolName` has a handler above; a name added without one lands here instead of reporting a false success.
  return { error: 'This safe tool is not available.', ok: false };
};

export const createSafeToolExecutor = (): ((
  toolCall: DispatchableToolCall
) => Promise<EvalTabResult>) => runSafeToolCall;

export const executeSafeToolCall = createSafeToolExecutor();
