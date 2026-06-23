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
  snapshotId: z.string().optional(),
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
let nextSnapshotId = 1;
const createSnapshotId = (): string => {
  const id = `snapshot-${nextSnapshotId}`;
  nextSnapshotId += 1;
  return id;
};
const snapshotCache = new Map<string, PageSnapshot>();
const getSnapshotCacheKey = (tabId: number, snapshotId: string): string => `${tabId}:${snapshotId}`;
const cacheSnapshot = (tabId: number, snapshot: PageSnapshot): void => {
  snapshotCache.set(getSnapshotCacheKey(tabId, snapshot.snapshotId), snapshot);
};
const getCachedSnapshot = (tabId: number, snapshotId: string): PageSnapshot | undefined =>
  snapshotCache.get(getSnapshotCacheKey(tabId, snapshotId));
const toPageSnapshot = (snapshot: z.infer<typeof pageSnapshotSchema>): PageSnapshot => ({
  nodes: snapshot.nodes.map(toPageSnapshotNode),
  snapshotId: snapshot.snapshotId ?? createSnapshotId(),
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

  if (!snapshot.success) {
    return 'Page snapshot was invalid.';
  }

  const pageSnapshot = toPageSnapshot(snapshot.data);
  cacheSnapshot(tabId, pageSnapshot);

  return pageSnapshot;
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

  if (toolCall.name === 'get_element_details') {
    if (toolCall.snapshotId === undefined) {
      return { error: 'Snapshot id is required.', ok: false };
    }

    const cachedSnapshot = getCachedSnapshot(toolCall.tabId, toolCall.snapshotId);

    if (cachedSnapshot === undefined) {
      return { error: 'Snapshot expired; call get_page_snapshot again.', ok: false };
    }

    const element = cachedSnapshot.nodes.find(node => node.id === toolCall.elementId);

    return element === undefined
      ? { error: 'Element was not found in the page snapshot.', ok: false }
      : { ok: true, value: element };
  }

  const snapshot = await getSnapshot(toolCall.tabId);

  if (typeof snapshot === 'string') {
    return { error: snapshot, ok: false };
  }

  if (toolCall.name === 'get_page_snapshot') {
    return { ok: true, value: snapshot };
  }

  const query = toolCall.query?.trim();

  if (query === undefined || query === '') {
    return { error: 'Search query is required.', ok: false };
  }

  return { ok: true, value: snapshot.nodes.filter(node => nodeMatchesQuery(node, query)) };
};
