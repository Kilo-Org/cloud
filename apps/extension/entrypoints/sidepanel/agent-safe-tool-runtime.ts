import { browser, storage } from '#imports';
import type {
  AgentConversationEvent,
  KiloBrowserToolName,
  SafeToolName,
} from '@/src/shared/agent-conversation';
import { searchAgentMemories, toAgentMemorySnippet } from '@/src/shared/agent-memories';
import { loadAgentMemories } from '@/src/shared/agent-memories-storage';
import { BROWSER_TOOL_MESSAGE, isTabDebuggerResponse } from '@/src/shared/tab-debugger';
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
const runBrowserToolCall = async (toolCall: BrowserToolCall): Promise<EvalTabResult> => {
  const response: unknown = await browser.runtime.sendMessage({
    arguments: toolCall.arguments,
    tabId: toolCall.tabId,
    tool: toolCall.name,
    type: BROWSER_TOOL_MESSAGE,
  });

  if (!isTabDebuggerResponse(response)) {
    return { error: 'Extension background returned an invalid response.', ok: false };
  }

  if (!response.ok) {
    return { error: response.error, ok: false };
  }

  if (response.type !== BROWSER_TOOL_MESSAGE) {
    return { error: 'Extension background returned the wrong response.', ok: false };
  }

  return response.result;
};

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

  return { error: `Tool ${toolCall.name} is not available.`, ok: false };
};

export const createSafeToolExecutor = (): ((
  toolCall: DispatchableToolCall
) => Promise<EvalTabResult>) => runSafeToolCall;

export const executeSafeToolCall = createSafeToolExecutor();
