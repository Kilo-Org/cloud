/* eslint-disable capitalized-comments, id-length, jest/no-hooks, jest/no-untyped-mock-factory, max-lines, sort-keys, vitest/prefer-import-in-mock -- test fixture constraints */
/* eslint-disable import/first */
// @vitest-environment jsdom

import { createElement } from 'react';
import { Provider, createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { PendingAgentWorkflowDraft } from '@/src/shared/agent-workflows';
import { deriveWorkflowSaveCardState } from './pending-workflow-save-card-state';

vi.mock('#imports', () => ({
  storage: {},
}));

vi.mock('@/src/shared/agent-workflows-storage', () => ({
  AGENT_WORKFLOWS_STORAGE_KEY: 'local:kiloAgentWorkflows',
  PENDING_WORKFLOW_SAVE_STORAGE_KEY: 'local:kiloPendingWorkflowSave',
  WORKFLOW_SETTINGS_STORAGE_KEY: 'local:kiloWorkflowSettings',
  addAgentWorkflow: vi.fn(),
  clearPendingWorkflowDraft: vi.fn(),
  deleteAgentWorkflow: vi.fn(),
  loadAgentWorkflows: vi.fn(),
  loadPendingWorkflowDraft: vi.fn().mockResolvedValue(void 0),
  loadWorkflowSettings: vi.fn(),
  saveAgentWorkflows: vi.fn(),
  savePendingWorkflowDraft: vi.fn(),
  saveWorkflowSettings: vi.fn(),
  updateAgentWorkflow: vi.fn(),
}));

import { loadAgentWorkflows } from '@/src/shared/agent-workflows-storage';
import { pendingApprovalAtom } from './pending-approval';
import { PendingWorkflowSaveCard } from './pending-workflow-save-card';

const mockLoadAgentWorkflows = vi.mocked(loadAgentWorkflows);

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

const updateDraft: PendingAgentWorkflowDraft = {
  createdAt: 1_700_000_000_000,
  description: 'Updated workflow',
  name: 'My Update',
  scopeOrigin: 'https://example.com',
  script: 'return { done: true, result: 2 };',
  workflowId: 'wf-deleted',
};

const createWrapper = (store: ReturnType<typeof createStore>) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(Provider, { store }, children);
  };

describe('workflow save card load error render', () => {
  let store = createStore();

  beforeEach(() => {
    store = createStore();
    vi.clearAllMocks();
  });

  it('renders error message and Dismiss but not draft details or approval controls for deleted-update', async () => {
    store.set(pendingApprovalAtom, {
      draft: updateDraft,
      kind: 'workflow',
      settle: vi.fn(),
    });

    mockLoadAgentWorkflows.mockResolvedValue([]);

    const { getByText, queryByText } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(
        getByText('The original workflow was deleted. This update cannot be saved.')
      ).toBeDefined();
    });

    // Dismiss button renders.
    expect(getByText('Dismiss')).toBeDefined();

    // Draft details must not render.
    expect(queryByText('My Update')).toBeNull();

    // Approval controls must not render.
    expect(queryByText('Approve and save')).toBeNull();
    expect(queryByText('Reject')).toBeNull();
  });
});
