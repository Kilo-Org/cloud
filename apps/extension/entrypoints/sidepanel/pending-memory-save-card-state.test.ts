import { describe, expect, it } from 'vitest';
import type { AgentMemory, PendingAgentMemoryDraft } from '@/src/shared/agent-memories';
import { MAX_MEMORY_COUNT, MAX_MEMORY_NOTE_LENGTH } from '@/src/shared/agent-memories';
import { AgentMemoryStoreFullError } from '@/src/shared/agent-memories-storage';
import {
  buildDeleteMemoryAriaLabel,
  buildDraftSelectionPreview,
  buildMemoryPreviewLabel,
  classifySaveError,
  deriveNoteCharacterCount,
  deriveSaveCardState,
} from './pending-memory-save-card-state';

const draft = (overrides: Partial<PendingAgentMemoryDraft> = {}): PendingAgentMemoryDraft => ({
  createdAt: 1_700_000_000_000,
  pageTitle: 'Example',
  pageUrl: 'https://example.com/page',
  text: 'Selected text',
  ...overrides,
});

const memory = (overrides: Partial<AgentMemory> = {}): AgentMemory => ({
  createdAt: 1_700_000_000_000,
  id: 'mem-1',
  pageTitle: 'Example',
  pageUrl: 'https://example.com/page',
  text: 'Stored text',
  ...overrides,
});

const baseInput = {
  isLoaded: true,
  loadError: false,
  memories: [] as AgentMemory[],
  pendingDraft: undefined as PendingAgentMemoryDraft | undefined,
  saveError: undefined as string | undefined,
  savedConfirmation: false,
};

const fullMemories = (): AgentMemory[] =>
  Array.from({ length: MAX_MEMORY_COUNT }, (_unused, index) =>
    memory({ createdAt: index, id: `mem-${index}` })
  );

describe('save card state machine', () => {
  it('hides while not loaded (branch 1)', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        isLoaded: false,
        pendingDraft: draft(),
      })
    ).toStrictEqual({ kind: 'hidden' });
  });

  it('hides when there is no draft and no confirmation (branch 2)', () => {
    expect(deriveSaveCardState(baseInput)).toStrictEqual({ kind: 'hidden' });
  });

  it('stays hidden on loadError with no known draft (branch 2 silent-by-design)', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        loadError: true,
      })
    ).toStrictEqual({ kind: 'hidden' });
  });

  it('shows load error when draft is known (branch 3)', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        loadError: true,
        pendingDraft: draft(),
      })
    ).toStrictEqual({ kind: 'loadError' });
  });

  it('shows full when store is at max and draft exists (branch 4)', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        memories: fullMemories(),
        pendingDraft: draft(),
      })
    ).toStrictEqual({ kind: 'full' });
  });

  it('full wins over saveError (priority conflict)', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        memories: fullMemories(),
        pendingDraft: draft(),
        saveError: "Couldn't save memory. Try again.",
      })
    ).toStrictEqual({ kind: 'full' });
  });

  it('does not show full while loadError is set even if count is max', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        loadError: true,
        memories: fullMemories(),
        pendingDraft: draft(),
      })
    ).toStrictEqual({ kind: 'loadError' });
  });

  it('shows save error when draft and saveError are set (branch 5)', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        pendingDraft: draft(),
        saveError: "Couldn't save memory. Try again.",
      })
    ).toStrictEqual({
      kind: 'saveError',
      message: "Couldn't save memory. Try again.",
    });
  });

  it('shows draft form when draft exists (branch 6)', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        pendingDraft: draft(),
      })
    ).toStrictEqual({ kind: 'draft' });
  });

  it('shows confirmation when savedConfirmation is true and no draft (branch 7)', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        savedConfirmation: true,
      })
    ).toStrictEqual({ kind: 'confirmation' });
  });

  it('loadError + confirmation yields confirmation (no draft → branches 1–2 miss; 3 needs draft)', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        loadError: true,
        savedConfirmation: true,
      })
    ).toStrictEqual({ kind: 'confirmation' });
  });

  it('draft wins over confirmation when both are present', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        pendingDraft: draft(),
        savedConfirmation: true,
      })
    ).toStrictEqual({ kind: 'draft' });
  });

  it('encodes new-draft-wins after effect clears savedConfirmation', () => {
    expect(
      deriveSaveCardState({
        ...baseInput,
        pendingDraft: draft({ createdAt: 2 }),
        // Effect clears confirmation when a new draft arrives.
        savedConfirmation: false,
      })
    ).toStrictEqual({ kind: 'draft' });
  });
});

describe('save error classification', () => {
  it('classifies AgentMemoryStoreFullError as full', () => {
    expect(classifySaveError(new AgentMemoryStoreFullError())).toBe('full');
  });

  it('classifies other errors as retryable', () => {
    expect(classifySaveError(new Error('quota'))).toBe('retryable');
    expect(classifySaveError('string error')).toBe('retryable');
    expect(classifySaveError(null)).toBe('retryable');
  });
});

describe('draft selection preview', () => {
  it('returns the first three lines', () => {
    expect(buildDraftSelectionPreview('a\nb\nc\nd\ne')).toBe('a\nb\nc');
  });

  it('returns the full text when fewer than three lines', () => {
    expect(buildDraftSelectionPreview('only one')).toBe('only one');
  });
});

describe('memory preview label', () => {
  it('prefers note over text', () => {
    expect(buildMemoryPreviewLabel({ note: 'My note', text: 'Body text' })).toBe('My note');
  });

  it('falls back to text when note is missing or blank', () => {
    expect(buildMemoryPreviewLabel({ text: 'Body text' })).toBe('Body text');
    expect(buildMemoryPreviewLabel({ note: '   ', text: 'Body text' })).toBe('Body text');
  });

  it('truncates to ~40 characters', () => {
    const long = 'x'.repeat(50);
    expect(buildMemoryPreviewLabel({ text: long })).toBe('x'.repeat(40));
  });
});

describe('delete memory aria label', () => {
  it('uses the preview inside the Delete memory label', () => {
    expect(buildDeleteMemoryAriaLabel({ note: 'Alpha', text: 'Body' })).toBe(
      'Delete memory "Alpha"'
    );
  });
});

describe('note character count', () => {
  it('reports length against the note max', () => {
    expect(deriveNoteCharacterCount('hi')).toStrictEqual({
      count: 2,
      max: MAX_MEMORY_NOTE_LENGTH,
    });
  });
});
