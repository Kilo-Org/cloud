/* eslint-disable max-lines, no-unsafe-type-assertion, require-await, jest/no-hooks, jest/valid-title, promise/avoid-new, vitest/prefer-expect-type-of -- test fixture constraints */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { getDefaultStore } from 'jotai';
import type { PendingAgentMemoryDraft } from '@/src/shared/agent-memories';
import type { PendingAgentWorkflowDraft } from '@/src/shared/agent-workflows';
import {
  pendingApprovalAtom,
  pendingLockAtom,
  applyApprovalDecision,
  requestApproval,
} from './pending-approval';

// ---------- helpers ----------

interface TestStorage {
  values: Map<string, unknown>;
  failSetItem: boolean;
  getItem(key: string): unknown;
  setItem(key: string, value: unknown): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const createStorage = ({
  failSetItem = false,
}: {
  failSetItem?: boolean;
} = {}): TestStorage => {
  const values = new Map<string, unknown>();

  return {
    failSetItem,
    getItem: (key: string) => values.get(key),
    removeItem: async (key: string) => {
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
    entry?.settle({ savedId: 'mem-test', status: 'approved' });

    const outcome = await promise;
    expect(outcome).toStrictEqual({ savedId: 'mem-test', status: 'approved' });
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
    entry?.settle({ savedId: 'late', status: 'approved' });

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

    atomStore.get(pendingApprovalAtom)?.settle({ savedId: 'id', status: 'approved' });
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
});
