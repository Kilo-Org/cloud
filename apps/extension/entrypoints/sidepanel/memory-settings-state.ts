import type { AgentMemory } from '@/src/shared/agent-memories';
import { buildMemoryPreviewLabel } from './pending-memory-save-card-state';

export type MemoriesSettingsView =
  | { kind: 'loading' }
  | { kind: 'loadError' }
  | { kind: 'empty' }
  | { kind: 'list'; items: readonly MemorySettingsListItem[] };

export interface MemorySettingsListItem {
  id: string;
  preview: string;
  domain: string | undefined;
  dateLabel: string;
  deleteAriaLabel: string;
}

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

export const formatMemoryListDate = (createdAt: number): string =>
  new Date(createdAt).toISOString().slice(0, 10);

export const toMemorySettingsListItem = (memory: AgentMemory): MemorySettingsListItem => {
  const preview = buildMemoryPreviewLabel(memory);
  return {
    dateLabel: formatMemoryListDate(memory.createdAt),
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
}: {
  isLoaded: boolean;
  loadError: boolean;
  memories: readonly AgentMemory[];
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

  return {
    items: sortByCreatedAtDesc(memories).map(entry => toMemorySettingsListItem(entry)),
    kind: 'list',
  };
};
