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
  limits: z
    .object({
      maxNodeCount: z.number(),
      maxNodeTextLength: z.number(),
      maxTextLength: z.number(),
    })
    .optional(),
  nodes: z.array(pageSnapshotNodeSchema),
  nodesTruncated: z.boolean().optional(),
  snapshotId: z.string().optional(),
  text: z.string(),
  textTruncated: z.boolean().optional(),
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
const defaultSnapshotLimits = {
  maxNodeCount: 80,
  maxNodeTextLength: 500,
  maxTextLength: 8000,
};
const toPageSnapshot = (snapshot: z.infer<typeof pageSnapshotSchema>): PageSnapshot => ({
  limits: snapshot.limits ?? defaultSnapshotLimits,
  nodes: snapshot.nodes.map(toPageSnapshotNode),
  nodesTruncated: snapshot.nodesTruncated ?? false,
  snapshotId: snapshot.snapshotId ?? createSnapshotId(),
  text: snapshot.text,
  textTruncated: snapshot.textTruncated ?? false,
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

const searchableFields = ['text', 'label', 'href', 'role', 'tag'] as const;
const findMatchedField = (
  node: PageSnapshotNode,
  query: string
): (typeof searchableFields)[number] | undefined =>
  searchableFields.find(field => node[field]?.toLowerCase().includes(query.toLowerCase()) === true);
const getExcerpt = (text: string, query: string): string => {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + query.length + 40);

  return text.slice(start, end);
};
const getFindResults = (snapshot: PageSnapshot, query: string) => {
  const nodeMatches = snapshot.nodes.flatMap(node => {
    const matchedField = findMatchedField(node, query);

    return matchedField === undefined ? [] : [{ ...node, matchedField }];
  });
  const pageTextMatch = snapshot.text.toLowerCase().includes(query.toLowerCase())
    ? [
        {
          excerpt: getExcerpt(snapshot.text, query),
          matchedField: 'pageText',
          role: 'document',
          tag: 'body',
        },
      ]
    : [];
  const matches = [...nodeMatches, ...pageTextMatch].toSorted(
    (left, right) =>
      ['text', 'label', 'pageText', 'href', 'role', 'tag'].indexOf(left.matchedField) -
      ['text', 'label', 'pageText', 'href', 'role', 'tag'].indexOf(right.matchedField)
  );
  const maxMatches = 20;

  return {
    matches: matches.slice(0, maxMatches),
    snapshotId: snapshot.snapshotId,
    totalMatches: matches.length,
    truncated: matches.length > maxMatches,
  };
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

  return { ok: true, value: getFindResults(snapshot, query) };
};
