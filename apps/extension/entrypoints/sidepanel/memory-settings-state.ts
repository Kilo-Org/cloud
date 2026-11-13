import type { AgentMemory } from '@/src/shared/agent-memories';
import { memoryMatchesSearchTokens, parseMemorySearchTokens } from '@/src/shared/agent-memories';
import { formatLocalListDate } from './format-local-date';
import { buildMemoryPreviewLabel } from './pending-memory-save-card-state';

export type MemoriesSettingsView =
  | { kind: 'loading' }
  | { kind: 'loadError' }
  | { kind: 'empty' }
  | { kind: 'noMatches' }
  | { kind: 'list'; items: readonly MemorySettingsListItem[] };

export interface MemorySettingsListItem {
  id: string;
  preview: string;
  domain: string | undefined;
  dateLabel: string;
  deleteAriaLabel: string;
}

export const MEMORY_FILTER_MIN_COUNT = 3;

const sortByCreatedAtDesc = (memories: readonly AgentMemory[]): AgentMemory[] =>
  [...memories].toSorted((left, right) => right.createdAt - left.createdAt);

export const formatMemorySourceDomain = (pageUrl: string): string | undefined => {
  if (pageUrl === '') {
    return undefined;
  }

  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol === 'file:') {
      return undefined;
    }

    return parsed.hostname === '' ? undefined : parsed.hostname;
  } catch {
    return undefined;
  }
};

export const toMemorySettingsListItem = (memory: AgentMemory): MemorySettingsListItem => {
  const preview = buildMemoryPreviewLabel(memory);
  return {
    dateLabel: formatLocalListDate(memory.createdAt),
    deleteAriaLabel: `Delete memory "${preview}"`,
    domain: formatMemorySourceDomain(memory.pageUrl),
    id: memory.id,
    preview,
  };
};

export const deriveMemoriesSettingsView = ({
  isLoaded,
  loadError,
  memories,
  query,
}: {
  isLoaded: boolean;
  loadError: boolean;
  memories: readonly AgentMemory[];
  query: string;
}): MemoriesSettingsView => {
  if (!isLoaded) {
    return { kind: 'loading' };
  }

  if (loadError) {
    return { kind: 'loadError' };
  }

  if (memories.length === 0) {
    return { kind: 'empty' };
  }

  const tokens = parseMemorySearchTokens(query);
  const matches =
    tokens.length === 0
      ? memories
      : memories.filter(memory => memoryMatchesSearchTokens(tokens, memory));

  if (matches.length === 0) {
    return { kind: 'noMatches' };
  }

  return {
    items: sortByCreatedAtDesc(matches).map(entry => toMemorySettingsListItem(entry)),
    kind: 'list',
  };
};
