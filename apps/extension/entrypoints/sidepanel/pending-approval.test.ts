/* eslint-disable max-lines, no-unsafe-type-assertion, require-await, jest/no-hooks, jest/valid-title, promise/avoid-new, vitest/prefer-expect-type-of -- test fixture constraints */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import type { PendingAgentMemoryDraft } from '@/src/shared/agent-memories';
import { DEFAULT_WORKFLOW_SETTINGS, MAX_WORKFLOW_COUNT } from '@/src/shared/agent-workflows';
import type { PendingAgentWorkflowDraft } from '@/src/shared/agent-workflows';
import {
  pendingApprovalAtom,
  pendingLockAtom,
  applyApprovalDecision,
  requestApproval,
} from './pending-approval';
import {
  loadPendingWorkflowDraft,
  savePendingWorkflowDraft,
} from '@/src/shared/agent-workflows-storage';

// ---------- helpers ----------

interface TestStorage {
  values: Map<string, unknown>;
  failRemoveItem: boolean;
  failSetItem: boolean;
  getItem(key: string): unknown;
  setItem(key: string, value: unknown): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const createStorage = ({
  failRemoveItem = false,
  failSetItem = false,
}: {
  failRemoveItem?: boolean;
  failSetItem?: boolean;
} = {}): TestStorage => {
  const values = new Map<string, unknown>();

  return {
    failRemoveItem,
    failSetItem,
    getItem: (key: string) => values.get(key),
    removeItem: async (key: string) => {
      if (failRemoveItem) {
        throw new Error('Storage remove failed.');
      }
      values.delete(key);
    },
    setItem: async (key: string, value: unknown) => {
      if (failSetItem) {
        throw new Error('Storage write failed.');
      }
      values.set(key, value);
    },
    values,
  };
};

/* A getItem that throws for one key, so a settings read failure is testable
   without a conditional inside the test body. */
const failGetItemForKey = (storage: TestStorage, failingKey: string): void => {
  const { values } = storage;

  storage.getItem = (key: string) => {
    if (key === failingKey) {
      throw new Error('Settings read failed.');
    }

    return values.get(key);
  };
};

const memoryDraft = (
  overrides: Partial<PendingAgentMemoryDraft> = {}
): PendingAgentMemoryDraft => ({
  createdAt: 1_700_000_000_000,
  pageTitle: 'Test Page',
  pageUrl: 'https://example.com/page',
  text: 'Some text',
  ...overrides,
});

const workflowDraft = (
  overrides: Partial<PendingAgentWorkflowDraft> = {}
): PendingAgentWorkflowDraft => ({
  createdAt: 1_700_000_000_000,
  description: 'A test workflow',
  name: 'Test Workflow',
  scopeOrigin: 'https://example.com',
  script: 'return { done: true, result: 1 };',
  ...overrides,
});

const abortSignal = (): AbortSignal => {
  const controller = new AbortController();
  return controller.signal;
};

// Workflow settings value that enables auto-approve of workflow changes.
const autoApproveSettings = (): Record<string, unknown> => ({
  ...DEFAULT_WORKFLOW_SETTINGS,
  autoApproveWorkflowChanges: true,
});

// Memory settings value that enables auto-approve of memory saves.
const autoApproveMemorySettings = (): Record<string, unknown> => ({
  autoApproveMemorySaves: true,
});

// Clear the atom and lock between tests.
const clearAtom = (): void => {
  getDefaultStore().set(pendingApprovalAtom, undefined);
  getDefaultStore().set(pendingLockAtom, false);
};

// ---------- tests ----------

describe(applyApprovalDecision, () => {
  it('reject clears the stored draft and returns rejected', async () => {
    const storage = createStorage();
    const draft = memoryDraft();

    const outcome = await applyApprovalDecision(storage, 'memory', draft, false);
    expect(outcome).toStrictEqual({ status: 'rejected' });
    expect(storage.values.has('local:kiloPendingAgentMemoryDraft')).toBe(false);
  });

  it('reject returns rejected when clearDraft fails', async () => {
    const storage = createStorage({ failRemoveItem: true });
    const draft = memoryDraft();

    const outcome = await applyApprovalDecision(storage, 'memory', draft, false);
    // Must still return rejected, not throw.
    expect(outcome).toStrictEqual({ status: 'rejected' });
  });

  it('approve saves memory once and returns approved with savedId', async () => {
    const storage = createStorage();
    const draft = memoryDraft({ note: 'my note' });

    // Seed empty memory store.
    storage.values.set('local:kiloAgentMemories', []);

    const outcome = await applyApprovalDecision(storage, 'memory', draft, true);
    expect(outcome.status).toBe('approved');
    expect(typeof (outcome as { savedId: string }).savedId).toBe('string');
    // Draft should be cleared.
    expect(storage.values.has('local:kiloPendingAgentMemoryDraft')).toBe(false);
    // Memory should be persisted.
    const memories = storage.values.get('local:kiloAgentMemories') as Record<string, unknown>[];
    expect(memories).toHaveLength(1);
    expect(memories[0]?.['note']).toBe('my note');
  });

  it('approve keeps card-edited note', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentMemories', []);
    const draft = memoryDraft({ note: 'original note' });

    const outcome = await applyApprovalDecision(storage, 'memory', draft, true);
    expect(outcome.status).toBe('approved');

    const memories = storage.values.get('local:kiloAgentMemories') as Record<string, unknown>[];
    expect(memories[0]?.['note']).toBe('original note');
  });

  it('approve omits note when explicitly set to undefined', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentMemories', []);
    // Spread sets note to undefined explicitly, overriding an optional property.
    const draft = {
      ...memoryDraft({ note: 'stale note' }),
      note: undefined,
    } as PendingAgentMemoryDraft;

    const outcome = await applyApprovalDecision(storage, 'memory', draft, true);
    expect(outcome.status).toBe('approved');

    const memories = storage.values.get('local:kiloAgentMemories') as Record<string, unknown>[];
    expect(memories[0]).not.toHaveProperty('note');
  });

  it('persist failure (store full) keeps draft and returns failed with reason', async () => {
    const storage = createStorage();

    // Pre-fill memory store to max.
    const fullMemories = Array.from({ length: 200 }, (_unused, index) => ({
      createdAt: index,
      id: `mem-${index}`,
      pageTitle: 'Page',
      pageUrl: 'https://example.com',
      text: 'text',
    }));
    storage.values.set('local:kiloAgentMemories', fullMemories);

    const draft = memoryDraft();
    const outcome = await applyApprovalDecision(storage, 'memory', draft, true);
    expect(outcome).toStrictEqual({ reason: 'Memory store is full.', status: 'failed' });
    // Draft should remain (card shows full view from live draft).
    // The card's state module handles the full view from memories count.
  });

  it('approve saves workflow with approved hash', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentWorkflows', []);
    const draft = workflowDraft({
      description: 'desc',
      name: 'My WF',
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 1 };',
    });

    const outcome = await applyApprovalDecision(storage, 'workflow', draft, true);
    expect(outcome.status).toBe('approved');
    expect(typeof (outcome as { savedId: string }).savedId).toBe('string');

    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.['approvedScriptHash']).toBeDefined();
    expect(typeof workflows[0]?.['approvedScriptHash']).toBe('string');
  });

  it('approve updates existing workflow and sets approved hash', async () => {
    const storage = createStorage();
    const existing: Record<string, unknown> = {
      approvedScriptHash: undefined,
      createdAt: 100,
      description: 'old desc',
      id: 'wf-existing',
      name: 'Old',
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      updatedAt: 100,
    };
    storage.values.set('local:kiloAgentWorkflows', [existing]);

    const draft = workflowDraft({
      description: 'new desc',
      name: 'Updated',
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 2 };',
      workflowId: 'wf-existing',
    });

    const outcome = await applyApprovalDecision(storage, 'workflow', draft, true);
    expect(outcome.status).toBe('approved');
    expect((outcome as { savedId: string }).savedId).toBe('wf-existing');

    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    expect(workflows[0]?.['name']).toBe('Updated');
    expect(workflows[0]?.['approvedScriptHash']).toBeDefined();
  });

  it('approve update returns failed when original workflow was deleted', async () => {
    const storage = createStorage();
    // No workflows stored — simulating a deleted workflow.
    storage.values.set('local:kiloAgentWorkflows', []);

    const draft = workflowDraft({
      description: 'new desc',
      name: 'Updated',
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 2 };',
      workflowId: 'wf-deleted',
    });

    const outcome = await applyApprovalDecision(storage, 'workflow', draft, true);
    expect(outcome).toMatchObject({
      reason: 'Workflow not found.',
      status: 'failed',
    });
  });

  it('approve update clears pathPrefix when draft has empty-string sentinel', async () => {
    const storage = createStorage();
    const existing: Record<string, unknown> = {
      approvedScriptHash: undefined,
      createdAt: 100,
      description: 'old desc',
      id: 'wf-existing',
      name: 'Old',
      pathPrefix: '/old-prefix',
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      startUrl: 'https://example.com/start',
      updatedAt: 100,
    };
    storage.values.set('local:kiloAgentWorkflows', [existing]);

    // Draft with pathPrefix: '' — the empty-string sentinel for "explicitly cleared".
    const draft = workflowDraft({
      description: 'new desc',
      name: 'Updated',
      pathPrefix: '',
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 2 };',
      startUrl: 'https://example.com/start',
      workflowId: 'wf-existing',
    });

    const outcome = await applyApprovalDecision(storage, 'workflow', draft, true);
    expect(outcome.status).toBe('approved');

    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    // PathPrefix must be cleared — not present on the stored workflow.
    expect(workflows[0]).not.toHaveProperty('pathPrefix');
    // StartUrl was provided as a real value, so keep it.
    expect(workflows[0]?.['startUrl']).toBe('https://example.com/start');
  });

  it('approve update clears startUrl when draft has empty-string sentinel', async () => {
    const storage = createStorage();
    const existing: Record<string, unknown> = {
      approvedScriptHash: undefined,
      createdAt: 100,
      description: 'old desc',
      id: 'wf-existing',
      name: 'Old',
      pathPrefix: '/old-prefix',
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      startUrl: 'https://example.com/start',
      updatedAt: 100,
    };
    storage.values.set('local:kiloAgentWorkflows', [existing]);

    // Draft with startUrl: '' — the sentinel for "explicitly cleared".
    const draft = workflowDraft({
      description: 'new desc',
      name: 'Updated',
      pathPrefix: '/old-prefix',
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 2 };',
      startUrl: '',
      workflowId: 'wf-existing',
    });

    const outcome = await applyApprovalDecision(storage, 'workflow', draft, true);
    expect(outcome.status).toBe('approved');

    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    // StartUrl must be cleared.
    expect(workflows[0]).not.toHaveProperty('startUrl');
    // PathPrefix was not explicitly cleared, so keep existing.
    expect(workflows[0]?.['pathPrefix']).toBe('/old-prefix');
  });

  it('save-and-reload preserves empty-string clear sentinel', async () => {
    const storage = createStorage();
    const existing: Record<string, unknown> = {
      approvedScriptHash: undefined,
      createdAt: 100,
      description: 'old desc',
      id: 'wf-existing',
      name: 'Old',
      pathPrefix: '/old-prefix',
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      startUrl: 'https://example.com/start',
      updatedAt: 100,
    };
    storage.values.set('local:kiloAgentWorkflows', [existing]);

    // Save a pending draft that clears both pathPrefix and startUrl.
    const draft = workflowDraft({
      description: 'new desc',
      name: 'Updated',
      pathPrefix: '',
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 2 };',
      startUrl: '',
      workflowId: 'wf-existing',
    });
    await savePendingWorkflowDraft(storage, draft);

    // Reload — simulates panel close / reopen.
    const reloaded = await loadPendingWorkflowDraft(storage);
    expect(reloaded).toBeDefined();
    // Empty string must survive the round-trip without becoming null.
    expect(reloaded?.pathPrefix).toBe('');
    expect(reloaded?.startUrl).toBe('');
  });

  it('reloaded clear-intent draft clears stored fields on approve', async () => {
    const storage = createStorage();
    const existing: Record<string, unknown> = {
      approvedScriptHash: undefined,
      createdAt: 100,
      description: 'old desc',
      id: 'wf-existing',
      name: 'Old',
      pathPrefix: '/old-prefix',
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      startUrl: 'https://example.com/start',
      updatedAt: 100,
    };
    storage.values.set('local:kiloAgentWorkflows', [existing]);

    const draft = workflowDraft({
      description: 'new desc',
      name: 'Updated',
      pathPrefix: '',
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 2 };',
      startUrl: '',
      workflowId: 'wf-existing',
    });
    await savePendingWorkflowDraft(storage, draft);

    const reloaded = await loadPendingWorkflowDraft(storage);
    const outcome = await applyApprovalDecision(storage, 'workflow', reloaded!, true);
    expect(outcome.status).toBe('approved');

    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    expect(workflows[0]?.['pathPrefix']).toBeUndefined();
    expect(workflows[0]?.['startUrl']).toBeUndefined();
    // Draft must be cleared after approval.
    expect(storage.values.has('local:kiloPendingWorkflowSave')).toBe(false);
  });

  it('memory store-full failed outcome is distinct from generic failed', async () => {
    const storage = createStorage();

    // Pre-fill to max so applyApprovalDecision detects store-full.
    const fullMemories = Array.from({ length: 200 }, (_unused, index) => ({
      createdAt: index,
      id: `mem-${index}`,
      pageTitle: 'Page',
      pageUrl: 'https://example.com',
      text: 'text',
    }));
    storage.values.set('local:kiloAgentMemories', fullMemories);

    const draft = memoryDraft();
    const storeFull = await applyApprovalDecision(storage, 'memory', draft, true);

    // Store-full has distinct reason.
    expect(storeFull).toStrictEqual({ reason: 'Memory store is full.', status: 'failed' });

    // Verify a non-full generic failure has a different reason.
    const badStorage = createStorage({ failSetItem: true });
    const draft2 = memoryDraft();
    const genFail = await applyApprovalDecision(badStorage, 'memory', draft2, true);
    expect(genFail.status).toBe('failed');
    expect(genFail).not.toStrictEqual(storeFull);
  });
});

describe(requestApproval, () => {
  beforeEach(() => {
    clearAtom();
  });

  afterEach(() => {
    clearAtom();
  });

  it('persists draft and sets atom entry', async () => {
    const storage = createStorage();
    const draft = memoryDraft();

    // Start approval but don't await — requestApproval persists before returning the inner Promise.
    const promise = requestApproval(storage, 'memory', draft, abortSignal());

    // Wait for requestApproval to complete persistDraft and set the atom.
    // The test storage's setItem is async, so the await persistDraft yields to microtasks.
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    // Atom should be set.
    const atomStore = getDefaultStore();
    const entry = atomStore.get(pendingApprovalAtom);
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('memory');

    // Settle it.
    entry?.settle({ autoApproved: false, savedId: 'mem-test', status: 'approved' });

    const outcome = await promise;
    expect(outcome).toStrictEqual({ autoApproved: false, savedId: 'mem-test', status: 'approved' });
    // Atom should be cleared.
    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
  });

  it('settle is first-wins: abort then click returns aborted', async () => {
    const storage = createStorage();
    const draft = memoryDraft();
    const controller = new AbortController();

    const promise = requestApproval(storage, 'memory', draft, controller.signal);

    // Abort first.
    controller.abort();

    // Then try to settle via atom.
    const atomStore = getDefaultStore();
    const entry = atomStore.get(pendingApprovalAtom);
    // After abort, the entry may already be cleared or still being cleared.
    entry?.settle({ autoApproved: false, savedId: 'late', status: 'approved' });

    const outcome = await promise;
    expect(outcome.status).toBe('aborted');
  });

  it('abort clears and settles aborted', async () => {
    const storage = createStorage();
    const draft = memoryDraft();
    const controller = new AbortController();

    const promise = requestApproval(storage, 'memory', draft, controller.signal);
    controller.abort();

    const outcome = await promise;
    expect(outcome).toStrictEqual({ status: 'aborted' });
  });

  it('single-flight rejects second concurrent request', async () => {
    const storage = createStorage();
    const draft1 = memoryDraft({ text: 'first' });
    const draft2 = memoryDraft({ text: 'second' });

    // Start first approval (don't await).
    void requestApproval(storage, 'memory', draft1, abortSignal());

    // Second should fail immediately.
    const outcome2 = await requestApproval(storage, 'memory', draft2, abortSignal());
    expect(outcome2).toStrictEqual({
      reason: 'Another approval is already pending.',
      status: 'failed',
    });
  });

  it('reload path: applyApprovalDecision works without atom entry', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentMemories', []);
    const draft = memoryDraft();

    // Direct call — no atom entry exists.
    const outcome = await applyApprovalDecision(storage, 'memory', draft, true);
    expect(outcome.status).toBe('approved');
  });

  it('settle clears atom entry after approve', async () => {
    const storage = createStorage();
    const draft = memoryDraft();

    const promise = requestApproval(storage, 'memory', draft, abortSignal());

    // Wait for requestApproval to complete persistDraft and set the atom.
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const atomStore = getDefaultStore();
    expect(atomStore.get(pendingApprovalAtom)).toBeDefined();

    atomStore
      .get(pendingApprovalAtom)
      ?.settle({ autoApproved: false, savedId: 'id', status: 'approved' });
    await promise;

    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
  });

  it('settle clears atom entry after reject', async () => {
    const storage = createStorage();
    const draft = memoryDraft();

    const promise = requestApproval(storage, 'memory', draft, abortSignal());

    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const atomStore = getDefaultStore();
    atomStore.get(pendingApprovalAtom)?.settle({ status: 'rejected' });
    await promise;

    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
  });

  it('settle clears atom entry after failed', async () => {
    const storage = createStorage();
    const draft = memoryDraft();

    const promise = requestApproval(storage, 'memory', draft, abortSignal());

    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const atomStore = getDefaultStore();
    atomStore.get(pendingApprovalAtom)?.settle({ reason: 'error', status: 'failed' });
    await promise;

    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
  });

  it('persist failure returns failed and never sets the atom', async () => {
    const storage = createStorage({ failSetItem: true });
    const draft = memoryDraft();

    const outcome = await requestApproval(storage, 'memory', draft, abortSignal());
    expect(outcome.status).toBe('failed');
    expect(outcome).toMatchObject({ reason: 'Storage write failed.' });

    // Atom must NOT be set.
    const atomStore = getDefaultStore();
    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
  });

  it('second approval succeeds after first settles', async () => {
    const storage = createStorage();
    const draft1 = memoryDraft({ text: 'first' });

    // First approval.
    const promise1 = requestApproval(storage, 'memory', draft1, abortSignal());

    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const atomStore = getDefaultStore();
    const entry1 = atomStore.get(pendingApprovalAtom);
    expect(entry1).toBeDefined();

    // Settle first and verify lock release.
    entry1?.settle({ status: 'rejected' });
    const outcome1 = await promise1;
    expect(outcome1.status).toBe('rejected');
    expect(atomStore.get(pendingLockAtom)).toBe(false);
    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
  });

  it('lock released after settle allows new approval', async () => {
    const storage = createStorage();
    const draft1 = memoryDraft({ text: 'first' });
    const draft2 = memoryDraft({ text: 'second' });

    const promise1 = requestApproval(storage, 'memory', draft1, abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const atomStore = getDefaultStore();
    atomStore.get(pendingApprovalAtom)?.settle({ status: 'rejected' });
    await promise1;

    // Second approval must succeed.
    const promise2 = requestApproval(storage, 'memory', draft2, abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const entry2 = atomStore.get(pendingApprovalAtom);
    expect(entry2).toBeDefined();
    entry2?.settle({ autoApproved: false, savedId: 'mem-2', status: 'approved' });

    const outcome2 = await promise2;
    expect(outcome2.status).toBe('approved');
  });

  it('second settlement promise resolves with second outcome after first rejected', async () => {
    const storage = createStorage();
    const draft1 = memoryDraft({ text: 'first' });

    // First proposal.
    const promise1 = requestApproval(storage, 'memory', draft1, abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const atomStore = getDefaultStore();
    const entry1 = atomStore.get(pendingApprovalAtom);
    expect(entry1?.kind).toBe('memory');

    // Reject first.
    entry1?.settle({ status: 'rejected' });
    const outcome1 = await promise1;
    expect(outcome1).toStrictEqual({ status: 'rejected' });

    // Lock and atom must be released.
    expect({
      atom: atomStore.get(pendingApprovalAtom),
      lock: atomStore.get(pendingLockAtom),
    }).toStrictEqual({ atom: undefined, lock: false });

    // Second proposal with new draft.
    const draft2 = memoryDraft({ createdAt: 1_700_000_000_001, text: 'second' });
    const promise2 = requestApproval(storage, 'memory', draft2, abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const entry2 = atomStore.get(pendingApprovalAtom)!;
    // Verify it's a new draft kind and text, not the old one.
    expect({
      kind: entry2.kind,
      text: (entry2.draft as PendingAgentMemoryDraft).text,
    }).toStrictEqual({ kind: 'memory', text: 'second' });

    // Settle second with approved outcome.
    entry2?.settle({ autoApproved: false, savedId: 'mem-second', status: 'approved' });
    const outcome2 = await promise2;
    expect(outcome2).toStrictEqual({
      autoApproved: false,
      savedId: 'mem-second',
      status: 'approved',
    });
  });

  it('second settlement promise resolves after first failed', async () => {
    const storage = createStorage();
    const draft1 = memoryDraft({ text: 'first' });

    // First proposal.
    const promise1 = requestApproval(storage, 'memory', draft1, abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const atomStore = getDefaultStore();
    // Settle first with a generic failure.
    atomStore.get(pendingApprovalAtom)?.settle({ reason: 'quota exceeded', status: 'failed' });
    const outcome1 = await promise1;
    expect(outcome1).toStrictEqual({ reason: 'quota exceeded', status: 'failed' });

    // Second proposal must succeed.
    const draft2 = memoryDraft({ createdAt: 1_700_000_000_001, text: 'second' });
    const promise2 = requestApproval(storage, 'memory', draft2, abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const entry2 = atomStore.get(pendingApprovalAtom);
    expect(entry2).toBeDefined();
    entry2?.settle({ autoApproved: false, savedId: 'mem-2', status: 'approved' });

    const outcome2 = await promise2;
    expect(outcome2).toStrictEqual({ autoApproved: false, savedId: 'mem-2', status: 'approved' });
  });

  it('auto-approve workflow save persists approved hash without card or draft', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentWorkflows', []);
    storage.values.set('local:kiloWorkflowSettings', autoApproveSettings());
    const draft = workflowDraft();

    const outcome = await requestApproval(storage, 'workflow', draft, abortSignal());
    expect(outcome).toMatchObject({ autoApproved: true, status: 'approved' });

    // The stored workflow id matches the approved outcome's savedId.
    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    expect(workflows[0]?.['id']).toBe((outcome as { savedId: string }).savedId);
    expect(workflows[0]?.['approvedScriptHash']).toBeDefined();
    expect(storage.values.has('local:kiloPendingWorkflowSave')).toBe(false);

    // No card and the lock released.
    const atomStore = getDefaultStore();
    expect({
      atom: atomStore.get(pendingApprovalAtom),
      lock: atomStore.get(pendingLockAtom),
    }).toStrictEqual({ atom: undefined, lock: false });
  });

  it('auto-approve returns aborted when the signal is already aborted and releases the lock', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentWorkflows', []);
    storage.values.set('local:kiloWorkflowSettings', autoApproveSettings());
    const controller = new AbortController();
    controller.abort();

    const outcome = await requestApproval(storage, 'workflow', workflowDraft(), controller.signal);
    expect(outcome).toStrictEqual({ status: 'aborted' });

    // No save happened, no draft, no card, lock released.
    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    expect(workflows).toStrictEqual([]);
    expect(storage.values.has('local:kiloPendingWorkflowSave')).toBe(false);
    const atomStore = getDefaultStore();
    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
    expect(atomStore.get(pendingLockAtom)).toBe(false);
  });

  it('auto-approve returns failed with store-full reason and releases the lock', async () => {
    const storage = createStorage();
    const fullWorkflows = Array.from({ length: MAX_WORKFLOW_COUNT }, (_unused, index) => ({
      approvedScriptHash: `hash-${index}`,
      createdAt: index,
      description: 'desc',
      id: `wf-${index}`,
      name: `WF ${index}`,
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      updatedAt: index,
    }));
    storage.values.set('local:kiloAgentWorkflows', fullWorkflows);
    storage.values.set('local:kiloWorkflowSettings', autoApproveSettings());

    const outcome = await requestApproval(storage, 'workflow', workflowDraft(), abortSignal());
    expect(outcome).toStrictEqual({ reason: 'Workflow store is full.', status: 'failed' });

    // No card was set and the lock released for a retry.
    const atomStore = getDefaultStore();
    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
    expect(atomStore.get(pendingLockAtom)).toBe(false);
  });

  it('falls back to the approval card when the auto-approve settings cannot be read', async () => {
    const storage = createStorage();
    // Any storage read fails, which surfaces at the settings read (the first storage call).
    storage.getItem = () => {
      throw new Error('Settings read failed.');
    };

    const promise = requestApproval(storage, 'workflow', workflowDraft(), abortSignal());

    // Wait for requestApproval to persist the draft and set the atom.
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    // The card shows despite the failed settings read: draft persisted, atom set.
    const atomStore = getDefaultStore();
    expect({
      draft: storage.values.has('local:kiloPendingWorkflowSave'),
      kind: atomStore.get(pendingApprovalAtom)?.kind,
    }).toStrictEqual({ draft: true, kind: 'workflow' });

    // Auto-approve did not run: no workflow was saved.
    expect(storage.values.has('local:kiloAgentWorkflows')).toBe(false);

    // A card approval settles approved with autoApproved false and releases the lock.
    atomStore.get(pendingApprovalAtom)?.settle({
      autoApproved: false,
      savedId: 'wf-card',
      status: 'approved',
    });
    const outcome = await promise;
    expect(outcome).toStrictEqual({
      autoApproved: false,
      savedId: 'wf-card',
      status: 'approved',
    });
    expect({
      atom: atomStore.get(pendingApprovalAtom),
      lock: atomStore.get(pendingLockAtom),
    }).toStrictEqual({ atom: undefined, lock: false });
  });

  it('abort during the settings read releases the lock when the load resolves', async () => {
    const storage = createStorage();
    const controller = new AbortController();

    // Pause the settings read so the abort lands mid-flight.
    // The settings read is the first and only storage call before the abort check.
    const { promise: settingsRead, resolve: resolveSettings } = Promise.withResolvers<unknown>();
    storage.getItem = () => settingsRead;

    const approval = requestApproval(storage, 'workflow', workflowDraft(), controller.signal);

    // Abort while the settings read is still pending, then let the load resolve.
    controller.abort();
    resolveSettings(autoApproveSettings());

    const outcome = await approval;
    expect(outcome).toStrictEqual({ status: 'aborted' });

    // The auto-approve save never ran, no draft was persisted, no card, and the lock released.
    expect({
      draft: storage.values.has('local:kiloPendingWorkflowSave'),
      workflows: storage.values.has('local:kiloAgentWorkflows'),
    }).toStrictEqual({ draft: false, workflows: false });
    expect({
      atom: getDefaultStore().get(pendingApprovalAtom),
      lock: getDefaultStore().get(pendingLockAtom),
    }).toStrictEqual({ atom: undefined, lock: false });
  });

  it('a card request succeeds after a settings read that also failed to persist', async () => {
    // The first request fails at the settings read and at the draft persist.
    // It returns failed and releases the lock. The next request must still work.
    const failingStorage = createStorage({ failSetItem: true });
    failingStorage.getItem = () => {
      throw new Error('Settings read failed.');
    };
    const first = await requestApproval(failingStorage, 'workflow', workflowDraft(), abortSignal());
    expect(first).toStrictEqual({ reason: 'Storage write failed.', status: 'failed' });

    const atomStore = getDefaultStore();
    expect({
      atom: atomStore.get(pendingApprovalAtom),
      lock: atomStore.get(pendingLockAtom),
    }).toStrictEqual({ atom: undefined, lock: false });

    // A new request with auto-approve off shows the card and persists the draft.
    const storage = createStorage();
    storage.values.set('local:kiloWorkflowSettings', {
      ...DEFAULT_WORKFLOW_SETTINGS,
      autoApproveWorkflowChanges: false,
    });
    storage.values.set('local:kiloAgentWorkflows', []);

    const promise = requestApproval(storage, 'workflow', workflowDraft(), abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    expect({
      draft: storage.values.has('local:kiloPendingWorkflowSave'),
      kind: atomStore.get(pendingApprovalAtom)?.kind,
    }).toStrictEqual({ draft: true, kind: 'workflow' });

    // Settle the card and clean up: no card and the lock released.
    atomStore.get(pendingApprovalAtom)?.settle({
      autoApproved: false,
      savedId: 'wf-retry',
      status: 'approved',
    });
    const outcome = await promise;
    expect(outcome).toStrictEqual({ autoApproved: false, savedId: 'wf-retry', status: 'approved' });
    expect({
      atom: atomStore.get(pendingApprovalAtom),
      lock: atomStore.get(pendingLockAtom),
    }).toStrictEqual({ atom: undefined, lock: false });
  });

  it('auto-approve returns failed when hashing the script fails and releases the lock', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentWorkflows', []);
    storage.values.set('local:kiloWorkflowSettings', autoApproveSettings());
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('hash failed'));

    try {
      const outcome = await requestApproval(storage, 'workflow', workflowDraft(), abortSignal());
      expect(outcome).toStrictEqual({ reason: 'hash failed', status: 'failed' });
    } finally {
      digestSpy.mockRestore();
    }

    // Nothing was saved, no card, and the lock released.
    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    expect(workflows).toStrictEqual([]);
    const atomStore = getDefaultStore();
    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
    expect(atomStore.get(pendingLockAtom)).toBe(false);
  });

  it('auto-approve returns failed for a kind mismatch and releases the lock', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentWorkflows', []);
    storage.values.set('local:kiloWorkflowSettings', autoApproveSettings());

    // A memory draft cannot be saved as a workflow kind.
    const outcome = await requestApproval(storage, 'workflow', memoryDraft(), abortSignal());
    expect(outcome).toStrictEqual({
      reason: 'Approval draft does not match its kind.',
      status: 'failed',
    });

    // Nothing was saved, no card, and the lock released.
    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    expect(workflows).toStrictEqual([]);
    const atomStore = getDefaultStore();
    expect(atomStore.get(pendingApprovalAtom)).toBeUndefined();
    expect(atomStore.get(pendingLockAtom)).toBe(false);
  });

  it('auto-approve clears a stale pending draft after saving', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentWorkflows', []);
    storage.values.set('local:kiloWorkflowSettings', autoApproveSettings());
    // A stale draft left behind by an earlier interrupted card flow.
    await savePendingWorkflowDraft(storage, workflowDraft({ name: 'stale' }));

    const outcome = await requestApproval(
      storage,
      'workflow',
      workflowDraft({ name: 'new' }),
      abortSignal()
    );
    expect(outcome).toMatchObject({ autoApproved: true, status: 'approved' });

    // The stale draft is gone and only the new workflow was saved.
    expect(storage.values.has('local:kiloPendingWorkflowSave')).toBe(false);
    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.['name']).toBe('new');
  });

  it('workflow save with auto-approve off still shows the card and returns autoApproved false', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentWorkflows', []);
    storage.values.set('local:kiloWorkflowSettings', {
      ...DEFAULT_WORKFLOW_SETTINGS,
      autoApproveWorkflowChanges: false,
    });

    const promise = requestApproval(storage, 'workflow', workflowDraft(), abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    // The card entry exists and the draft is persisted for it.
    const atomStore = getDefaultStore();
    const entry = atomStore.get(pendingApprovalAtom);
    expect(entry?.kind).toBe('workflow');
    expect(storage.values.has('local:kiloPendingWorkflowSave')).toBe(true);
    // The workflow was NOT auto-saved.
    const workflows = storage.values.get('local:kiloAgentWorkflows') as Record<string, unknown>[];
    expect(workflows).toStrictEqual([]);

    // Card approval returns autoApproved false.
    entry?.settle({ autoApproved: false, savedId: 'wf-card', status: 'approved' });
    const outcome = await promise;
    expect(outcome).toStrictEqual({
      autoApproved: false,
      savedId: 'wf-card',
      status: 'approved',
    });
    expect(atomStore.get(pendingLockAtom)).toBe(false);
  });

  it('memory save always shows the card even when workflow auto-approve is enabled', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentMemories', []);
    storage.values.set('local:kiloWorkflowSettings', autoApproveSettings());

    const promise = requestApproval(storage, 'memory', memoryDraft(), abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    // The card entry exists and the draft is persisted for it.
    const atomStore = getDefaultStore();
    const entry = atomStore.get(pendingApprovalAtom);
    expect(entry?.kind).toBe('memory');
    expect(storage.values.has('local:kiloPendingAgentMemoryDraft')).toBe(true);
    // The memory was NOT auto-saved.
    const memories = storage.values.get('local:kiloAgentMemories') as unknown[];
    expect(memories).toStrictEqual([]);

    entry?.settle({ autoApproved: false, savedId: 'mem-card', status: 'approved' });
    const outcome = await promise;
    expect(outcome).toStrictEqual({
      autoApproved: false,
      savedId: 'mem-card',
      status: 'approved',
    });
    expect(atomStore.get(pendingLockAtom)).toBe(false);
  });

  it('auto-approve memory save stores the memory without a card or draft', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentMemories', []);
    storage.values.set('local:kiloMemorySettings', autoApproveMemorySettings());

    const outcome = await requestApproval(storage, 'memory', memoryDraft(), abortSignal());
    expect(outcome).toMatchObject({ autoApproved: true, status: 'approved' });

    const memories = storage.values.get('local:kiloAgentMemories') as Record<string, unknown>[];
    expect(memories[0]?.['id']).toBe((outcome as { savedId: string }).savedId);
    expect(storage.values.has('local:kiloPendingAgentMemoryDraft')).toBe(false);

    // No card and the lock released.
    const atomStore = getDefaultStore();
    expect({
      atom: atomStore.get(pendingApprovalAtom),
      lock: atomStore.get(pendingLockAtom),
    }).toStrictEqual({ atom: undefined, lock: false });
  });

  it('shows the memory card when auto-approve of memory saves is off', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentMemories', []);
    storage.values.set('local:kiloMemorySettings', { autoApproveMemorySaves: false });

    const promise = requestApproval(storage, 'memory', memoryDraft(), abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const atomStore = getDefaultStore();
    expect({
      draft: storage.values.has('local:kiloPendingAgentMemoryDraft'),
      kind: atomStore.get(pendingApprovalAtom)?.kind,
      memories: storage.values.get('local:kiloAgentMemories'),
    }).toStrictEqual({ draft: true, kind: 'memory', memories: [] });

    atomStore.get(pendingApprovalAtom)?.settle({
      autoApproved: false,
      savedId: 'mem-off',
      status: 'approved',
    });
    await promise;
  });

  it('falls back to the memory card when the memory settings cannot be read', async () => {
    const storage = createStorage();
    storage.values.set('local:kiloAgentMemories', []);
    failGetItemForKey(storage, 'local:kiloMemorySettings');

    const promise = requestApproval(storage, 'memory', memoryDraft(), abortSignal());
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });

    const atomStore = getDefaultStore();
    expect({
      kind: atomStore.get(pendingApprovalAtom)?.kind,
      memories: storage.values.get('local:kiloAgentMemories'),
    }).toStrictEqual({ kind: 'memory', memories: [] });

    atomStore.get(pendingApprovalAtom)?.settle({
      autoApproved: false,
      savedId: 'mem-fallback',
      status: 'approved',
    });
    await promise;
  });
});
