/* eslint-disable max-lines -- The safe-tool runtime holds snapshot paging, full-text search, and memory reads as one dispatch surface. */
import { browser, storage } from '#imports';
import { z } from 'zod';
import type { AgentConversationEvent, SafeToolName } from '@/src/shared/agent-conversation';
import { searchAgentMemories, toAgentMemorySnippet } from '@/src/shared/agent-memories';
import { loadAgentMemories } from '@/src/shared/agent-memories-storage';
import {
  MAX_SNAPSHOT_TEXT_LENGTH,
  PAGE_SNAPSHOT_MESSAGE,
  VIEWPORT_SCREENSHOT_MESSAGE,
  isTabDebuggerResponse,
} from '@/src/shared/tab-debugger';
import type { EvalTabResult, PageSnapshot, PageSnapshotNode } from '@/src/shared/tab-debugger';

type SafeToolCall = Extract<AgentConversationEvent, { readonly name: SafeToolName }>;
const pageSnapshotNodeSchema = z.object({
  formAction: z.string().optional(),
  formMethod: z.string().optional(),
  href: z.string().optional(),
  id: z.string(),
  label: z.string().optional(),
  name: z.string().optional(),
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
  textMatches: z.array(z.object({ excerpt: z.string(), offset: z.number() })).optional(),
  textStart: z.number().optional(),
  textTotalChars: z.number().optional(),
  textTruncated: z.boolean().optional(),
  title: z.string(),
  totalTextMatches: z.number().optional(),
  url: z.string(),
});
const toPageSnapshotNode = (node: z.infer<typeof pageSnapshotNodeSchema>): PageSnapshotNode => ({
  ...(node.formAction === undefined ? {} : { formAction: node.formAction }),
  ...(node.formMethod === undefined ? {} : { formMethod: node.formMethod }),
  ...(node.href === undefined ? {} : { href: node.href }),
  id: node.id,
  ...(node.label === undefined ? {} : { label: node.label }),
  ...(node.name === undefined ? {} : { name: node.name }),
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
// Last snapshot served per tab, for the unchanged-page fast path. Content only — snapshotId always differs.
type ServedSnapshotsByTab = Map<number, { contentKey: string; snapshotId: string }>;
const getSnapshotCacheKey = (tabId: number, snapshotId: string): string => `${tabId}:${snapshotId}`;
const cacheSnapshot = (tabId: number, snapshot: PageSnapshot): void => {
  snapshotCache.set(getSnapshotCacheKey(tabId, snapshot.snapshotId), snapshot);
};
const getCachedSnapshot = (tabId: number, snapshotId: string): PageSnapshot | undefined =>
  snapshotCache.get(getSnapshotCacheKey(tabId, snapshotId));
// A snapshot always carries its own limits; the fallback only covers a stale injected build, and reads the window size from the one shared constant so it cannot drift.
const defaultSnapshotLimits = {
  maxNodeCount: 80,
  maxNodeTextLength: 500,
  maxTextLength: MAX_SNAPSHOT_TEXT_LENGTH,
};
const toPageSnapshot = (snapshot: z.infer<typeof pageSnapshotSchema>): PageSnapshot => ({
  limits: snapshot.limits ?? defaultSnapshotLimits,
  nodes: snapshot.nodes.map(toPageSnapshotNode),
  nodesTruncated: snapshot.nodesTruncated ?? false,
  snapshotId: snapshot.snapshotId ?? createSnapshotId(),
  text: snapshot.text,
  ...(snapshot.textMatches === undefined ? {} : { textMatches: snapshot.textMatches }),
  textStart: snapshot.textStart ?? 0,
  textTotalChars: snapshot.textTotalChars ?? snapshot.text.length,
  textTruncated: snapshot.textTruncated ?? false,
  title: snapshot.title,
  ...(snapshot.totalTextMatches === undefined
    ? {}
    : { totalTextMatches: snapshot.totalTextMatches }),
  url: snapshot.url,
});

const readPageSnapshot = async (
  tabId: number,
  { query, textStart }: { readonly query?: string; readonly textStart?: number } = {}
): Promise<EvalTabResult> => {
  const response: unknown = await browser.runtime.sendMessage({
    tabId,
    ...(query === undefined ? {} : { query }),
    ...(textStart === undefined ? {} : { textStart }),
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

const getSnapshot = async (
  tabId: number,
  options: { readonly query?: string; readonly textStart?: number } = {}
): Promise<{ error: string; ok: false } | { ok: true; value: PageSnapshot }> => {
  const result = await readPageSnapshot(tabId, options);

  if (!result.ok) {
    return { error: result.error, ok: false };
  }

  const snapshot = pageSnapshotSchema.safeParse(result.value);

  if (!snapshot.success) {
    return { error: 'Page snapshot was invalid.', ok: false };
  }

  const pageSnapshot = toPageSnapshot(snapshot.data);
  cacheSnapshot(tabId, pageSnapshot);

  return { ok: true, value: pageSnapshot };
};

const searchableFields = ['text', 'label', 'href', 'role', 'tag'] as const;
const findMatchedField = (
  node: PageSnapshotNode,
  query: string
): (typeof searchableFields)[number] | undefined =>
  searchableFields.find(field => node[field]?.toLowerCase().includes(query.toLowerCase()) === true);
const getFindResults = (snapshot: PageSnapshot, query: string) => {
  const nodeMatches = snapshot.nodes.flatMap(node => {
    const matchedField = findMatchedField(node, query);

    return matchedField === undefined ? [] : [{ ...node, matchedField }];
  });
  // Full-page text matches come from the injected search, so a fact beyond the bounded snapshot window is still found; the offset lets the model read around a match with get_page_snapshot textStart.
  const textMatches = (snapshot.textMatches ?? []).map(match => ({
    excerpt: match.excerpt,
    matchedField: 'pageText',
    offset: match.offset,
    role: 'document',
    tag: 'body',
  }));
  const merged = [...nodeMatches, ...textMatches].toSorted(
    (left, right) =>
      ['text', 'label', 'pageText', 'href', 'role', 'tag'].indexOf(left.matchedField) -
      ['text', 'label', 'pageText', 'href', 'role', 'tag'].indexOf(right.matchedField)
  );
  const maxMatches = 20;
  const matches = merged.slice(0, maxMatches);
  const totalMatches = nodeMatches.length + (snapshot.totalTextMatches ?? 0);

  return {
    matches,
    ...(textMatches.length > 0
      ? {
          note: 'Each pageText excerpt carries its character offset in the full page text. To read the section around a match, call get_page_snapshot with textStart set near that offset.',
        }
      : {}),
    snapshotId: snapshot.snapshotId,
    totalMatches,
    truncated: totalMatches > matches.length,
  };
};

const runSafeToolCall = async (
  lastServedSnapshotByTab: ServedSnapshotsByTab,
  toolCall: SafeToolCall
): Promise<EvalTabResult> => {
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

  if (toolCall.name === 'get_page_snapshot') {
    const snapshotResult = await getSnapshot(
      toolCall.tabId,
      toolCall.textStart === undefined ? {} : { textStart: toolCall.textStart }
    );

    if (!snapshotResult.ok) {
      return { error: snapshotResult.error, ok: false };
    }

    const snapshot = snapshotResult.value;

    // Serving the same unchanged page again only burns context and invites a snapshot loop; a compact marker tells the model to act on what it already has.
    const contentKey = JSON.stringify({
      nodes: snapshot.nodes,
      text: snapshot.text,
      textStart: snapshot.textStart,
      title: snapshot.title,
      url: snapshot.url,
    });
    const last = lastServedSnapshotByTab.get(toolCall.tabId);
    lastServedSnapshotByTab.set(toolCall.tabId, { contentKey, snapshotId: snapshot.snapshotId });
    if (last !== undefined && last.contentKey === contentKey) {
      return {
        ok: true,
        value: {
          note: `The page is unchanged since snapshot ${last.snapshotId}; a new snapshot would be identical. Act on it now — fill, click, run or save the workflow — instead of taking another snapshot.`,
          snapshotId: last.snapshotId,
          unchanged: true,
        },
      };
    }
    if (snapshot.textTruncated) {
      const nextStart = snapshot.textStart + snapshot.text.length;
      return {
        ok: true,
        value: {
          ...snapshot,
          note: `Page text shows characters ${String(snapshot.textStart)}-${String(nextStart)} of ${String(snapshot.textTotalChars)}. To read on, call get_page_snapshot with textStart: ${String(nextStart)}; to jump to a specific fact, use find_in_page — it searches the full page text.`,
        },
      };
    }
    return { ok: true, value: snapshot };
  }

  const query = toolCall.query?.trim();

  if (query === undefined || query === '') {
    return { error: 'Search query is required.', ok: false };
  }

  // One injection serves both halves of find_in_page: the snapshot nodes and the full-page text matches come from the same walk.
  const snapshotResult = await getSnapshot(toolCall.tabId, { query });

  if (!snapshotResult.ok) {
    return { error: snapshotResult.error, ok: false };
  }

  return { ok: true, value: getFindResults(snapshotResult.value, query) };
};

// One executor per turn: its unchanged-snapshot memory must not cross conversations (or a compaction), where the marker would reference a snapshot the model never saw.
export const createSafeToolExecutor = (): ((toolCall: SafeToolCall) => Promise<EvalTabResult>) => {
  const lastServedSnapshotByTab: ServedSnapshotsByTab = new Map();
  return toolCall => runSafeToolCall(lastServedSnapshotByTab, toolCall);
};

export const executeSafeToolCall = createSafeToolExecutor();
