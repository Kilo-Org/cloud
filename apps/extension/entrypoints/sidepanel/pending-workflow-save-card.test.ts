import { describe, expect, it } from 'vitest';
import type { PendingAgentWorkflowDraft } from '@/src/shared/agent-workflows';
import { deriveWorkflowSaveCardState } from './pending-workflow-save-card-state';

const draft = (overrides: Partial<PendingAgentWorkflowDraft> = {}): PendingAgentWorkflowDraft => ({
  createdAt: 1_700_000_000_000,
  description: 'A test workflow',
  name: 'Test Workflow',
  scopeOrigin: 'https://example.com',
  script: 'return { done: true, result: 1 };',
  ...overrides,
});

const baseInput = {
  isSaving: false,
  loadError: undefined as string | undefined,
  pendingDraft: undefined as PendingAgentWorkflowDraft | undefined,
  saveError: undefined as string | undefined,
};

describe('workflow save card state', () => {
  it('hides when there is no draft', () => {
    expect(deriveWorkflowSaveCardState(baseInput)).toStrictEqual({ kind: 'hidden' });
  });

  it('shows draft form when draft exists', () => {
    expect(deriveWorkflowSaveCardState({ ...baseInput, pendingDraft: draft() })).toStrictEqual({
      kind: 'draft',
    });
  });

  it('shows saving state while applying', () => {
    expect(
      deriveWorkflowSaveCardState({ ...baseInput, isSaving: true, pendingDraft: draft() })
    ).toStrictEqual({ kind: 'saving' });
  });

  it('shows save error when saveError is set', () => {
    expect(
      deriveWorkflowSaveCardState({
        ...baseInput,
        pendingDraft: draft(),
        saveError: 'Failed to save.',
      })
    ).toStrictEqual({ kind: 'saveError', message: 'Failed to save.' });
  });

  it('shows load error when loadError is set', () => {
    expect(
      deriveWorkflowSaveCardState({
        ...baseInput,
        loadError: "Couldn't load.",
        pendingDraft: draft(),
      })
    ).toStrictEqual({ kind: 'loadError', message: "Couldn't load." });
  });

  it('load error wins over save error', () => {
    expect(
      deriveWorkflowSaveCardState({
        ...baseInput,
        loadError: "Couldn't load.",
        pendingDraft: draft(),
        saveError: 'Failed to save.',
      })
    ).toStrictEqual({ kind: 'loadError', message: "Couldn't load." });
  });

  it('draft form wins over saving when not saving', () => {
    expect(
      deriveWorkflowSaveCardState({ ...baseInput, isSaving: false, pendingDraft: draft() })
    ).toStrictEqual({ kind: 'draft' });
  });

  it('shows load error when draft exists and loadError is set', () => {
    expect(
      deriveWorkflowSaveCardState({
        ...baseInput,
        loadError: 'The original workflow was deleted. This update cannot be saved.',
        pendingDraft: draft(),
      })
    ).toStrictEqual({
      kind: 'loadError',
      message: 'The original workflow was deleted. This update cannot be saved.',
    });
  });
});
