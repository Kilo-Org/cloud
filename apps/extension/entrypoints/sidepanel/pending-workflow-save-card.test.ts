/* eslint-disable capitalized-comments, id-length, jest/max-expects, jest/no-hooks, jest/no-untyped-mock-factory, max-dependencies, max-lines, sort-keys, vitest/prefer-import-in-mock -- test fixture constraints */
/* eslint-disable import/first */
/* eslint-disable jest/no-conditional-in-test, jest/no-conditional-expect -- The table runs both cards with their distinct existing views and controls. */
// @vitest-environment jsdom

import { createElement } from 'react';
import { Provider, createStore, getDefaultStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, cleanup, within } from '@testing-library/react';
import { BrowserTaskSupervisionContext } from './browser-task-supervision-slot';
import type { ApprovalOutcome, PendingApprovalEntry } from './pending-approval';
import {
  DEFAULT_WORKFLOW_SETTINGS,
  pendingAgentWorkflowDraftSchema,
} from '@/src/shared/agent-workflows';
import type {
  AgentWorkflow,
  NormalizedPendingAgentWorkflowDraft,
  PendingAgentWorkflowDraft,
} from '@/src/shared/agent-workflows';
import { pendingAgentMemoryDraftSchema } from '@/src/shared/agent-memories';
import { deriveWorkflowSaveCardState } from './pending-workflow-save-card-state';

vi.mock('#imports', () => ({
  storage: {
    getItem: () => null,
    removeItem: () => {},
    setItem: () => {},
  },
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

import { storage } from '#imports';
import {
  addAgentWorkflow,
  loadAgentWorkflows,
  loadPendingWorkflowDraft,
  loadWorkflowSettings,
} from '@/src/shared/agent-workflows-storage';
import type { AgentMemory, PendingAgentMemoryDraft } from '@/src/shared/agent-memories';
import { addAgentMemory, clearPendingAgentMemoryDraft } from '@/src/shared/agent-memories-storage';
import { useAgentMemories } from './use-agent-memories';
import { pendingApprovalAtom, pendingLockAtom, requestApproval } from './pending-approval';
import { PendingMemorySaveCard } from './pending-memory-save-card';
import { PendingWorkflowSaveCard } from './pending-workflow-save-card';

const mockLoadAgentWorkflows = vi.mocked(loadAgentWorkflows);
const mockLoadPendingWorkflowDraft = vi.mocked(loadPendingWorkflowDraft);
const mockAddAgentWorkflow = vi.mocked(addAgentWorkflow);
const mockAddAgentMemory = vi.mocked(addAgentMemory);
const mockClearPendingAgentMemoryDraft = vi.mocked(clearPendingAgentMemoryDraft);
const mockUseAgentMemories = vi.mocked(useAgentMemories);

const draft = (overrides: Partial<PendingAgentWorkflowDraft> = {}) =>
  pendingAgentWorkflowDraftSchema.parse({
    createdAt: 1_700_000_000_000,
    description: 'A test workflow',
    name: 'Test Workflow',
    scopeOrigin: 'https://example.com',
    script: 'return { done: true, result: 1 };',
    ...overrides,
  });

const draftAlt = draft({
  createdAt: 1_700_000_000_001,
  description: 'Another workflow',
  name: 'Second',
  script: 'return { done: true, result: 2 };',
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

const updateDraft: NormalizedPendingAgentWorkflowDraft = {
  origin: { kind: 'local' },
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

  const changedDraft: NormalizedPendingAgentWorkflowDraft = {
    origin: { kind: 'local' },
    createdAt: 1_700_000_000_000,
    description: 'Updated workflow',
    name: 'My Update',
    scopeOrigin: 'https://example.com',
    script: "const greeting = 'hello';\nconst count = 2;\nreturn { done: true, result: count };",
    workflowId: 'wf-1',
  };

  const identicalDraft: NormalizedPendingAgentWorkflowDraft = {
    ...changedDraft,
    script: storedScript,
  };

  const createDraft: NormalizedPendingAgentWorkflowDraft = {
    origin: { kind: 'local' },
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

const memoryDraft = (overrides: Partial<PendingAgentMemoryDraft> = {}) =>
  pendingAgentMemoryDraftSchema.parse({
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

    // Rejection clears storage before settling the matching approval.
    await waitFor(() => {
      expect(queryByText('Approve and save')).toBeNull();
    });
    expect(settleA).toHaveBeenCalledWith({ status: 'rejected' });
    // eslint-disable-next-line vitest/prefer-called-once, vitest/prefer-called-times -- conflicting rules
    expect(settleA).toHaveBeenCalledTimes(1);

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
    mockLoadPendingWorkflowDraft.mockResolvedValue(
      pendingAgentWorkflowDraftSchema.parse(updateDraft)
    );
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

    const persistedUpdate: NormalizedPendingAgentWorkflowDraft = {
      origin: { kind: 'local' },
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
    mockLoadPendingWorkflowDraft.mockResolvedValue(
      pendingAgentWorkflowDraftSchema.parse(persistedUpdate)
    );
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

describe('background memory draft compatibility', () => {
  it('shows a newer local selection without losing the unrelated local approval', () => {
    const store = createStore();
    const local = memoryDraft({ text: 'Pending local agent selection' });
    const background = memoryDraft({ createdAt: 2, text: 'New background selection' });
    store.set(pendingApprovalAtom, { draft: local, kind: 'memory', settle: vi.fn() });
    const loaded = {
      isLoaded: true,
      loadError: false,
      memories: emptyMemories,
      pendingDraft: { ...background, origin: undefined },
      reload: vi.fn(),
    };
    mockUseAgentMemories.mockReturnValue(loaded);
    const view = render(createElement(PendingMemorySaveCard), { wrapper: createWrapper(store) });
    expect(view.getByText('New background selection')).toBeDefined();
    mockUseAgentMemories.mockReturnValue({ ...loaded, pendingDraft: undefined });
    view.rerender(createElement(PendingMemorySaveCard));
    expect(view.getByText('Pending local agent selection')).toBeDefined();
  });
});

const supervision = createElement(
  'div',
  null,
  createElement('span', null, 'CLI owner — Example tab'),
  createElement('button', { type: 'button' }, 'Stop CLI task')
);
const createSupervisedWrapper = (store: ReturnType<typeof createStore>) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(
      Provider,
      { store },
      createElement(BrowserTaskSupervisionContext.Provider, { value: supervision }, children)
    );
  };

describe.each([
  { kind: 'memory' as const, Component: PendingMemorySaveCard, saveName: 'Save memory' },
  { kind: 'workflow' as const, Component: PendingWorkflowSaveCard, saveName: 'Approve and save' },
])('$kind approval lifetime and supervision', ({ kind, Component, saveName }) => {
  let store = createStore();
  let saved: (AgentMemory | AgentWorkflow)[] = [];
  let saveGate: Promise<void> | null = null;
  let saveStarted = Promise.withResolvers<void>();
  const reload = vi.fn();

  const setStoredDraft = (entry?: PendingApprovalEntry): void => {
    mockUseAgentMemories.mockReturnValue({
      isLoaded: true,
      loadError: false,
      memories: [],
      pendingDraft: entry?.kind === 'memory' ? entry.draft : undefined,
      reload,
    });
    mockLoadPendingWorkflowDraft.mockResolvedValue(
      entry?.kind === 'workflow' ? pendingAgentWorkflowDraftSchema.parse(entry.draft) : undefined
    );
  };
  const makeEntry = (approvalId = 'first'): PendingApprovalEntry => {
    const origin = {
      kind: 'delegated' as const,
      approvalId,
      invocationId: 'invocation',
      expiresAt: Date.now() + 60_000,
    };
    return kind === 'memory'
      ? {
          kind,
          draft: memoryDraft({ origin, note: approvalId }),
          isLive: () => true,
          settle: vi.fn(),
        }
      : { kind, draft: draft({ origin, name: approvalId }), isLive: () => true, settle: vi.fn() };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = createStore();
    saved = [];
    saveGate = null;
    saveStarted = Promise.withResolvers<void>();
    mockLoadAgentWorkflows.mockResolvedValue([]);
    setStoredDraft(
      kind === 'memory'
        ? { kind, draft: memoryDraft(), settle: vi.fn() }
        : { kind, draft: draft(), settle: vi.fn() }
    );
    mockAddAgentMemory.mockImplementation(async (_storage, input) => {
      saveStarted.resolve();
      await saveGate;
      const record = { ...input, id: 'saved-memory' };
      saved.push(record);
      return record;
    });
    mockAddAgentWorkflow.mockImplementation(async (_storage, input) => {
      saveStarted.resolve();
      await saveGate;
      const record = { ...input, id: 'saved-workflow', createdAt: 1, updatedAt: 1 };
      saved.push(record);
      return record;
    });
  });

  it('makes a retained save click inert when cancellation wins before React renders', async () => {
    let live = true;
    const result = Promise.withResolvers<ApprovalOutcome>();
    const entry = { ...makeEntry(), isLive: () => live, settle: result.resolve };
    setStoredDraft(entry);
    store.set(pendingApprovalAtom, entry);
    const view = render(createElement(Component), { wrapper: createWrapper(store) });
    const button = await view.findByRole('button', { name: saveName });
    live = false;
    fireEvent.click(button);
    await expect(result.promise).resolves.toStrictEqual({ status: 'aborted' });
    await waitFor(() => {
      expect(view.queryByRole('dialog')).toBeNull();
    });
    expect(saved).toStrictEqual([]);
  });

  it('clears a loaded delegated card when its atom ends and an empty reload arrives', async () => {
    const entry = makeEntry();
    setStoredDraft(entry);
    store.set(pendingApprovalAtom, entry);
    const view = render(createElement(Component), { wrapper: createWrapper(store) });
    await view.findByRole('button', { name: saveName });
    await act(async () => {
      store.set(pendingApprovalAtom, undefined);
      await Promise.resolve();
    });
    setStoredDraft(undefined);
    view.rerender(createElement(Component));
    await waitFor(() => {
      expect(view.queryByRole('dialog')).toBeNull();
    });
    expect(view.queryByRole('button', { name: saveName })).toBeNull();
    expect(saved).toStrictEqual([]);
  });

  it('does not recover delegated authority from a persisted draft on mount', async () => {
    const entry = makeEntry();
    setStoredDraft(entry);
    const read = Promise.withResolvers<Awaited<ReturnType<typeof loadPendingWorkflowDraft>>>();
    mockLoadPendingWorkflowDraft.mockReturnValue(read.promise);
    const view = render(createElement(Component), { wrapper: createWrapper(store) });
    await act(async () => {
      read.resolve(
        entry.kind === 'workflow' ? pendingAgentWorkflowDraftSchema.parse(entry.draft) : undefined
      );
      await read.promise;
    });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(saved).toStrictEqual([]);
  });

  it('keeps the newer card after a stale asynchronous draft load', async () => {
    const oldEntry = makeEntry();
    const nextEntry = makeEntry('replacement');
    const read = Promise.withResolvers<Awaited<ReturnType<typeof loadPendingWorkflowDraft>>>();
    setStoredDraft(undefined);
    mockLoadPendingWorkflowDraft.mockReturnValue(read.promise);
    const view = render(createElement(Component), { wrapper: createWrapper(store) });
    await act(async () => {
      store.set(pendingApprovalAtom, nextEntry);
      await Promise.resolve();
    });
    await view.findByRole('button', { name: saveName });
    await act(async () => {
      read.resolve(
        oldEntry.kind === 'workflow'
          ? pendingAgentWorkflowDraftSchema.parse(oldEntry.draft)
          : undefined
      );
      await read.promise;
      setStoredDraft(oldEntry);
      view.rerender(createElement(Component));
    });
    if (kind === 'memory') {
      expect(view.getByDisplayValue('replacement')).toBeDefined();
    } else {
      expect(view.getByText('replacement')).toBeDefined();
    }
    expect(view.getByRole('button', { name: saveName }).hasAttribute('disabled')).toBe(false);
  });

  it('does not clear a newer draft or its atom when an old save completes', async () => {
    const gate = Promise.withResolvers<void>();
    saveGate = gate.promise;
    const oldEntry = makeEntry();
    const nextEntry = makeEntry('replacement');
    setStoredDraft(oldEntry);
    store.set(pendingApprovalAtom, oldEntry);
    const view = render(createElement(Component), { wrapper: createWrapper(store) });
    fireEvent.click(await view.findByRole('button', { name: saveName }));
    await saveStarted.promise;
    await act(async () => {
      setStoredDraft(nextEntry);
      store.set(pendingApprovalAtom, nextEntry);
      await Promise.resolve();
    });
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    if (kind === 'memory') {
      expect(view.getByDisplayValue('replacement')).toBeDefined();
    } else {
      expect(view.getByText('replacement')).toBeDefined();
    }
    expect(store.get(pendingApprovalAtom)?.draft.origin).toStrictEqual(nextEntry.draft.origin);
    expect(view.getByRole('button', { name: saveName }).hasAttribute('disabled')).toBe(false);
  });

  it.each(['full', 'retryable'] as const)(
    'keeps a real delegated %s failure pending until an explicit retry succeeds',
    async failure => {
      store = getDefaultStore();
      store.set(pendingApprovalAtom, undefined);
      store.set(pendingLockAtom, false);
      setStoredDraft(undefined);
      vi.mocked(loadWorkflowSettings).mockResolvedValue(DEFAULT_WORKFLOW_SETTINGS);
      const error = new Error('quota exceeded');
      if (failure === 'full') {
        error.name =
          kind === 'memory' ? 'AgentMemoryStoreFullError' : 'AgentWorkflowStoreFullError';
      }
      if (kind === 'memory') {
        mockAddAgentMemory.mockRejectedValueOnce(error);
      } else {
        mockAddAgentWorkflow.mockRejectedValueOnce(error);
      }
      const controller = new AbortController();
      const approval = requestApproval(
        storage,
        kind,
        kind === 'memory' ? memoryDraft() : draft(),
        controller.signal,
        {
          invocationId: 'retry-invocation',
          expiresAt: Date.now() + 60_000,
          isLive: () => true,
          executionGuard: () => {},
        }
      );
      const view = render(createElement(Component), { wrapper: createSupervisedWrapper(store) });
      try {
        const save = await view.findByRole('button', { name: saveName });
        if (kind === 'memory') {
          fireEvent.change(view.getByRole('textbox', { name: 'Memory note (optional)' }), {
            target: { value: 'Keep this edited note' },
          });
        }
        fireEvent.click(save);
        const messages = {
          memory: {
            full: 'Memory is full. Delete memories to save new ones.',
            retryable: "Couldn't save memory. Try again.",
          },
          workflow: { full: 'Workflow store is full.', retryable: 'quota exceeded' },
        };
        await view.findByText(messages[kind][failure]);
        const dialog = within(view.getByRole('dialog'));
        expect(dialog.getByRole('button', { name: 'Stop CLI task' }).hasAttribute('disabled')).toBe(
          false
        );
        if (kind === 'memory') {
          expect(view.getByDisplayValue('Keep this edited note')).toBeDefined();
          if (failure === 'full') {
            expect(dialog.getByRole('button', { name: 'Manage memories' })).toBeDefined();
          }
        }
        const retry = dialog.getByRole('button', {
          name: kind === 'memory' && failure === 'retryable' ? 'Retry' : saveName,
        });
        expect(retry.hasAttribute('disabled')).toBe(false);
        expect(store.get(pendingLockAtom)).toBe(true);
        expect(saved).toStrictEqual([]);

        fireEvent.click(retry);
        await expect(approval).resolves.toStrictEqual({
          status: 'approved',
          autoApproved: false,
          savedId: kind === 'memory' ? 'saved-memory' : 'saved-workflow',
        });
        expect(saved).toHaveLength(1);
        expect(store.get(pendingApprovalAtom)).toBeUndefined();
        expect(store.get(pendingLockAtom)).toBe(false);
        if (kind === 'memory') {
          expect(saved[0]).toMatchObject({ note: 'Keep this edited note' });
          await view.findByText('Saved to memory');
          expect(
            within(view.getByRole('dialog')).getByRole('button', { name: 'Stop CLI task' })
          ).toBeDefined();
          fireEvent.click(view.getByRole('button', { name: 'Done' }));
        }
        await waitFor(() => {
          expect(view.queryByRole('dialog')).toBeNull();
        });
      } finally {
        controller.abort();
        await approval;
      }
    }
  );

  it.each(['terminal', 'cancelled', 'expired', 'reloaded'] as const)(
    'keeps a real delegated retry inert after authority becomes %s',
    async stop => {
      store = getDefaultStore();
      store.set(pendingApprovalAtom, undefined);
      store.set(pendingLockAtom, false);
      setStoredDraft(undefined);
      vi.mocked(loadWorkflowSettings).mockResolvedValue(DEFAULT_WORKFLOW_SETTINGS);
      if (kind === 'memory') {
        mockAddAgentMemory.mockRejectedValueOnce(new Error('quota exceeded'));
      } else {
        mockAddAgentWorkflow.mockRejectedValueOnce(new Error('quota exceeded'));
      }
      const controller = new AbortController();
      const expiresAt = Date.now() + 60_000;
      let live = true;
      const approval = requestApproval(
        storage,
        kind,
        kind === 'memory' ? memoryDraft() : draft(),
        controller.signal,
        {
          invocationId: 'ended-retry-invocation',
          expiresAt,
          isLive: () => live,
          executionGuard: () => {},
        }
      );
      const now = vi.spyOn(Date, 'now');
      const view = render(createElement(Component), { wrapper: createWrapper(store) });
      try {
        fireEvent.click(await view.findByRole('button', { name: saveName }));
        await view.findByText(
          kind === 'memory' ? "Couldn't save memory. Try again." : 'quota exceeded'
        );
        setStoredDraft(store.get(pendingApprovalAtom));
        const retry = view.getByRole('button', { name: kind === 'memory' ? 'Retry' : saveName });
        await act(async () => {
          if (stop === 'terminal') {
            live = false;
          } else if (stop === 'cancelled') {
            controller.abort();
          } else if (stop === 'expired') {
            now.mockReturnValue(expiresAt);
          } else {
            store.set(pendingApprovalAtom, undefined);
          }
          fireEvent.click(retry);
          await Promise.resolve();
        });
        controller.abort();
        await expect(approval).resolves.toStrictEqual({ status: 'aborted' });
        await waitFor(() => {
          expect(view.queryByRole('dialog')).toBeNull();
        });
        expect(saved).toStrictEqual([]);
        expect(store.get(pendingApprovalAtom)).toBeUndefined();
        expect(store.get(pendingLockAtom)).toBe(false);
      } finally {
        now.mockRestore();
        controller.abort();
        await approval;
      }
    }
  );

  it('keeps supervision inside editing and saving, then preserves the existing completion view', async () => {
    const gate = Promise.withResolvers<void>();
    saveGate = gate.promise;
    const view = render(createElement(Component), { wrapper: createSupervisedWrapper(store) });
    const button = await view.findByRole('button', { name: saveName });
    const dialog = view.getByRole('dialog');
    expect(within(dialog).getByText('CLI owner — Example tab')).toBeDefined();
    fireEvent.click(button);
    await saveStarted.promise;
    const stop = within(dialog).getByRole('button', { name: 'Stop CLI task' });
    stop.focus();
    expect(document.activeElement).toBe(stop);
    expect(stop.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    setStoredDraft(undefined);
    view.rerender(createElement(Component));
    if (kind === 'memory') {
      await view.findByText('Saved to memory');
      expect(
        within(view.getByRole('dialog')).getByRole('button', { name: 'Stop CLI task' })
      ).toBeDefined();
      fireEvent.click(view.getByRole('button', { name: 'Done' }));
    }
    await waitFor(() => {
      expect(view.queryByRole('dialog')).toBeNull();
    });
  });

  it.each(['full', 'retryable'] as const)(
    'keeps supervision inside the %s save state',
    async failure => {
      const error = new Error('quota exceeded');
      if (failure === 'full') {
        error.name =
          kind === 'memory' ? 'AgentMemoryStoreFullError' : 'AgentWorkflowStoreFullError';
      }
      mockAddAgentMemory.mockRejectedValue(error);
      mockAddAgentWorkflow.mockRejectedValue(error);
      const view = render(createElement(Component), { wrapper: createSupervisedWrapper(store) });
      fireEvent.click(await view.findByRole('button', { name: saveName }));
      const messages = {
        memory: {
          full: 'Memory is full. Delete memories to save new ones.',
          retryable: "Couldn't save memory. Try again.",
        },
        workflow: { full: 'Workflow store is full.', retryable: 'quota exceeded' },
      };
      await view.findByText(messages[kind][failure]);
      const stop = within(view.getByRole('dialog')).getByRole('button', { name: 'Stop CLI task' });
      expect(stop.hasAttribute('disabled')).toBe(false);
      expect(saved).toStrictEqual([]);
    }
  );

  it('keeps supervision and recovery controls inside load errors', async () => {
    mockLoadPendingWorkflowDraft.mockRejectedValue(new Error('Read failed.'));
    mockUseAgentMemories.mockReturnValue({
      isLoaded: true,
      loadError: true,
      memories: [],
      pendingDraft: memoryDraft(),
      reload,
    });
    const view = render(createElement(Component), { wrapper: createSupervisedWrapper(store) });
    const recovery = kind === 'memory' ? 'Retry' : 'Dismiss';
    await view.findByRole('button', { name: recovery });
    expect(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Stop CLI task' })
    ).toBeDefined();
    expect(view.queryByRole('button', { name: saveName })).toBeNull();
  });

  it('retains local reload approval without a supervision provider', async () => {
    const view = render(createElement(Component), { wrapper: createWrapper(store) });
    fireEvent.click(await view.findByRole('button', { name: saveName }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(view.queryByRole('button', { name: 'Stop CLI task' })).toBeNull();
  });
});
