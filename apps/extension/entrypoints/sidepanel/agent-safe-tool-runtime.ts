import { browser } from '#imports';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import { PAGE_SNAPSHOT_MESSAGE, isTabDebuggerResponse } from '@/src/shared/tab-debugger';
import type { EvalTabResult, PageSnapshot, PageSnapshotNode } from '@/src/shared/tab-debugger';

type SafeToolCall = Extract<
  AgentConversationEvent,
  { readonly name: 'find_in_page' | 'get_element_details' | 'get_page_snapshot' }
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isPageSnapshotNode = (value: unknown): value is PageSnapshotNode =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  typeof value['role'] === 'string' &&
  typeof value['tag'] === 'string';

const isPageSnapshot = (value: unknown): value is PageSnapshot =>
  isRecord(value) &&
  Array.isArray(value['nodes']) &&
  value['nodes'].every(node => isPageSnapshotNode(node)) &&
  typeof value['text'] === 'string' &&
  typeof value['title'] === 'string' &&
  typeof value['url'] === 'string';

const readPageSnapshot = async (tabId: number): Promise<EvalTabResult> => {
  const response: unknown = await browser.runtime.sendMessage({
    tabId,
    type: PAGE_SNAPSHOT_MESSAGE,
  });

  if (!isTabDebuggerResponse(response)) {
    return { error: 'Extension background returned an invalid response.', ok: false };
  }

  if (!response.ok) {
    return { error: response.error, ok: false };
  }

  if (response.type !== PAGE_SNAPSHOT_MESSAGE) {
    return { error: 'Extension background returned the wrong response.', ok: false };
  }

  return response.result;
};

const getSnapshot = async (tabId: number): Promise<PageSnapshot | string> => {
  const result = await readPageSnapshot(tabId);

  if (!result.ok) {
    return result.error;
  }

  return isPageSnapshot(result.value) ? result.value : 'Page snapshot was invalid.';
};

const nodeMatchesQuery = (node: PageSnapshotNode, query: string): boolean => {
  const haystack = [node.text, node.label, node.href, node.role, node.tag]
    .filter((value): value is string => value !== undefined)
    .join(' ')
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
};

export const executeSafeToolCall = async (toolCall: SafeToolCall): Promise<EvalTabResult> => {
  const snapshot = await getSnapshot(toolCall.tabId);

  if (typeof snapshot === 'string') {
    return { error: snapshot, ok: false };
  }

  if (toolCall.name === 'get_page_snapshot') {
    return { ok: true, value: snapshot };
  }

  if (toolCall.name === 'get_element_details') {
    const element = snapshot.nodes.find(node => node.id === toolCall.elementId);

    return element === undefined
      ? { error: 'Element was not found in the page snapshot.', ok: false }
      : { ok: true, value: element };
  }

  const query = toolCall.query?.trim();

  if (query === undefined || query === '') {
    return { error: 'Search query is required.', ok: false };
  }

  return { ok: true, value: snapshot.nodes.filter(node => nodeMatchesQuery(node, query)) };
};
