import type { AgentMemory, PendingAgentMemoryDraft } from '@/src/shared/agent-memories';
import { MAX_MEMORY_COUNT, MAX_MEMORY_NOTE_LENGTH } from '@/src/shared/agent-memories';
import { AgentMemoryStoreFullError } from '@/src/shared/agent-memories-storage';

export const MEMORY_DELETE_PREVIEW_LENGTH = 40;
export const MEMORY_DRAFT_PREVIEW_LINE_COUNT = 3;

export type SaveCardView =
  | { kind: 'hidden' }
  | { kind: 'loadError' }
  | { kind: 'full' }
  | { kind: 'saveError'; message: string }
  | { kind: 'draft' }
  | { kind: 'confirmation' };

export type SaveErrorClassification = 'full' | 'retryable';

const collapseWhitespace = (value: string): string => value.trim().replaceAll(/\s+/g, ' ');

/** First ~3 lines of selection text for the draft card preview. */
export const buildDraftSelectionPreview = (text: string): string => {
  const lines = text.split(/\r?\n/);
  return lines.slice(0, MEMORY_DRAFT_PREVIEW_LINE_COUNT).join('\n');
};

/** First ~40 chars of note-or-text for delete accessible names and list rows. */
export const buildMemoryPreviewLabel = (memory: {
  note?: string | undefined;
  text: string;
}): string => {
  const source =
    memory.note !== undefined && memory.note.trim().length > 0 ? memory.note : memory.text;
  const collapsed = collapseWhitespace(source);
  if (collapsed.length <= MEMORY_DELETE_PREVIEW_LENGTH) {
    return collapsed;
  }

  return collapsed.slice(0, MEMORY_DELETE_PREVIEW_LENGTH);
};

export const buildDeleteMemoryAriaLabel = (memory: {
  note?: string | undefined;
  text: string;
}): string => `Delete memory "${buildMemoryPreviewLabel(memory)}"`;

export const deriveNoteCharacterCount = (
  note: string
): {
  count: number;
  max: number;
} => ({
  count: note.length,
  max: MAX_MEMORY_NOTE_LENGTH,
});

export const classifySaveError = (error: unknown): SaveErrorClassification =>
  error instanceof AgentMemoryStoreFullError ? 'full' : 'retryable';

export const deriveSaveCardState = ({
  isLoaded,
  loadError,
  memories,
  pendingDraft,
  savedConfirmation,
  saveError,
}: {
  isLoaded: boolean;
  loadError: boolean;
  memories: readonly AgentMemory[];
  pendingDraft: PendingAgentMemoryDraft | undefined;
  savedConfirmation: boolean;
  saveError: string | undefined;
}): SaveCardView => {
  if (!isLoaded) {
    return { kind: 'hidden' };
  }

  if (pendingDraft === undefined && !savedConfirmation) {
    return { kind: 'hidden' };
  }

  if (loadError && pendingDraft !== undefined) {
    return { kind: 'loadError' };
  }

  if (!loadError && pendingDraft !== undefined && memories.length >= MAX_MEMORY_COUNT) {
    return { kind: 'full' };
  }

  if (pendingDraft !== undefined && saveError !== undefined) {
    return { kind: 'saveError', message: saveError };
  }

  if (pendingDraft !== undefined) {
    return { kind: 'draft' };
  }

  return { kind: 'confirmation' };
};
