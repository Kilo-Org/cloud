/* eslint-disable max-lines, consistent-type-imports, no-unsafe-type-assertion, no-unsafe-assignment, no-useless-undefined, jest/no-untyped-mock-factory, prefer-destructuring, import/first -- test mock factories and fixture coverage */
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowToolCallEvent } from '@/src/shared/agent-conversation';
import type { WorkflowToolContext } from './agent-workflow-tool-runtime';
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';

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

// ---------- search_workflows ----------

describe('search_workflows', () => {
  it('returns empty message when no workflows match', async () => {
    const ctx = createBaseCtx();
    (ctx.storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await executeWorkflowToolCall(createToolCall('search_workflows'), ctx);
    expect(result).toStrictEqual({
      ok: true,
      value: { message: 'No workflows for this site.', results: [] },
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
  it('approved outcome returns saved:true with workflowId', async () => {
    const ctx = createBaseCtx({
      requestApproval: vi.fn().mockResolvedValue({ savedId: 'new-wf-id', status: 'approved' }),
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
      value: { saved: true, workflowId: 'new-wf-id' },
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
      error: 'Workflow not found.',
      ok: false,
    });
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
      error: 'startUrl is not a valid URL.',
      ok: false,
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
      error: 'Workflows are disabled in safe mode. The user can enable them in settings.',
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
    expect(result).toStrictEqual({ error: 'Workflow not found.', ok: false });
  });
});

// ---------- delete_workflow ----------

describe('delete_workflow', () => {
  it('deletes in dangerous mode', async () => {
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
      createToolCall('delete_workflow', { workflowId: 'wf-1' }),
      ctx
    );
    expect(result).toStrictEqual({ ok: true, value: { deleted: true } });
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
