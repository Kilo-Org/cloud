import { z } from 'zod';
import { sanitizeTabContextText, sanitizeTabContextUrl } from './tab-context-sanitize';

export const MAX_MEMORY_TEXT_LENGTH = 8000;
export const MAX_MEMORY_NOTE_LENGTH = 200;
export const MAX_MEMORY_COUNT = 200;
export const MEMORY_INDEX_ENTRY_COUNT = 20;
export const MEMORY_SEARCH_RESULT_COUNT = 10;

const MEMORY_INDEX_PREVIEW_LENGTH = 80;
const MEMORY_SNIPPET_LENGTH = 200;

export interface AgentMemory {
  id: string;
  text: string;
  note?: string | undefined;
  pageTitle: string;
  pageUrl: string;
  createdAt: number;
  truncated?: boolean | undefined;
}

export type AgentMemoryInput = Omit<AgentMemory, 'id'>;

export interface PendingAgentMemoryDraft {
  text: string;
  note?: string | undefined;
  pageTitle: string;
  pageUrl: string;
  createdAt: number;
  truncated?: boolean | undefined;
}

export const agentMemorySchema = z
  .object({
    createdAt: z.number(),
    id: z.string().min(1),
    note: z.string().max(MAX_MEMORY_NOTE_LENGTH).optional(),
    pageTitle: z.string(),
    pageUrl: z.string(),
    text: z.string(),
    truncated: z.boolean().optional(),
  })
  .strip();

export const agentMemoryInputSchema = z
  .object({
    createdAt: z.number(),
    note: z.string().max(MAX_MEMORY_NOTE_LENGTH).optional(),
    pageTitle: z.string(),
    pageUrl: z.string(),
    text: z.string(),
    truncated: z.boolean().optional(),
  })
  .strip();

export const storedAgentMemoriesSchema = z.array(z.unknown());

export const pendingAgentMemoryDraftSchema = z
  .object({
    createdAt: z.number(),
    note: z.string().max(MAX_MEMORY_NOTE_LENGTH).optional(),
    pageTitle: z.string(),
    pageUrl: z.string(),
    text: z.string(),
    truncated: z.boolean().optional(),
  })
  .strip();

const collapseWhitespace = (value: string): string => value.trim().replaceAll(/\s+/g, ' ');

const singleLinePreview = (value: string, maxLength: number): string => {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return collapsed.slice(0, maxLength);
};

const memorySearchCorpus = (memory: AgentMemory): string =>
  `${memory.text} ${memory.note ?? ''} ${memory.pageTitle} ${memory.pageUrl}`.toLowerCase();

const sortByCreatedAtDesc = <TItem extends { createdAt: number }>(
  items: readonly TItem[]
): TItem[] => [...items].toSorted((left, right) => right.createdAt - left.createdAt);

const formatMemoryDomain = (pageUrl: string): string | undefined => {
  if (pageUrl === '') {
    return undefined;
  }

  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol === 'file:') {
      return undefined;
    }

    return parsed.hostname;
  } catch {
    return undefined;
  }
};

const formatUtcDate = (createdAt: number): string => new Date(createdAt).toISOString().slice(0, 10);

export const buildPendingMemoryDraft = ({
  selectionText,
  pageTitle,
  pageUrl,
  now,
}: {
  selectionText: string | undefined;
  pageTitle: string;
  pageUrl: string;
  now: number;
}): PendingAgentMemoryDraft | undefined => {
  const trimmed = (selectionText ?? '').trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const truncated = trimmed.length > MAX_MEMORY_TEXT_LENGTH;
  const text = truncated ? trimmed.slice(0, MAX_MEMORY_TEXT_LENGTH) : trimmed;

  return {
    createdAt: now,
    pageTitle,
    pageUrl: pageUrl === '' ? '' : sanitizeTabContextUrl(pageUrl),
    text,
    ...(truncated ? { truncated: true } : {}),
  };
};

/**
 * Empty/whitespace queries produce no tokens and therefore no matches.
 * Callers that need "show all" must not call this with an empty query.
 */
export const searchAgentMemories = (
  memories: readonly AgentMemory[],
  query: string
): AgentMemory[] => {
  const tokens = collapseWhitespace(query.toLowerCase())
    .split(' ')
    .filter(token => token.length > 0);

  if (tokens.length === 0) {
    return [];
  }

  const matches = memories.filter(memory => {
    const corpus = memorySearchCorpus(memory);
    return tokens.every(token => corpus.includes(token));
  });

  return sortByCreatedAtDesc(matches).slice(0, MEMORY_SEARCH_RESULT_COUNT);
};

export const formatAgentMemoryIndex = (memories: readonly AgentMemory[]): string | undefined => {
  if (memories.length === 0) {
    return undefined;
  }

  const newest = sortByCreatedAtDesc(memories).slice(0, MEMORY_INDEX_ENTRY_COUNT);
  const lines = newest.map(memory => {
    const previewSource =
      memory.note !== undefined && memory.note.length > 0 ? memory.note : memory.text;
    const preview = sanitizeTabContextText(
      singleLinePreview(previewSource, MEMORY_INDEX_PREVIEW_LENGTH)
    );
    const domain = formatMemoryDomain(memory.pageUrl);
    const date = formatUtcDate(memory.createdAt);
    const suffix = domain === undefined ? `(${date})` : `(${domain}, ${date})`;

    return `- [${memory.id}] ${preview} ${suffix}`;
  });

  const remaining = memories.length - MEMORY_INDEX_ENTRY_COUNT;
  if (remaining > 0) {
    lines.push(`(${remaining} more memories — use search_memories to find them.)`);
  }

  return `<memories count="${memories.length}">\n${lines.join('\n')}\n</memories>`;
};

export const toAgentMemorySnippet = (memory: AgentMemory): string =>
  singleLinePreview(memory.text, MEMORY_SNIPPET_LENGTH);
