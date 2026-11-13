/* eslint-disable capitalized-comments, id-length, jest/max-expects, jest/no-hooks, jest/no-untyped-mock-factory, max-dependencies, max-lines, sort-keys, vitest/prefer-import-in-mock -- test fixture constraints */
/* eslint-disable import/first */
// @vitest-environment jsdom

import { createElement } from 'react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, cleanup } from '@testing-library/react';
import type { AgentWorkflow, PendingAgentWorkflowDraft } from '@/src/shared/agent-workflows';
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

vi.mock('@/src/shared/agent-memories-storage', () => ({
  addAgentMemory: vi.fn(),
  clearPendingAgentMemoryDraft: vi.fn().mockResolvedValue(void 0),
  savePendingAgentMemoryDraft: vi.fn().mockResolvedValue(void 0),
}));

vi.mock('./use-agent-memories', () => ({
  useAgentMemories: vi.fn(),
}));

import {
  addAgentWorkflow,
  loadAgentWorkflows,
  loadPendingWorkflowDraft,
} from '@/src/shared/agent-workflows-storage';
import type { AgentMemory, PendingAgentMemoryDraft } from '@/src/shared/agent-memories';
import { addAgentMemory, clearPendingAgentMemoryDraft } from '@/src/shared/agent-memories-storage';
import { useAgentMemories } from './use-agent-memories';
import { pendingApprovalAtom } from './pending-approval';
import { PendingMemorySaveCard } from './pending-memory-save-card';
import { PendingWorkflowSaveCard } from './pending-workflow-save-card';

const mockLoadAgentWorkflows = vi.mocked(loadAgentWorkflows);
const mockLoadPendingWorkflowDraft = vi.mocked(loadPendingWorkflowDraft);
const mockAddAgentWorkflow = vi.mocked(addAgentWorkflow);
const mockAddAgentMemory = vi.mocked(addAgentMemory);
const mockClearPendingAgentMemoryDraft = vi.mocked(clearPendingAgentMemoryDraft);
const mockUseAgentMemories = vi.mocked(useAgentMemories);

const draft = (overrides: Partial<PendingAgentWorkflowDraft> = {}): PendingAgentWorkflowDraft => ({
  createdAt: 1_700_000_000_000,
  description: 'A test workflow',
  name: 'Test Workflow',
  scopeOrigin: 'https://example.com',
  script: 'return { done: true, result: 1 };',
  ...overrides,
});

const draftAlt: PendingAgentWorkflowDraft = {
  createdAt: 1_700_000_000_001,
  description: 'Another workflow',
  name: 'Second',
  scopeOrigin: 'https://example.com',
  script: 'return { done: true, result: 2 };',
};

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
    cleanup();
    store = createStore();
    vi.clearAllMocks();
    mockLoadPendingWorkflowDraft.mockResolvedValue(void 0);
  });

  afterEach(() => {
    cleanup();
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

  it('closes the dialog when Dismiss is clicked on a reload-path load error', async () => {
    // No approval entry is set: the card takes the reload path and reads the stored draft.
    mockLoadPendingWorkflowDraft.mockRejectedValue(new Error('storage broke'));

    const { container, getByText, queryByText } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(
        getByText(
          "Couldn't read the approved script. Dismiss and ask Kilo to save the workflow again."
        )
      ).toBeDefined();
    });

    // Dismiss renders even though no draft exists.
    expect(getByText('Dismiss')).toBeDefined();

    // No draft details or approval controls render.
    expect(queryByText('Approve and save')).toBeNull();
    expect(queryByText('Reject')).toBeNull();

    // Dismiss clears the error and closes the dialog.
    fireEvent.click(getByText('Dismiss'));

    await waitFor(() => {
      expect(
        queryByText(
          "Couldn't read the approved script. Dismiss and ask Kilo to save the workflow again."
        )
      ).toBeNull();
    });
    expect(container.querySelector('[aria-label="Save workflow"]')).toBeNull();
  });

  it('renders a later approval entry after a reload-path load error', async () => {
    // No approval entry is set: the card takes the reload path and the load rejects.
    mockLoadPendingWorkflowDraft.mockRejectedValue(new Error('storage broke'));

    const { getByText, queryByText, rerender } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(
        getByText(
          "Couldn't read the approved script. Dismiss and ask Kilo to save the workflow again."
        )
      ).toBeDefined();
    });

    // A new approval entry arrives after the reload failure.
    store.set(pendingApprovalAtom, {
      draft: draftAlt,
      kind: 'workflow',
      settle: vi.fn(),
    });

    rerender(createElement(PendingWorkflowSaveCard));

    // The new draft renders with approval controls, not the stale load error.
    await waitFor(() => {
      expect(getByText('Second')).toBeDefined();
    });

    expect(
      queryByText(
        "Couldn't read the approved script. Dismiss and ask Kilo to save the workflow again."
      )
    ).toBeNull();
    expect(getByText('Approve and save')).toBeDefined();
    expect(getByText('Reject')).toBeDefined();
  });

  it('keeps a newer approval draft visible when a superseded reload load rejects late', async () => {
    const reloadLoad = Promise.withResolvers<undefined>();
    mockLoadPendingWorkflowDraft.mockReturnValue(reloadLoad.promise);

    const { getByText, queryByText, rerender } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    // A new approval entry supersedes the in-flight reload load.
    store.set(pendingApprovalAtom, {
      draft: draftAlt,
      kind: 'workflow',
      settle: vi.fn(),
    });

    rerender(createElement(PendingWorkflowSaveCard));

    await waitFor(() => {
      expect(getByText('Second')).toBeDefined();
    });

    // The superseded reload load rejects late.
    await act(async () => {
      reloadLoad.reject(new Error('storage broke'));
      await Promise.resolve();
    });

    // The stale rejection must not hide the newer draft.
    expect(getByText('Second')).toBeDefined();
    expect(getByText('Approve and save')).toBeDefined();
    expect(
      queryByText(
        "Couldn't read the approved script. Dismiss and ask Kilo to save the workflow again."
      )
    ).toBeNull();
  });
});

describe('workflow save card script diff render', () => {
  let store = createStore();

  const storedScript =
    "const greeting = 'hello';\nconst count = 1;\nreturn { done: true, result: count };";

  const storedWorkflow = (overrides: Partial<AgentWorkflow> = {}): AgentWorkflow => ({
    approvedScriptHash: 'a1b2c3',
    createdAt: 1_700_000_000_000,
    description: 'Stored workflow',
    id: 'wf-1',
    name: 'Stored',
    scopeOrigin: 'https://example.com',
    script: storedScript,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  });

  const changedDraft: PendingAgentWorkflowDraft = {
    createdAt: 1_700_000_000_000,
    description: 'Updated workflow',
    name: 'My Update',
    scopeOrigin: 'https://example.com',
    script: "const greeting = 'hello';\nconst count = 2;\nreturn { done: true, result: count };",
    workflowId: 'wf-1',
  };

  const identicalDraft: PendingAgentWorkflowDraft = {
    ...changedDraft,
    script: storedScript,
  };

  const createDraft: PendingAgentWorkflowDraft = {
    createdAt: 1_700_000_000_000,
    description: 'New workflow',
    name: 'New Workflow',
    scopeOrigin: 'https://example.com',
    script: 'return { done: true, result: 1 };',
  };

  beforeEach(() => {
    cleanup();
    store = createStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders label, hunk header, context, add, delete, and syntax rows for a changed update', async () => {
    store.set(pendingApprovalAtom, {
      draft: changedDraft,
      kind: 'workflow',
      settle: vi.fn(),
    });
    mockLoadAgentWorkflows.mockResolvedValue([storedWorkflow()]);

    const { container, getByText, queryByText } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Script changes')).toBeDefined();
    });

    expect(getByText('@@ -1,3 +1,3 @@')).toBeDefined();

    const contextRow = container.querySelector(
      '.whitespace-pre-wrap.break-words.text-foreground-muted'
    );
    expect(contextRow?.textContent).toContain("const greeting = 'hello';");

    const addRow = container.querySelector('.bg-diff-add-surface');
    expect(addRow?.textContent).toContain('const count = 2;');

    const delRow = container.querySelector('.bg-diff-delete-surface');
    expect(delRow?.textContent).toContain('const count = 1;');

    expect(
      container.querySelector(
        '.text-syntax-comment, .text-syntax-keyword, .text-syntax-number, .text-syntax-string'
      )
    ).not.toBeNull();

    expect(queryByText('Approve and save')).toBeDefined();
  });

  it('renders the plain script with the Script label for a create', async () => {
    store.set(pendingApprovalAtom, {
      draft: createDraft,
      kind: 'workflow',
      settle: vi.fn(),
    });

    const { container, getByText, queryByText } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Approve and save')).toBeDefined();
    });

    expect(getByText('Script')).toBeDefined();
    expect(queryByText(/^@@ /)).toBeNull();
    expect(container.querySelector('[aria-label="Script changes"]')).toBeNull();
  });

  it('renders the too-large note and plain script for an oversized update', async () => {
    const hugeScript = Array.from({ length: 1201 }, (_unused, index) => `line ${index}`).join('\n');

    store.set(pendingApprovalAtom, {
      draft: { ...changedDraft, script: hugeScript },
      kind: 'workflow',
      settle: vi.fn(),
    });
    mockLoadAgentWorkflows.mockResolvedValue([storedWorkflow()]);

    const { container, getByText, queryByText } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Script too large to diff line by line.')).toBeDefined();
    });

    expect(getByText('Script')).toBeDefined();
    expect(container.querySelector('pre')).not.toBeNull();
    expect(queryByText(/^@@ /)).toBeNull();
    expect(container.querySelector('[aria-label="Script changes"]')).toBeNull();
  });

  it('renders the plain script with the Script (unchanged) label for an identical update', async () => {
    store.set(pendingApprovalAtom, {
      draft: identicalDraft,
      kind: 'workflow',
      settle: vi.fn(),
    });
    mockLoadAgentWorkflows.mockResolvedValue([storedWorkflow()]);

    const { container, getByText, queryByText } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Script (unchanged)')).toBeDefined();
    });

    expect(queryByText(/^@@ /)).toBeNull();
    expect(container.querySelector('[aria-label="Script changes"]')).toBeNull();
  });

  it('renders the dismissible load error when loadAgentWorkflows rejects', async () => {
    store.set(pendingApprovalAtom, {
      draft: changedDraft,
      kind: 'workflow',
      settle: vi.fn(),
    });
    mockLoadAgentWorkflows.mockRejectedValue(new Error('storage broke'));

    const { getByText, queryByText } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(
        getByText(
          "Couldn't read the approved script. Dismiss and ask Kilo to save the workflow again."
        )
      ).toBeDefined();
    });

    expect(getByText('Dismiss')).toBeDefined();
    expect(queryByText('Approve and save')).toBeNull();
    expect(queryByText('Reject')).toBeNull();
  });
});

describe('workflow save card second approval resets settled guard and stale error', () => {
  let store = createStore();

  beforeEach(() => {
    cleanup();
    store = createStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders draft form for second approval after first rejects', async () => {
    const settle1 = vi.fn();

    // First approval entry.
    store.set(pendingApprovalAtom, {
      draft: draft({ script: 'return 1;' }),
      kind: 'workflow',
      settle: settle1,
    });

    mockLoadAgentWorkflows.mockResolvedValue([]);

    const { getByText, rerender } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Approve and save')).toBeDefined();
    });

    // Settle the first request — simulate clicking Reject.
    settle1.mockClear();
    store.set(pendingApprovalAtom, {
      draft: draftAlt,
      kind: 'workflow',
      settle: vi.fn(),
    });

    rerender(createElement(PendingWorkflowSaveCard));

    // Second draft must render, not hidden or stale error.
    await waitFor(() => {
      expect(getByText('Second')).toBeDefined();
    });

    expect(getByText('Approve and save')).toBeDefined();
  });
});

const memoryDraft = (
  overrides: Partial<PendingAgentMemoryDraft> = {}
): PendingAgentMemoryDraft => ({
  createdAt: 1_700_000_000_000,
  pageTitle: 'Test Page',
  pageUrl: 'https://example.com/page',
  text: 'Selected text for memory',
  ...overrides,
});

const emptyMemories: AgentMemory[] = [];

describe('workflow save card reject-A then approve-B settles', () => {
  let store = createStore();

  beforeEach(() => {
    cleanup();
    store = createStore();
    vi.clearAllMocks();
    mockLoadAgentWorkflows.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('reject on A then approve on B calls B settle with approved outcome', async () => {
    const settleA = vi.fn();
    const settleB = vi.fn();

    store.set(pendingApprovalAtom, {
      draft: draft({ script: 'return 1;' }),
      kind: 'workflow',
      settle: settleA,
    });

    const { getByText, queryByText, rerender } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Approve and save')).toBeDefined();
    });

    // Click Reject on A.
    fireEvent.click(getByText('Reject'));

    expect(settleA).toHaveBeenCalledWith({ status: 'rejected' });
    // eslint-disable-next-line vitest/prefer-called-once, vitest/prefer-called-times -- conflicting rules
    expect(settleA).toHaveBeenCalledTimes(1);

    // Wait for handleCancel's setPendingDraft(undefined) to complete.
    await waitFor(() => {
      expect(queryByText('Approve and save')).toBeNull();
    });

    // Set atom B after A is fully settled.
    store.set(pendingApprovalAtom, {
      draft: draftAlt,
      kind: 'workflow',
      settle: settleB,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-type-assertion -- test mock stub
    mockAddAgentWorkflow.mockResolvedValue({ id: 'wf-b', name: 'Second' } as any);

    rerender(createElement(PendingWorkflowSaveCard));

    await waitFor(() => {
      expect(getByText('Second')).toBeDefined();
    });

    // Click Approve on B.
    fireEvent.click(getByText('Approve and save'));

    await waitFor(() => {
      // eslint-disable-next-line vitest/prefer-called-once, vitest/prefer-called-times -- conflicting rules
      expect(settleB).toHaveBeenCalledTimes(1);
    });

    expect(settleB).toHaveBeenCalledWith(
      expect.objectContaining({ savedId: 'wf-b', status: 'approved' })
    );

    // No stale error.
    expect(queryByText('Save failed')).toBeNull();
  });
});

describe('workflow save card A error clears on B draft', () => {
  let store = createStore();

  beforeEach(() => {
    cleanup();
    store = createStore();
    vi.clearAllMocks();
    mockLoadAgentWorkflows.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('clears saveError from A when B draft arrives', async () => {
    const settleA = vi.fn();

    store.set(pendingApprovalAtom, {
      draft: draft({ name: 'Workflow A', script: 'return 1;' }),
      kind: 'workflow',
      settle: settleA,
    });

    mockAddAgentWorkflow.mockRejectedValue(new Error('Save failed'));

    const { getByText, queryByText, rerender } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Workflow A')).toBeDefined();
    });

    // Click Approve on A — save fails.
    fireEvent.click(getByText('Approve and save'));

    await waitFor(() => {
      expect(getByText('Save failed')).toBeDefined();
    });

    expect(settleA).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', reason: 'Save failed' })
    );

    // Set atom B. The useEffect detects new draft key and resets saveError.
    store.set(pendingApprovalAtom, {
      draft: draftAlt,
      kind: 'workflow',
      settle: vi.fn(),
    });

    rerender(createElement(PendingWorkflowSaveCard));

    await waitFor(() => {
      expect(getByText('Second')).toBeDefined();
    });

    // A's error must be gone.
    expect(queryByText('Save failed')).toBeNull();
  });

  it('clears loadError from deleted A when B draft arrives', async () => {
    store.set(pendingApprovalAtom, {
      draft: draft({ name: 'Workflow A', script: 'return 1;', workflowId: 'wf-deleted' }),
      kind: 'workflow',
      settle: vi.fn(),
    });

    const { getByText, queryByText, rerender } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(
        getByText('The original workflow was deleted. This update cannot be saved.')
      ).toBeDefined();
    });

    store.set(pendingApprovalAtom, {
      draft: draftAlt,
      kind: 'workflow',
      settle: vi.fn(),
    });

    rerender(createElement(PendingWorkflowSaveCard));

    await waitFor(() => {
      expect(getByText('Second')).toBeDefined();
    });

    expect(
      queryByText('The original workflow was deleted. This update cannot be saved.')
    ).toBeNull();
    expect(getByText('Approve and save')).toBeDefined();
  });
});

describe('workflow save card persisted draft recovery', () => {
  let store = createStore();

  beforeEach(() => {
    cleanup();
    store = createStore();
    vi.clearAllMocks();
    mockLoadPendingWorkflowDraft.mockResolvedValue(void 0);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a new approval card after a persisted missing-original update loaded on reload', async () => {
    // Reload path loads a persisted update whose original workflow is missing.
    mockLoadPendingWorkflowDraft.mockResolvedValue(updateDraft);
    mockLoadAgentWorkflows.mockResolvedValue([]);

    const { getByText, queryByText, rerender } = render(createElement(PendingWorkflowSaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(
        getByText('The original workflow was deleted. This update cannot be saved.')
      ).toBeDefined();
    });

    // A new approval entry arrives after the persisted draft loaded.
    store.set(pendingApprovalAtom, {
      draft: draftAlt,
      kind: 'workflow',
      settle: vi.fn(),
    });

    rerender(createElement(PendingWorkflowSaveCard));

    // The new draft must render, not the persisted missing-original error.
    await waitFor(() => {
      expect(getByText('Second')).toBeDefined();
    });

    expect(
      queryByText('The original workflow was deleted. This update cannot be saved.')
    ).toBeNull();
    expect(getByText('Approve and save')).toBeDefined();
    expect(getByText('Reject')).toBeDefined();
  });

  it('does not diff a later approval card against the persisted draft old script', async () => {
    const oldScript =
      "const greeting = 'hello';\nconst count = 1;\nreturn { done: true, result: count };";

    const persistedUpdate: PendingAgentWorkflowDraft = {
      createdAt: 1_700_000_000_000,
      description: 'Persisted update',
      name: 'Persisted',
      scopeOrigin: 'https://example.com',
      script: "const greeting = 'hello';\nconst count = 2;\nreturn { done: true, result: count };",
      workflowId: 'wf-1',
    };

    const stored: AgentWorkflow = {
      approvedScriptHash: 'a1b2c3',
      createdAt: 1_700_000_000_000,
      description: 'Stored workflow',
      id: 'wf-1',
      name: 'Stored',
      scopeOrigin: 'https://example.com',
      script: oldScript,
      updatedAt: 1_700_000_000_000,
    };

    // Reload path loads a persisted update and its old stored script.
    mockLoadPendingWorkflowDraft.mockResolvedValue(persistedUpdate);
    mockLoadAgentWorkflows.mockResolvedValue([stored]);

    const { container, getByText, queryByText, rerender } = render(
      createElement(PendingWorkflowSaveCard),
      { wrapper: createWrapper(store) }
    );

    // The persisted card renders the diff against the old script.
    await waitFor(() => {
      expect(getByText('Script changes')).toBeDefined();
    });

    // A new create approval entry arrives after the persisted update loaded.
    store.set(pendingApprovalAtom, {
      draft: draft(),
      kind: 'workflow',
      settle: vi.fn(),
    });

    rerender(createElement(PendingWorkflowSaveCard));

    // The new card must render, not the persisted update.
    await waitFor(() => {
      expect(getByText('Test Workflow')).toBeDefined();
    });

    // The new card must not diff against the persisted draft's old script.
    expect(queryByText('Script changes')).toBeNull();
    expect(getByText('Script')).toBeDefined();
    expect(queryByText(/^@@ /)).toBeNull();
    expect(container.querySelector('[aria-label="Script changes"]')).toBeNull();
  });
});

describe('memory save card full outcome for store-full reason', () => {
  let store = createStore();
  const reload = vi.fn();
  const settle = vi.fn();
  const memDraft = memoryDraft();

  beforeEach(() => {
    cleanup();
    store = createStore();
    vi.clearAllMocks();
    mockUseAgentMemories.mockReturnValue({
      isLoaded: true,
      loadError: false,
      memories: emptyMemories,
      pendingDraft: memDraft,
      reload,
    });
    mockClearPendingAgentMemoryDraft.mockResolvedValue(void 0);
    settle.mockReset();
    reload.mockReset();

    store.set(pendingApprovalAtom, {
      draft: memDraft,
      kind: 'memory',
      settle,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders full view when outcome reason is "Memory store is full."', async () => {
    const storeFullError = new Error('Memory store is full.');
    storeFullError.name = 'AgentMemoryStoreFullError';
    mockAddAgentMemory.mockRejectedValue(storeFullError);

    const { getByText } = render(createElement(PendingMemorySaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Save memory')).toBeDefined();
    });

    fireEvent.click(getByText('Save memory'));

    await waitFor(() => {
      expect(getByText('Memory is full. Delete memories to save new ones.')).toBeDefined();
    });

    // Full view shows Manage memories, not Retry.
    expect(getByText('Manage memories')).toBeDefined();

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Memory store is full.', status: 'failed' })
    );
  });
});

describe('memory save card retryable error for generic failure', () => {
  let store = createStore();
  const reload = vi.fn();
  const settle = vi.fn();
  const memDraft = memoryDraft();

  beforeEach(() => {
    cleanup();
    store = createStore();
    vi.clearAllMocks();
    mockUseAgentMemories.mockReturnValue({
      isLoaded: true,
      loadError: false,
      memories: emptyMemories,
      pendingDraft: memDraft,
      reload,
    });
    mockClearPendingAgentMemoryDraft.mockResolvedValue(void 0);
    settle.mockReset();
    reload.mockReset();

    store.set(pendingApprovalAtom, {
      draft: memDraft,
      kind: 'memory',
      settle,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders retryable error when outcome reason is not "Memory store is full."', async () => {
    mockAddAgentMemory.mockRejectedValue(new Error('quota exceeded'));

    const { getByText } = render(createElement(PendingMemorySaveCard), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Save memory')).toBeDefined();
    });

    fireEvent.click(getByText('Save memory'));

    await waitFor(() => {
      expect(getByText("Couldn't save memory. Try again.")).toBeDefined();
    });

    // Retryable view shows Retry, not Manage memories.
    expect(getByText('Retry')).toBeDefined();

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'quota exceeded', status: 'failed' })
    );
  });
});
