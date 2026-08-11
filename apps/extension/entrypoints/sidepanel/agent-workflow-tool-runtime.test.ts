/* eslint-disable max-lines, consistent-type-imports, no-unsafe-type-assertion, no-unsafe-assignment, no-useless-undefined, jest/no-untyped-mock-factory, jest/no-conditional-in-test, prefer-destructuring, import/first -- test mock factories and fixture coverage */
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { getDefaultStore } from 'jotai';
import type { WorkflowToolCallEvent } from '@/src/shared/agent-conversation';
import {
  AGENT_WORKFLOWS_STORAGE_KEY,
  PENDING_WORKFLOW_SAVE_STORAGE_KEY,
  WORKFLOW_SETTINGS_STORAGE_KEY,
} from '@/src/shared/agent-workflows-storage';
import {
  applyApprovalDecision,
  pendingApprovalAtom,
  pendingLockAtom,
  requestApproval as realRequestApproval,
} from './pending-approval';
import type { ApprovalOutcome } from './pending-approval';
import type { WorkflowToolContext } from './agent-workflow-tool-runtime';
import {
  executeWorkflowToolCall,
  formatEmptySearchMessage,
  resolveWorkflowStartUrl,
} from './agent-workflow-tool-runtime';

// ---------- mocks ----------

// eslint-disable-next-line vitest/prefer-import-in-mock
vi.mock('@/src/shared/agent-workflow-runner', () => ({
  runWorkflow: vi.fn().mockResolvedValue({ ok: true, pagesVisited: 1, result: 'success' }),
}));

import { runWorkflow } from '@/src/shared/agent-workflow-runner';

// ---------- helpers ----------

const createBaseCtx = (overrides: Partial<WorkflowToolContext> = {}): WorkflowToolContext => ({
  allowWorkflowsInSafeMode: false,
  evalInTab: vi
    .fn()
    .mockResolvedValue({ ok: true, value: { ok: true, value: { done: true, result: 'ok' } } }),
  getTabUrl: vi.fn().mockResolvedValue('https://example.com/page'),
  mode: 'dangerous',
  navigateTab: vi.fn().mockResolvedValue(undefined),
  requestApproval: vi.fn().mockResolvedValue({ savedId: 'test-id', status: 'approved' }),
  selectedTabId: 1,
  selectedTabTitle: 'Example Page',
  selectedTabUrl: 'https://example.com/page',
  signal: new AbortController().signal,
  storage: {
    getItem: vi.fn().mockResolvedValue([]),
    removeItem: vi.fn().mockResolvedValue(undefined),
    setItem: vi.fn().mockResolvedValue(undefined),
  },
  ...overrides,
});

const createToolCall = (name: string, args: Record<string, unknown> = {}): WorkflowToolCallEvent =>
  ({
    arguments: args,
    id: 'call-1',
    name,
    tabId: 1,
    type: 'tool-call',
  }) as unknown as WorkflowToolCallEvent;

// A requestApproval mock that stays pending until the test settles it.
// The runtime must read the runs setting only after this resolves.
// A change during the pending card must be reflected in the nextStep.
const deferredApproval = (): {
  requestApproval: Mock<WorkflowToolContext['requestApproval']>;
  settle: (outcome: ApprovalOutcome) => void;
} => {
  const { promise, resolve } = Promise.withResolvers<ApprovalOutcome>();
  const requestApproval = vi.fn<WorkflowToolContext['requestApproval']>(() => promise);
  return {
    requestApproval,
    settle: (outcome: ApprovalOutcome) => {
      resolve(outcome);
    },
  };
};

// ---------- search_workflows ----------

describe('search_workflows', () => {
  it('returns empty message when no workflows match', async () => {
    const ctx = createBaseCtx();
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await executeWorkflowToolCall(createToolCall('search_workflows'), ctx);
    expect(result).toStrictEqual({
      ok: true,
      value: { message: 'No workflows saved yet. Use save_workflow to create one.', results: [] },
    });
  });

  it('returns matching workflows', async () => {
    const ctx = createBaseCtx();
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        createdAt: 100,
        description: 'A test',
        id: 'wf-1',
        name: 'My Workflow',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
        updatedAt: 200,
      },
    ]);

    const result = await executeWorkflowToolCall(createToolCall('search_workflows'), ctx);
    expect(result.ok).toBe(true);
    const value = (result as { ok: true; value: { results: Record<string, unknown>[] } }).value;
    expect(value.results).toHaveLength(1);
    expect(value.results[0]?.['name']).toBe('My Workflow');
  });

  it('returns error for invalid arguments', async () => {
    const ctx = createBaseCtx();
    const result = await executeWorkflowToolCall(
      createToolCall('search_workflows', { query: 123 }),
      ctx
    );
    expect(result.ok).toBe(false);
  });
});

// ---------- get_workflow ----------

describe('get_workflow', () => {
  it('returns workflow by id', async () => {
    const ctx = createBaseCtx();
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        createdAt: 100,
        description: 'desc',
        id: 'wf-1',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
        updatedAt: 200,
      },
    ]);

    const result = await executeWorkflowToolCall(
      createToolCall('get_workflow', { workflowId: 'wf-1' }),
      ctx
    );
    expect(result.ok).toBe(true);
  });

  it('returns error for not found', async () => {
    const ctx = createBaseCtx();
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await executeWorkflowToolCall(
      createToolCall('get_workflow', { workflowId: 'nonexistent' }),
      ctx
    );
    expect(result.ok).toBe(false);
  });
});

// ---------- save_workflow ----------

describe('save_workflow', () => {
  it('approved outcome returns saved:true with workflowId and the ask-the-user nextStep', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi
        .fn()
        .mockResolvedValue({ autoApproved: false, savedId: 'new-wf-id', status: 'approved' }),
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: {
        autoApproved: false,
        nextStep:
          'Verify with run_workflow dryRun: true, then ask the user to start the first real run from Workflows in settings.',
        saved: true,
        workflowId: 'new-wf-id',
      },
    });
  });

  it('rejected outcome returns saved:false with reason', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({ status: 'rejected' }),
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: { reason: 'The user rejected the save.', saved: false },
    });
  });

  it('aborted outcome returns error', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({ status: 'aborted' }),
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      error: 'Run stopped before approval.',
      ok: false,
    });
  });

  it('failed outcome returns saved:false with reason', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi
        .fn()
        .mockResolvedValue({ reason: 'Some persist error', status: 'failed' }),
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: { reason: 'Some persist error', saved: false },
    });
  });

  it('create store-full pre-check returns without showing card', async () => {
    // Pre-fill store to max.
    const fullWorkflows = Array.from({ length: 100 }, (_unused, index) => ({
      createdAt: index,
      description: 'd',
      id: `wf-${index}`,
      name: 'WF',
      scopeOrigin: 'https://example.com',
      script: 'return 1;',
      updatedAt: index,
    }));
    const ctx = createBaseCtx();
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue(fullWorkflows);

    // RequestApproval should never be called.
    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: {
        reason: 'Workflow store is full. Delete a workflow first.',
        saved: false,
      },
    });
    expect(ctx.requestApproval).not.toHaveBeenCalled();
  });

  it('update does not check store fullness', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({ savedId: 'wf-1', status: 'approved' }),
    });
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        createdAt: 100,
        description: 'desc',
        id: 'wf-1',
        name: 'Existing',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
        updatedAt: 200,
      },
    ]);

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'Updated',
        scopeOrigin: 'https://example.com',
        script: 'return 2;',
        workflowId: 'wf-1',
      }),
      ctx
    );
    expect(result.ok).toBe(true);
  });

  it('update returns error when workflow not found', async () => {
    const ctx = createBaseCtx();
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'Updated',
        scopeOrigin: 'https://example.com',
        script: 'return 2;',
        workflowId: 'nonexistent',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      error:
        'Workflow not found — the workflowId does not match any saved workflow. Use search_workflows to find it, or omit workflowId to create a new workflow.',
      ok: false,
    });
  });

  it('treats a blank workflowId as a create, not a failed update', async () => {
    const ctx = createBaseCtx();
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'Created',
        scopeOrigin: 'https://example.com',
        script: 'return 2;',
        workflowId: '',
      }),
      ctx
    );
    expect(result.ok).toBe(true);
  });

  it('rejects invalid scopeOrigin', async () => {
    const ctx = createBaseCtx();
    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'not-a-valid-origin',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it('rejects empty script', async () => {
    const ctx = createBaseCtx();
    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: '',
      }),
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it('rejects startUrl outside pathPrefix', async () => {
    const ctx = createBaseCtx();
    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        pathPrefix: '/products',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
        startUrl: 'https://example.com/about',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      error: 'startUrl must match the workflow scope (origin and pathPrefix, if set).',
      ok: false,
    });
  });

  it('rejects startUrl with spoofed origin prefix', async () => {
    const ctx = createBaseCtx();
    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
        startUrl: 'https://example.com.evil.tld',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      error: 'startUrl must match the workflow scope (origin and pathPrefix, if set).',
      ok: false,
    });
  });

  it('rejects startUrl that is not a valid URL', async () => {
    const ctx = createBaseCtx();
    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
        startUrl: 'not-a-valid-url',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      error: `startUrl must be an absolute URL inside the scope, e.g. "https://example.com/path", or a path starting with "/". Received: not-a-valid-url`,
      ok: false,
    });
  });

  it('update draft carries empty-string sentinel for cleared pathPrefix/startUrl', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ savedId: 'wf-1', status: 'approved' });
    const ctx = createBaseCtx({ requestApproval });
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        createdAt: 100,
        description: 'desc',
        id: 'wf-1',
        name: 'Existing',
        pathPrefix: '/old-prefix',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
        startUrl: 'https://example.com/old-start',
        updatedAt: 200,
      },
    ]);

    await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'Updated',
        scopeOrigin: 'https://example.com',
        script: 'return 2;',
        workflowId: 'wf-1',
      }),
      ctx
    );

    const draftArg = (requestApproval as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(draftArg).toBeDefined();
    // Empty string is the clear sentinel — survives JSON, never null in the card.
    expect(Object.hasOwn(draftArg, 'pathPrefix')).toBe(true);
    expect(draftArg['pathPrefix']).toBe('');
    expect(Object.hasOwn(draftArg, 'startUrl')).toBe(true);
    expect(draftArg['startUrl']).toBe('');
  });

  it('create draft omits undefined pathPrefix/startUrl', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ savedId: 'new-wf', status: 'approved' });
    const ctx = createBaseCtx({ requestApproval });

    await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );

    const draftArg = (requestApproval as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(draftArg).toBeDefined();
    expect(Object.hasOwn(draftArg, 'pathPrefix')).toBe(false);
    expect(Object.hasOwn(draftArg, 'startUrl')).toBe(false);
  });

  it('approved save reports the start-the-run nextStep when the runs toggle is on', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({
        autoApproved: false,
        savedId: 'new-wf-id',
        status: 'approved',
      }),
    });
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowWorkflowsInSafeMode: false,
      autoApproveWorkflowChanges: false,
      autoApproveWorkflowRuns: true,
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: {
        autoApproved: false,
        nextStep:
          'Auto-approve workflow runs is on. Verify with run_workflow dryRun: true when the script clicks or fills, then start the real run yourself with run_workflow.',
        saved: true,
        workflowId: 'new-wf-id',
      },
    });
  });

  it('approved save reports the ask-the-user nextStep when the runs toggle is off', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({
        autoApproved: false,
        savedId: 'new-wf-id',
        status: 'approved',
      }),
    });
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowWorkflowsInSafeMode: false,
      autoApproveWorkflowChanges: false,
      autoApproveWorkflowRuns: false,
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: {
        autoApproved: false,
        nextStep:
          'Verify with run_workflow dryRun: true, then ask the user to start the first real run from Workflows in settings.',
        saved: true,
        workflowId: 'new-wf-id',
      },
    });
  });

  it('reports the runs toggle at the completed save, not when the card opened', async () => {
    // The setting starts ON when the card opens.
    // The user flips it OFF while the approval is pending.
    // The nextStep must report the OFF state, never the stale ON.
    const { requestApproval, settle } = deferredApproval();
    const ctx = createBaseCtx({ requestApproval });
    const settingsValue: Record<string, unknown> = {
      allowWorkflowsInSafeMode: false,
      autoApproveWorkflowChanges: false,
      autoApproveWorkflowRuns: true,
    };
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue(settingsValue);

    const resultPromise = executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );

    // Wait for the approval request to be in flight before changing the setting.
    await vi.waitFor(() => {
      if (requestApproval.mock.calls.length === 0) {
        throw new Error('approval not requested yet');
      }
    });

    // Flip the toggle while the approval card is pending, then approve.
    settingsValue['autoApproveWorkflowRuns'] = false;
    settle({ autoApproved: false, savedId: 'new-wf-id', status: 'approved' });

    const result = await resultPromise;
    expect(result).toStrictEqual({
      ok: true,
      value: {
        autoApproved: false,
        nextStep:
          'Verify with run_workflow dryRun: true, then ask the user to start the first real run from Workflows in settings.',
        saved: true,
        workflowId: 'new-wf-id',
      },
    });
  });

  it('reports a run toggle flipped on while approval is pending', async () => {
    // The setting starts OFF when the card opens.
    // The user flips it ON while the approval is pending.
    // The completed save reports the ON state.
    const { requestApproval, settle } = deferredApproval();
    const ctx = createBaseCtx({ requestApproval });
    const settingsValue: Record<string, unknown> = {
      allowWorkflowsInSafeMode: false,
      autoApproveWorkflowChanges: false,
      autoApproveWorkflowRuns: false,
    };
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue(settingsValue);

    const resultPromise = executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );

    // Wait for the approval request to be in flight before changing the setting.
    await vi.waitFor(() => {
      if (requestApproval.mock.calls.length === 0) {
        throw new Error('approval not requested yet');
      }
    });

    settingsValue['autoApproveWorkflowRuns'] = true;
    settle({ autoApproved: false, savedId: 'new-wf-id', status: 'approved' });

    const result = await resultPromise;
    expect(result).toStrictEqual({
      ok: true,
      value: {
        autoApproved: false,
        nextStep:
          'Auto-approve workflow runs is on. Verify with run_workflow dryRun: true when the script clicks or fills, then start the real run yourself with run_workflow.',
        saved: true,
        workflowId: 'new-wf-id',
      },
    });
  });

  it('approved save falls back to the cautious nextStep when the settings read fails', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({
        autoApproved: false,
        savedId: 'new-wf-id',
        status: 'approved',
      }),
      storage: {
        getItem: vi.fn().mockImplementation((key: string) => {
          if (key === WORKFLOW_SETTINGS_STORAGE_KEY) {
            return Promise.reject(new Error('settings read failed'));
          }
          return Promise.resolve([]);
        }),
        removeItem: vi.fn().mockResolvedValue(undefined),
        setItem: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: {
        autoApproved: false,
        nextStep:
          'Verify with run_workflow dryRun: true, then ask the user to start the first real run from Workflows in settings.',
        saved: true,
        workflowId: 'new-wf-id',
      },
    });
  });

  it('reaches the real approval card and completes the save when the settings read fails', async () => {
    // Wire the real requestApproval. When the settings read fails inside it,
    // The save must fall back to the approval card instead of failing.
    const controller = new AbortController();
    const values = new Map<string, unknown>([[AGENT_WORKFLOWS_STORAGE_KEY, []]]);
    const storage = {
      getItem: (key: string): Promise<unknown> => {
        if (key === WORKFLOW_SETTINGS_STORAGE_KEY) {
          return Promise.reject(new Error('settings read failed'));
        }
        return Promise.resolve(values.get(key));
      },
      removeItem: (key: string): Promise<void> => {
        values.delete(key);
        return Promise.resolve(undefined);
      },
      setItem: (key: string, value: unknown): Promise<void> => {
        values.set(key, value);
        return Promise.resolve(undefined);
      },
    };

    const ctx = createBaseCtx({
      requestApproval: (kind, draft) =>
        realRequestApproval(storage, kind, draft, controller.signal),
      storage,
    });

    const resultPromise = executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );

    // Wait for the real requestApproval to persist the draft and show the card.
    const atomStore = getDefaultStore();
    await vi.waitFor(() => {
      if (atomStore.get(pendingApprovalAtom) === undefined) {
        throw new Error('approval card not shown yet');
      }
    });

    const entry = atomStore.get(pendingApprovalAtom);
    if (entry === undefined) {
      throw new Error('expected an approval card entry');
    }
    expect({
      draftPersisted: values.has(PENDING_WORKFLOW_SAVE_STORAGE_KEY),
      kind: entry.kind,
    }).toStrictEqual({ draftPersisted: true, kind: 'workflow' });

    // Approve on the card through the same path the card uses.
    const outcome = await applyApprovalDecision(storage, 'workflow', entry.draft, true);
    if (outcome.status !== 'approved') {
      throw new Error('expected an approved outcome');
    }
    entry.settle(outcome);

    const result = await resultPromise;
    expect(result).toStrictEqual({
      ok: true,
      value: {
        autoApproved: false,
        nextStep:
          'Verify with run_workflow dryRun: true, then ask the user to start the first real run from Workflows in settings.',
        saved: true,
        workflowId: outcome.savedId,
      },
    });

    // The workflow is stored, the draft cleared, and the lock released.
    const workflows = values.get(AGENT_WORKFLOWS_STORAGE_KEY) as Record<string, unknown>[];
    expect({
      count: workflows.length,
      draftCleared: !values.has(PENDING_WORKFLOW_SAVE_STORAGE_KEY),
    }).toStrictEqual({ count: 1, draftCleared: true });
    expect({
      atom: atomStore.get(pendingApprovalAtom),
      lock: atomStore.get(pendingLockAtom),
    }).toStrictEqual({ atom: undefined, lock: false });
  });

  it('approved save reports autoApproved true when the outcome was auto-approved', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({
        autoApproved: true,
        savedId: 'new-wf-id',
        status: 'approved',
      }),
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'desc',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
      }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: {
        autoApproved: true,
        nextStep:
          'Verify with run_workflow dryRun: true, then ask the user to start the first real run from Workflows in settings.',
        saved: true,
        workflowId: 'new-wf-id',
      },
    });
  });
});

// ---------- run_workflow ----------

describe('run_workflow', () => {
  it('refuses to run in safe mode with toggle off', async () => {
    const ctx = createBaseCtx({ allowWorkflowsInSafeMode: false, mode: 'safe' });
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        approvedScriptHash: 'hash',
        createdAt: 100,
        description: 'desc',
        id: 'wf-1',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return { done: true, result: 1 };',
        updatedAt: 200,
      },
    ]);

    const result = await executeWorkflowToolCall(
      createToolCall('run_workflow', { workflowId: 'wf-1' }),
      ctx
    );
    expect(result).toStrictEqual({
      error:
        'Workflow runs are disabled in safe mode. Ask the user to enable "Allow workflows in safe mode" in settings, or to switch this conversation to dangerous mode.',
      ok: false,
    });
  });

  it('runs in dangerous mode when workflow is found', async () => {
    const mockedRunWorkflow = runWorkflow as ReturnType<typeof vi.fn>;
    mockedRunWorkflow.mockResolvedValue({ ok: true, pagesVisited: 1, result: 'success' });

    const ctx = createBaseCtx({ mode: 'dangerous' });
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        approvedScriptHash: 'hash',
        createdAt: 100,
        description: 'desc',
        id: 'wf-1',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return { done: true, result: 1 };',
        updatedAt: 200,
      },
    ]);

    const result = await executeWorkflowToolCall(
      createToolCall('run_workflow', { workflowId: 'wf-1' }),
      ctx
    );

    expect(result.ok).toBe(true);
    expect(mockedRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        evalInTab: ctx.evalInTab,
        getTabUrl: ctx.getTabUrl,
        navigateTab: ctx.navigateTab,
      }),
      expect.objectContaining({
        dryRun: false,
        signal: ctx.signal,
        tabId: ctx.selectedTabId,
        workflow: expect.objectContaining({ id: 'wf-1' }),
      })
    );
  });

  it('rejects a non-object input with the declared params in the error', async () => {
    const mockedRunWorkflow = runWorkflow as ReturnType<typeof vi.fn>;
    mockedRunWorkflow.mockClear();

    const ctx = createBaseCtx({ mode: 'dangerous' });
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        approvedScriptHash: 'hash',
        createdAt: 100,
        description: 'desc',
        id: 'wf-1',
        name: 'My WF',
        params: [{ description: 'search topic', name: 'topic' }],
        scopeOrigin: 'https://example.com',
        script: 'return { done: true, result: 1 };',
        updatedAt: 200,
      },
    ]);

    const result = await executeWorkflowToolCall(
      createToolCall('run_workflow', { input: '', workflowId: 'wf-1' }),
      ctx
    );

    const error = result.ok ? '' : result.error;
    expect(result.ok).toBe(false);
    expect(error).toContain('must be a JSON object');
    expect(error).toContain('{"topic": "<value>"}');
    expect(error).toContain('Declared params: topic');
    expect(mockedRunWorkflow).not.toHaveBeenCalled();
  });

  it('passes input to runWorkflow', async () => {
    const mockedRunWorkflow = runWorkflow as ReturnType<typeof vi.fn>;
    mockedRunWorkflow.mockResolvedValue({ ok: true, pagesVisited: 1, result: 'success' });

    const ctx = createBaseCtx({ mode: 'dangerous' });
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        approvedScriptHash: 'hash',
        createdAt: 100,
        description: 'desc',
        id: 'wf-1',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return { done: true, result: 1 };',
        updatedAt: 200,
      },
    ]);

    const input = { filter: 'active', page: 1 };
    await executeWorkflowToolCall(
      createToolCall('run_workflow', { input, workflowId: 'wf-1' }),
      ctx
    );

    expect(mockedRunWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ input })
    );
  });

  it('returns error when workflow not found', async () => {
    const ctx = createBaseCtx();
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await executeWorkflowToolCall(
      createToolCall('run_workflow', { workflowId: 'nonexistent' }),
      ctx
    );
    expect(result).toStrictEqual({
      error: 'Workflow not found. Use search_workflows to list saved workflows and their ids.',
      ok: false,
    });
  });
});

// ---------- delete_workflow ----------

describe('delete_workflow', () => {
  it('deletes in dangerous mode and names the workflow', async () => {
    const setItem = vi.fn().mockResolvedValue(undefined);
    const ctx = createBaseCtx({
      storage: {
        getItem: vi.fn().mockResolvedValue([
          {
            createdAt: 100,
            description: 'desc',
            id: 'wf-1',
            name: 'My WF',
            scopeOrigin: 'https://example.com',
            script: 'return 1;',
            updatedAt: 200,
          },
        ]),
        removeItem: vi.fn().mockResolvedValue(undefined),
        setItem,
      },
    });

    const result = await executeWorkflowToolCall(
      createToolCall('delete_workflow', { workflowId: 'wf-1' }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: { deleted: true, name: 'My WF', workflowId: 'wf-1' },
    });
    // The store no longer holds the workflow.
    expect(setItem).toHaveBeenCalledWith('local:kiloAgentWorkflows', []);
  });

  it('returns the actionable error for a missing workflow and deletes nothing', async () => {
    const setItem = vi.fn().mockResolvedValue(undefined);
    const ctx = createBaseCtx({
      storage: {
        getItem: vi.fn().mockResolvedValue([]),
        removeItem: vi.fn().mockResolvedValue(undefined),
        setItem,
      },
    });

    const result = await executeWorkflowToolCall(
      createToolCall('delete_workflow', { workflowId: 'nonexistent' }),
      ctx
    );
    expect(result).toStrictEqual({
      error: 'Workflow not found. Use search_workflows to list saved workflows and their ids.',
      ok: false,
    });
    expect(setItem).not.toHaveBeenCalled();
  });

  it('refuses to delete in safe mode without toggle', async () => {
    const ctx = createBaseCtx({ allowWorkflowsInSafeMode: false, mode: 'safe' });

    const result = await executeWorkflowToolCall(
      createToolCall('delete_workflow', { workflowId: 'wf-1' }),
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it('refuses to delete in safe mode even with toggle enabled', async () => {
    const ctx = createBaseCtx({
      allowWorkflowsInSafeMode: true,
      mode: 'safe',
    });
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        createdAt: 100,
        description: 'desc',
        id: 'wf-1',
        name: 'My WF',
        scopeOrigin: 'https://example.com',
        script: 'return 1;',
        updatedAt: 200,
      },
    ]);

    const result = await executeWorkflowToolCall(
      createToolCall('delete_workflow', { workflowId: 'wf-1' }),
      ctx
    );
    expect(result.ok).toBe(false);
  });
});

// ---------- save_memory ----------

describe('save_memory', () => {
  it('approved outcome returns saved:true with memoryId', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({ savedId: 'mem-1', status: 'approved' }),
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_memory', { text: 'Remember this' }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: { memoryId: 'mem-1', saved: true },
    });
  });

  it('rejected outcome returns saved:false with reason', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({ status: 'rejected' }),
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_memory', { text: 'Remember this' }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: { reason: 'The user rejected the save.', saved: false },
    });
  });

  it('aborted outcome returns error', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({ status: 'aborted' }),
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_memory', { text: 'Remember this' }),
      ctx
    );
    expect(result).toStrictEqual({
      error: 'Run stopped before approval.',
      ok: false,
    });
  });

  it('failed outcome with store-full reason returns saved:false', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi
        .fn()
        .mockResolvedValue({ reason: 'Memory store is full.', status: 'failed' }),
    });

    const result = await executeWorkflowToolCall(
      createToolCall('save_memory', { text: 'Remember this' }),
      ctx
    );
    expect(result).toStrictEqual({
      ok: true,
      value: { reason: 'Memory store is full.', saved: false },
    });
  });

  it('returns error for empty text', async () => {
    const ctx = createBaseCtx();
    const result = await executeWorkflowToolCall(
      createToolCall('save_memory', { text: '   ' }),
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it('passes note to the draft', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ savedId: 'mem-note', status: 'approved' });
    const ctx = createBaseCtx({ requestApproval });

    const result = await executeWorkflowToolCall(
      createToolCall('save_memory', { note: 'my note', text: 'text' }),
      ctx
    );
    expect(result.ok).toBe(true);
    expect(requestApproval).toHaveBeenCalledWith(
      'memory',
      expect.objectContaining({ note: 'my note' })
    );
  });
});

// ---------- workflow params ----------

describe('workflow params through tools', () => {
  it('rejects save_workflow with duplicate param names', async () => {
    const ctx = createBaseCtx();
    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'Test',
        name: 'Test',
        params: [
          { description: 'One', name: 'city' },
          { description: 'Two', name: 'city' },
        ],
        scopeOrigin: 'https://example.com',
        script: 'return { done: true, result: 1 };',
      }),
      ctx
    );

    expect(result).toStrictEqual({ error: 'params must not contain duplicate names.', ok: false });
  });

  it('carries params into the approval draft on create', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ savedId: 'id-1', status: 'approved' });
    const ctx = createBaseCtx({ requestApproval });

    await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'Test',
        name: 'Test',
        params: [{ description: 'City', example: 'SFO', name: 'destination', required: true }],
        scopeOrigin: 'https://example.com',
        script: 'return { done: true, result: 1 };',
      }),
      ctx
    );

    expect(requestApproval).toHaveBeenCalledWith(
      'workflow',
      expect.objectContaining({
        params: [{ description: 'City', example: 'SFO', name: 'destination', required: true }],
      })
    );
  });

  it('uses the empty params array as the cleared sentinel on update', async () => {
    const requestApproval = vi.fn().mockResolvedValue({ savedId: 'wf-1', status: 'approved' });
    const stored = {
      approvedScriptHash: 'hash',
      createdAt: 1,
      description: 'Old',
      id: 'wf-1',
      name: 'Old',
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 1 };',
      updatedAt: 1,
    };
    const ctx = createBaseCtx({
      requestApproval,
      storage: {
        getItem: vi.fn().mockResolvedValue([stored]),
        removeItem: vi.fn().mockResolvedValue(undefined),
        setItem: vi.fn().mockResolvedValue(undefined),
      },
    });

    await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'New',
        name: 'New',
        scopeOrigin: 'https://example.com',
        script: 'return { done: true, result: 2 };',
        workflowId: 'wf-1',
      }),
      ctx
    );

    expect(requestApproval).toHaveBeenCalledWith(
      'workflow',
      expect.objectContaining({ params: [], workflowId: 'wf-1' })
    );
  });

  it('returns params in search_workflows results', async () => {
    const stored = {
      approvedScriptHash: 'hash',
      createdAt: 1,
      description: 'Flights',
      id: 'wf-1',
      name: 'Flights',
      params: [{ description: 'City', name: 'destination', required: true }],
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 1 };',
      updatedAt: 1,
    };
    const ctx = createBaseCtx({
      storage: {
        getItem: vi.fn().mockResolvedValue([stored]),
        removeItem: vi.fn().mockResolvedValue(undefined),
        setItem: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await executeWorkflowToolCall(createToolCall('search_workflows', {}), ctx);

    expect(result).toStrictEqual({
      ok: true,
      value: {
        results: [
          expect.objectContaining({
            params: [{ description: 'City', name: 'destination', required: true }],
          }),
        ],
      },
    });
  });
});

describe('startUrl resolution', () => {
  it('resolves a path startUrl against the scope origin', () => {
    expect(resolveWorkflowStartUrl('/', 'https://example.com')).toBe('https://example.com/');
    expect(resolveWorkflowStartUrl('/travel/flights', 'https://example.com')).toBe(
      'https://example.com/travel/flights'
    );
  });

  it('leaves absolute and unresolvable values untouched', () => {
    expect(resolveWorkflowStartUrl('https://example.com/x', 'https://example.com')).toBe(
      'https://example.com/x'
    );
    expect(resolveWorkflowStartUrl('travel', 'https://example.com')).toBe('travel');
    expect(resolveWorkflowStartUrl(undefined, 'https://example.com')).toBeUndefined();
  });

  it('accepts a path startUrl in save_workflow and stores it absolute', async () => {
    const requestApproval = vi
      .fn()
      .mockResolvedValue({ autoApproved: false, savedId: 'id-1', status: 'approved' });
    const ctx = createBaseCtx({ requestApproval });

    const result = await executeWorkflowToolCall(
      createToolCall('save_workflow', {
        description: 'Test',
        name: 'Test',
        scopeOrigin: 'https://example.com',
        script: 'return { done: true, result: 1 };',
        startUrl: '/search',
      }),
      ctx
    );

    expect(result).toStrictEqual({
      ok: true,
      value: {
        autoApproved: false,
        nextStep:
          'Verify with run_workflow dryRun: true, then ask the user to start the first real run from Workflows in settings.',
        saved: true,
        workflowId: 'id-1',
      },
    });
    expect(requestApproval).toHaveBeenCalledWith(
      'workflow',
      expect.objectContaining({ startUrl: 'https://example.com/search' })
    );
  });
});

describe('run results name the workflow', () => {
  const stored = {
    approvedScriptHash: 'hash',
    createdAt: 1,
    description: 'Flights',
    id: 'wf-1',
    name: 'Flight price search',
    scopeOrigin: 'https://example.com',
    script: 'return { done: true, result: 1 };',
    updatedAt: 1,
  };

  const ctxWithStored = () =>
    createBaseCtx({
      storage: {
        getItem: vi.fn().mockResolvedValue([stored]),
        removeItem: vi.fn().mockResolvedValue(undefined),
        setItem: vi.fn().mockResolvedValue(undefined),
      },
    });

  it('includes the workflow name in a successful result', async () => {
    vi.mocked(runWorkflow).mockResolvedValueOnce({ ok: true, pagesVisited: 1, result: 'done' });

    const result = await executeWorkflowToolCall(
      createToolCall('run_workflow', { workflowId: 'wf-1' }),
      ctxWithStored()
    );

    expect(result).toStrictEqual({
      ok: true,
      value: { pagesVisited: 1, result: 'done', workflowName: 'Flight price search' },
    });
  });

  it('names the workflow in a failure', async () => {
    vi.mocked(runWorkflow).mockResolvedValueOnce({ error: 'Tab is at X.', ok: false });

    const result = await executeWorkflowToolCall(
      createToolCall('run_workflow', { workflowId: 'wf-1' }),
      ctxWithStored()
    );

    expect(result).toStrictEqual({
      error: 'Workflow "Flight price search" failed: Tab is at X.',
      ok: false,
    });
  });
});

describe('empty search messages', () => {
  it('tells the model to create one when nothing is saved', () => {
    expect(formatEmptySearchMessage(0, undefined)).toBe(
      'No workflows saved yet. Use save_workflow to create one.'
    );
    expect(formatEmptySearchMessage(0, 'flights')).toBe(
      'No workflows saved yet. Use save_workflow to create one.'
    );
  });

  it('never suggests searching with a query when a query already missed', () => {
    const message = formatEmptySearchMessage(3, 'flights');
    expect(message).toContain('No saved workflow matches "flights"');
    expect(message).toContain('already covered every site');
    expect(message).not.toContain('with a query to find them');
  });

  it('suggests a query search only when no query was given', () => {
    expect(formatEmptySearchMessage(3, undefined)).toBe(
      'No workflows for this site. 3 workflow(s) are saved for other sites — call search_workflows with a query to find them.'
    );
  });

  it('treats a blank query as no query', () => {
    expect(formatEmptySearchMessage(2, '   ')).toContain('call search_workflows with a query');
  });
});
