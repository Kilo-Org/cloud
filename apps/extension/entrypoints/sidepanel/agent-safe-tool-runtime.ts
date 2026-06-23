import { browser } from '#imports';
import { z } from 'zod';
import type { AgentConversationEvent, SafeToolName } from '@/src/shared/agent-conversation';
import {
  PAGE_SNAPSHOT_MESSAGE,
  VIEWPORT_SCREENSHOT_MESSAGE,
  isTabDebuggerResponse,
} from '@/src/shared/tab-debugger';
import type { EvalTabResult, PageSnapshot, PageSnapshotNode } from '@/src/shared/tab-debugger';

type SafeToolCall = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;
const pageSnapshotNodeSchema = z.object({
  href: z.string().optional(),
  id: z.string(),
  label: z.string().optional(),
  role: z.string(),
  state: z.record(z.string(), z.boolean()).optional(),
  tag: z.string(),
  text: z.string().optional(),
});
const pageSnapshotSchema = z.object({
  nodes: z.array(pageSnapshotNodeSchema),
  text: z.string(),
  title: z.string(),
  url: z.string(),
});
const toPageSnapshotNode = (node: z.infer<typeof pageSnapshotNodeSchema>): PageSnapshotNode => ({
  ...(node.href === undefined ? {} : { href: node.href }),
  id: node.id,
  ...(node.label === undefined ? {} : { label: node.label }),
  role: node.role,
  ...(node.state === undefined ? {} : { state: node.state }),
  tag: node.tag,
  ...(node.text === undefined ? {} : { text: node.text }),
});
const toPageSnapshot = (snapshot: z.infer<typeof pageSnapshotSchema>): PageSnapshot => ({
  nodes: snapshot.nodes.map(toPageSnapshotNode),
  text: snapshot.text,
  title: snapshot.title,
  url: snapshot.url,
});

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

const readViewportScreenshot = async (tabId: number): Promise<EvalTabResult> => {
  const response: unknown = await browser.runtime.sendMessage({
    tabId,
    type: VIEWPORT_SCREENSHOT_MESSAGE,
  });

  if (!isTabDebuggerResponse(response)) {
    return { error: 'Extension background returned an invalid response.', ok: false };
  }

  if (!response.ok) {
    return { error: response.error, ok: false };
  }

  if (response.type !== VIEWPORT_SCREENSHOT_MESSAGE) {
    return { error: 'Extension background returned the wrong response.', ok: false };
  }

  return response.result;
};

const getSnapshot = async (tabId: number): Promise<PageSnapshot | string> => {
  const result = await readPageSnapshot(tabId);

  if (!result.ok) {
    return result.error;
  }

  const snapshot = pageSnapshotSchema.safeParse(result.value);

  return snapshot.success ? toPageSnapshot(snapshot.data) : 'Page snapshot was invalid.';
};

const nodeMatchesQuery = (node: PageSnapshotNode, query: string): boolean => {
  const haystack = [node.text, node.label, node.href, node.role, node.tag]
    .filter((value): value is string => value !== undefined)
    .join(' ')
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
};

export const executeSafeToolCall = async (toolCall: SafeToolCall): Promise<EvalTabResult> => {
  if (toolCall.name === 'get_viewport_screenshot') {
    return readViewportScreenshot(toolCall.tabId);
  }

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
