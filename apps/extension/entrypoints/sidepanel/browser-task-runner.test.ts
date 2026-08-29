/* eslint-disable max-lines, import/max-dependencies, import/first, import/no-nodejs-modules, jest/no-hooks, jest/no-untyped-mock-factory, jest/no-conditional-in-test, jest/max-expects, vitest/prefer-import-in-mock, require-await, typescript/require-await, typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion, unicorn/no-await-expression-member -- Shared-runner scenarios check requests, confirmed results, and absence of later actions together. */
import { locks as nativeLocks } from 'node:worker_threads';
import { getDefaultStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserJobSnapshot } from '@kilocode/cloud-agent-sdk/schemas';
import type { BrowserApprovalSettings } from '@/src/shared/browser-provider-settings';
import type { LlmTurnOutcome } from '@/src/shared/agent-llm-turn-runner-core';
import type { ToolResultEvent } from '@/src/shared/agent-tool-results';
import type { RemoteMcpServer } from '@/src/shared/remote-mcp';
import { loadRemoteMcpStore, REMOTE_MCP_STORAGE_KEY } from '@/src/shared/remote-mcp-storage';

const fixture = vi.hoisted(() => ({
  actions: [] as number[],
  dispatch: async (_request: { type: string; tabId?: number }): Promise<unknown> => {
    throw new Error('Set the browser result.');
  },
  removed: new Set<(id: number) => void>(),
  tabs: [
    { id: 7, title: 'Approved page', url: 'https://example.test/task' },
    { id: 8, title: 'Other page', url: 'https://other.test/' },
  ],
  values: new Map<string, unknown>(),
}));
vi.mock('#imports', () => ({
  browser: {
    identity: {
      getRedirectURL: () => 'https://extension.example.test/remote-mcp',
    },
    runtime: {
      sendMessage: (request: { type: string; tabId?: number }) => fixture.dispatch(request),
    },
    tabs: {
      get: async (id: number) => {
        const tab = fixture.tabs.find(item => item.id === id);
        if (tab === undefined) {
          throw new Error('Tab closed');
        }
        return tab;
      },
      onRemoved: {
        addListener: (fn: (id: number) => void) => fixture.removed.add(fn),
        removeListener: (fn: (id: number) => void) => fixture.removed.delete(fn),
      },
      query: async () => structuredClone(fixture.tabs),
    },
  },
  storage: {
    getItem: (key: string) => structuredClone(fixture.values.get(key)),
    removeItem: (key: string) => {
      fixture.values.delete(key);
    },
    setItem: (key: string, value: unknown) => {
      fixture.values.set(key, structuredClone(value));
    },
    watch: () => () => {},
  },
}));
import { storage } from '#imports';
import {
  createAssistantMessage,
  createSafeToolCall,
  createToolResult,
  createUserMessage,
} from '@/src/shared/agent-conversation';
import { ExecutionStoppedError } from '@/src/shared/agent-tool-results';
import { PAGE_SNAPSHOT_MESSAGE, WEB_MCP_DISCOVER_MESSAGE } from '@/src/shared/tab-debugger';
import {
  createBrowserExecutionCoordinator,
  BROWSER_EXECUTION_SAFETY_KEY,
} from './browser-execution-lock';
import type { BrowserExecutionLease } from './browser-execution-lock';
import { pendingApprovalAtom, pendingLockAtom } from './pending-approval';
import {
  readBrowserTaskSettings,
  runBrowserTask,
  toBrowserTaskResult,
} from './browser-task-runner';

const leases: BrowserExecutionLease[] = [];
const settings = (): BrowserApprovalSettings => ({
  memorySettings: { autoApproveMemorySaves: false },
  mode: 'safe',
  model: 'explicit-model',
  organizationId: 'org-selected',
  remoteMcpServers: [],
  thinkingEffort: 'high',
  webMcpSettings: { allowWebMcpInSafeMode: false },
  workflowSettings: {
    allowWorkflowsInSafeMode: false,
    autoApproveWorkflowChanges: false,
    autoApproveWorkflowRuns: false,
  },
});
const job = (): BrowserJobSnapshot => {
  const now = Date.now();
  return {
    approvedTab: {
      effectiveMode: 'safe',
      tabId: 7,
      title: 'Approved page',
      url: 'https://example.test/task?token=private#fragment',
    },
    browserTaskId: `bt_${crypto.randomUUID()}`,
    createdAt: new Date(now).toISOString(),
    deadlines: {
      execution: new Date(now + 600_000).toISOString(),
      queue: new Date(now + 600_000).toISOString(),
    },
    expiresAt: new Date(now + 604_800_000).toISOString(),
    generation: 1,
    invocationId: `b1.${now}.${'a'.repeat(64)}`,
    jobId: `bj_${crypto.randomUUID()}`,
    payloadFingerprint: 'b'.repeat(64),
    providerId: `bp_${crypto.randomUUID()}`,
    status: 'running',
  };
};
const completion = (
  delta: { content?: string; tool_calls?: unknown[] },
  finish = 'stop'
): Response =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish, index: 0 }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
const tool = (name: string, args = '{}', index = 0) => ({
  function: { arguments: args, name },
  id: `call_${index}`,
  index,
  type: 'function',
});
const page = () => ({
  nodes: [],
  text: 'The page says Ready.',
  title: 'Observed title',
  url: 'https://user:secret@example.test/task?token=private#fragment',
});
const setup = async (
  responses: Response[] = [completion({ content: 'The requested answer.' })]
) => {
  const coordinator = createBrowserExecutionCoordinator({
    locks: nativeLocks as LockManager,
    storageArea: storage,
  });
  const provider = await coordinator.acquireProviderOwner();
  if (!provider.admitted) {
    throw new Error(provider.reason);
  }
  leases.push(provider.lease);
  const abort = new AbortController();
  const admitted = await coordinator.acquireDelegated(provider.lease, 'ses_parent_a', abort.signal);
  if (!admitted.admitted) {
    throw new Error(admitted.reason);
  }
  leases.push(admitted.lease);
  const requests: { body: string; headers: Headers }[] = [];
  const input = {
    abort,
    apiBaseUrl: 'https://gateway.example.test',
    events: [createUserMessage('Read this page only.')],
    executionGuard: () => {},
    fetch: async (_url: string, init?: RequestInit) => {
      if (typeof init?.body !== 'string') {
        throw new TypeError('Expected a serialized model request.');
      }
      requests.push({ body: init.body, headers: new Headers(init.headers) });
      const response = responses.shift();
      if (response === undefined) {
        throw new Error('Unexpected model request');
      }
      return response;
    },
    job: job(),
    lease: admitted.lease,
    remoteFetch: globalThis.fetch,
    settings: settings(),
    storage,
    supportsImages: true,
    token: 'test-token',
  };
  return { coordinator, input, requests };
};

const setupRemoteOAuth = async (responses: Response[]) => {
  const context = await setup(responses);
  const server = {
    allowInSafeMode: true,
    auth: {
      oauth: {
        clientInformation: { client_id: 'test-approved-client' },
        tokens: {
          access_token: 'test-approved-account',
          refresh_token: 'test-approved-refresh',
          scope: 'read',
          token_type: 'Bearer',
        },
      },
      type: 'oauth',
    },
    cachedTools: [{ inputSchema: { properties: {}, type: 'object' }, name: 'read' }],
    displayName: 'Approved remote',
    enabled: true,
    id: 'remote',
    slug: 'remote',
    status: 'connected',
    url: 'https://mcp.example.test/',
  } satisfies RemoteMcpServer;
  fixture.values.set(REMOTE_MCP_STORAGE_KEY, { servers: [server] });
  context.input.settings = await readBrowserTaskSettings(
    { enabled: true, mode: 'safe', model: 'explicit-model', thinkingEffort: 'high' },
    'org-selected',
    storage
  );
  const calls: { authorization: string | null; name: string }[] = [];
  context.input.remoteFetch = async (_url, init) => {
    if (init?.method === 'GET') {
      return new Response(null, { status: 405 });
    }
    if (typeof init?.body !== 'string') {
      throw new TypeError('Expected a serialized MCP request.');
    }
    const request = JSON.parse(init.body) as {
      id: number;
      method: string;
      params: { name: string; protocolVersion: string };
    };
    if (request.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    if (request.method === 'initialize') {
      return Response.json({
        id: request.id,
        jsonrpc: '2.0',
        result: {
          capabilities: { tools: {} },
          protocolVersion: request.params.protocolVersion,
          serverInfo: { name: 'Test MCP server', version: '1.0.0' },
        },
      });
    }
    if (request.method === 'tools/call') {
      calls.push({
        authorization: new Headers(init.headers).get('Authorization'),
        name: request.params.name,
      });
      return Response.json({
        id: request.id,
        jsonrpc: '2.0',
        result: { content: [{ text: 'The approved remote answer.', type: 'text' }] },
      });
    }
    throw new Error('Unexpected MCP request.');
  };
  return { ...context, calls, server };
};

describe('delegated browser runner adapter', () => {
  beforeEach(() => {
    fixture.actions = [];
    fixture.values.clear();
    fixture.tabs = [
      { id: 7, title: 'Approved page', url: 'https://example.test/task' },
      { id: 8, title: 'Other page', url: 'https://other.test/' },
    ];
    fixture.dispatch = async request => {
      if (request.type === WEB_MCP_DISCOVER_MESSAGE) {
        return {
          ok: true,
          result: { ok: true, value: { documentId: 'doc', tools: [] } },
          type: request.type,
        };
      }
      if (request.tabId !== undefined) {
        fixture.actions.push(request.tabId);
      }
      return {
        ok: true,
        result: { effectsUncertain: false, ok: true, value: page() },
        type: PAGE_SNAPSHOT_MESSAGE,
      };
    };
    getDefaultStore().set(pendingApprovalAtom, undefined);
    getDefaultStore().set(pendingLockAtom, false);
  });
  afterEach(async () => {
    await Promise.all(leases.splice(0).map(lease => lease.release()));
    vi.useRealTimers();
    fixture.removed.clear();
  });

  it('treats rejected permission as failure and never starts a later tool or model round', async () => {
    const { input, requests } = await setup([
      completion(
        {
          tool_calls: [
            tool('save_memory', '{"text":"Remember this fact"}'),
            tool('get_page_snapshot', '{}', 1),
          ],
        },
        'tool_calls'
      ),
    ]);
    const running = runBrowserTask(input);
    await vi.waitFor(() => {
      expect(getDefaultStore().get(pendingApprovalAtom)?.kind).toBe('memory');
    });
    const approval = getDefaultStore().get(pendingApprovalAtom);
    if (approval === undefined) {
      throw new Error('Missing approval');
    }
    approval.settle({ status: 'rejected' });
    const result = await running;
    expect(result.result).toMatchObject({
      effectsUncertain: false,
      reason: 'permission_denied',
      status: 'failed',
    });
    expect(fixture.actions).toStrictEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('runs the real shared runner on the exact tab with isolated history and confirmed evidence', async () => {
    const { input, requests } = await setup([
      completion({ tool_calls: [tool('get_page_snapshot')] }, 'tool_calls'),
      completion({ content: 'The page says Ready.' }),
    ]);
    input.events.unshift(
      createAssistantMessage('Only this browser conversation is prior context.')
    );
    fixture.values.set('local:kiloAgentConversations', { text: 'Foreign parent transcript' });
    fixture.tabs.reverse();
    const result = await runBrowserTask(input);
    expect(result.result).toMatchObject({
      effectsUncertain: false,
      evidence: [
        { text: 'The page says Ready.', title: 'Observed title', url: 'https://example.test/task' },
      ],
      reason: 'completed',
      status: 'succeeded',
      summary: 'The page says Ready.',
    });
    expect(fixture.actions).toStrictEqual([7]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toContain('explicit-model');
    expect(requests[0]?.body).toContain('Only this browser conversation');
    expect(requests[0]?.body).not.toContain('Foreign parent transcript');
    expect(requests[0]?.body).not.toContain('token=private');
    expect(result.events.some(event => event.type === 'tool-result' && event.ok)).toBe(true);
  });

  it('returns empty evidence rather than turning model claims into observations', async () => {
    const { input } = await setup();
    const completed = await runBrowserTask(input);
    expect(completed.result).toMatchObject({
      evidence: [],
      status: 'succeeded',
      summary: 'The requested answer.',
    });
    expect(fixture.actions).toStrictEqual([]);
  });

  it.each([
    'model_failure',
    'retry_exhausted',
    'context_overflow',
    'rounds_exhausted',
    'truncated_response',
    'empty_response',
    'incomplete_response',
    'tool_failure_limit',
    'unsafe_tool_call',
  ] as const)('never promotes the typed %s outcome to success', reason => {
    const result = toBrowserTaskResult(
      job(),
      {
        effectsUncertain: false,
        reason,
        status: 'failed',
        summary: 'Partial work only.',
        toolResults: [],
      },
      []
    );
    expect(result).toMatchObject({
      evidence: [],
      reason: reason === 'unsafe_tool_call' ? 'permission_denied' : 'runner_failed',
      status: 'failed',
    });
    expect(result.summary).toContain('Work is incomplete');
    expect(result.summary).toContain('Partial work only.');
  });

  it.each([
    ['runner_failed', 'failed'],
    ['unsupported', 'failed'],
    ['invalid_request', 'failed'],
    ['owner_mismatch', 'interrupted'],
    ['not_found', 'interrupted'],
    ['invocation_conflict', 'interrupted'],
    ['conversation_busy', 'interrupted'],
    ['capacity_exceeded', 'interrupted'],
    ['cancelled', 'cancelled'],
    ['tab_lost', 'interrupted'],
    ['provider_lost', 'interrupted'],
    ['provider_unavailable', 'interrupted'],
    ['lease_expired', 'interrupted'],
    ['effects_uncertain', 'interrupted'],
    ['queue_timeout', 'timed_out'],
    ['approval_timeout', 'timed_out'],
    ['execution_timeout', 'timed_out'],
    ['invocation_expired', 'timed_out'],
    ['permission_denied', 'failed'],
    ['approval_denied', 'failed'],
  ] as const)('preserves the %s terminal reason', (reason, status) => {
    const result = toBrowserTaskResult(
      job(),
      {
        effectsUncertain: reason === 'effects_uncertain',
        reason,
        status: 'interrupted',
        summary: '',
        toolResults: [],
      },
      []
    );
    expect(result).toMatchObject({
      effectsUncertain: reason === 'effects_uncertain',
      reason,
      status,
    });
    expect(result.summary).toContain('Issued actions cannot be undone');
  });

  it('bounds multibyte evidence and excludes screenshots, failed results, and unconfirmed observations', () => {
    const call = createSafeToolCall({ name: 'get_page_snapshot', tabId: 7 });
    const screenshot = createSafeToolCall({ name: 'get_viewport_screenshot', tabId: 7 });
    const confirmed: ToolResultEvent = {
      ...createToolResult({
        ok: true,
        toolCallId: call.id,
        value: { ...page(), text: '𐀀'.repeat(20_000), title: '𐀀'.repeat(2000) },
      }),
      effectsUncertain: false,
    };
    const outcome: LlmTurnOutcome = {
      effectsUncertain: false,
      reason: 'completed',
      status: 'succeeded',
      summary: '𐀀'.repeat(20_000),
      toolResults: [
        confirmed,
        { ...confirmed, effectsUncertain: true },
        { ...confirmed, ok: false },
        {
          ...confirmed,
          toolCallId: screenshot.id,
          value: { dataUrl: 'data:image/png;base64,secret' },
        },
      ],
    };
    const result = toBrowserTaskResult(job(), outcome, [call, screenshot]);
    expect(result.evidence).toHaveLength(1);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(64 * 1024);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('token=private');
  });

  it('checks the live lease between issued actions without relying on an abort event', async () => {
    const { input, requests } = await setup([
      completion(
        { tool_calls: [tool('get_page_snapshot'), tool('get_page_snapshot', '{}', 1)] },
        'tool_calls'
      ),
    ]);
    let live = true;
    input.executionGuard = () => {
      if (!live) {
        throw new ExecutionStoppedError('lease_expired');
      }
    };
    fixture.dispatch = async request => {
      fixture.actions.push(request.tabId ?? -1);
      live = false;
      return {
        ok: true,
        result: { effectsUncertain: false, ok: true, value: page() },
        type: PAGE_SNAPSHOT_MESSAGE,
      };
    };
    const result = await runBrowserTask(input);
    expect(result.result).toMatchObject({ reason: 'lease_expired', status: 'interrupted' });
    expect(fixture.actions).toStrictEqual([7]);
    expect(requests).toHaveLength(1);
  });

  it('retains bounded recovery for a confirmed retryable tool failure', async () => {
    const { input, requests } = await setup([
      completion({ tool_calls: [tool('get_page_snapshot')] }, 'tool_calls'),
      completion({ tool_calls: [tool('get_page_snapshot')] }, 'tool_calls'),
      completion({ content: 'The page says Ready.' }),
    ]);
    fixture.dispatch = async request => {
      fixture.actions.push(request.tabId ?? -1);
      const result =
        fixture.actions.length === 1
          ? { effectsUncertain: false, error: 'The page is not ready yet.', ok: false }
          : { effectsUncertain: false, ok: true, value: page() };
      return { ok: true, result, type: PAGE_SNAPSHOT_MESSAGE };
    };
    const result = await runBrowserTask(input);
    expect(result.result).toMatchObject({
      effectsUncertain: false,
      evidence: [{ text: 'The page says Ready.' }],
      status: 'succeeded',
    });
    expect(fixture.actions).toStrictEqual([7, 7]);
    expect(requests).toHaveLength(3);
    expect(fixture.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
  });

  it.each(['lease_expired', 'provider_lost'] as const)(
    'checks %s before a model request',
    async reason => {
      const { input, requests } = await setup();
      input.executionGuard = () => {
        throw new ExecutionStoppedError(reason);
      };
      const result = await runBrowserTask(input);
      expect(result.result).toMatchObject({ reason, status: 'interrupted' });
      expect(requests).toStrictEqual([]);
      expect(fixture.actions).toStrictEqual([]);
    }
  );

  it('rejects a missing approved tab without falling back to another tab', async () => {
    const { input, requests } = await setup();
    fixture.tabs = fixture.tabs.filter(tab => tab.id !== 7);
    const result = await runBrowserTask(input);
    expect(result.result).toMatchObject({ reason: 'tab_lost', status: 'interrupted' });
    expect(requests).toStrictEqual([]);
    expect(fixture.actions).toStrictEqual([]);
  });

  it('preserves safe tool restrictions through the real gateway parser', async () => {
    const { input } = await setup([
      completion({ tool_calls: [tool('eval', '{"code":"document.body.click()"}')] }, 'tool_calls'),
    ]);
    const result = await runBrowserTask(input);
    expect(result.result).toMatchObject({
      effectsUncertain: false,
      reason: 'permission_denied',
      status: 'failed',
    });
    expect(fixture.actions).toStrictEqual([]);
  });

  it('reports a non-retryable model failure rather than a resolved successful promise', async () => {
    const { input, requests } = await setup([new Response('Denied', { status: 401 })]);
    const result = await runBrowserTask(input);
    expect(result.result).toMatchObject({
      effectsUncertain: false,
      reason: 'runner_failed',
      status: 'failed',
    });
    expect(requests).toHaveLength(1);
    expect(fixture.actions).toStrictEqual([]);
  });

  it('keeps permission cards despite a later auto-approve increase, and Stop prevents the next tool', async () => {
    const { input, requests } = await setup([
      completion(
        {
          tool_calls: [
            tool('save_memory', '{"text":"Remember this fact"}'),
            tool('get_page_snapshot', '{}', 1),
          ],
        },
        'tool_calls'
      ),
    ]);
    fixture.values.set('local:kiloMemorySettings', { autoApproveMemorySaves: true });
    const running = runBrowserTask(input);
    await vi.waitFor(() => {
      expect(getDefaultStore().get(pendingApprovalAtom)?.kind).toBe('memory');
    });
    expect(getDefaultStore().get(pendingApprovalAtom)?.draft.origin).toMatchObject({
      invocationId: input.job.invocationId,
      kind: 'delegated',
    });
    input.abort.abort(new ExecutionStoppedError('cancelled', 'cancelled'));
    const result = await running;
    expect(result.result.status).toBe('cancelled');
    expect(fixture.actions).toStrictEqual([]);
    expect(requests).toHaveLength(1);
    expect(fixture.values.has('local:kiloAgentMemories')).toBe(false);
    expect(getDefaultStore().get(pendingApprovalAtom)).toBeUndefined();
  });

  it('awaits an issued action after cancellation and never starts the next action', async () => {
    const { input, requests } = await setup([
      completion(
        { tool_calls: [tool('get_page_snapshot'), tool('get_page_snapshot', '{}', 1)] },
        'tool_calls'
      ),
    ]);
    const gate = Promise.withResolvers<void>();
    let finished = false;
    fixture.dispatch = async request => {
      fixture.actions.push(request.tabId ?? -1);
      await gate.promise;
      return {
        ok: true,
        result: { effectsUncertain: false, ok: true, value: page() },
        type: PAGE_SNAPSHOT_MESSAGE,
      };
    };
    const running = (async () => {
      const completed = await runBrowserTask(input);
      finished = true;
      return completed;
    })();
    await vi.waitFor(() => {
      expect(fixture.actions).toStrictEqual([7]);
    });
    input.abort.abort(new ExecutionStoppedError('cancelled', 'cancelled'));
    expect(finished).toBe(false);
    gate.resolve();
    const result = await running;
    expect(result.result).toMatchObject({
      effectsUncertain: false,
      evidence: [{ text: 'The page says Ready.' }],
      status: 'cancelled',
    });
    expect(fixture.actions).toStrictEqual([7]);
    expect(requests).toHaveLength(1);
  });

  it('quarantines an uncertain tool result before another action or model retry', async () => {
    const { coordinator, input, requests } = await setup([
      completion(
        { tool_calls: [tool('get_page_snapshot'), tool('get_page_snapshot', '{}', 1)] },
        'tool_calls'
      ),
    ]);
    fixture.dispatch = async request => {
      fixture.actions.push(request.tabId ?? -1);
      return {
        ok: true,
        result: { effectsUncertain: true, error: 'Soft timeout', ok: false },
        type: PAGE_SNAPSHOT_MESSAGE,
      };
    };
    const result = await runBrowserTask(input);
    expect(result.result).toMatchObject({
      effectsUncertain: true,
      evidence: [],
      reason: 'effects_uncertain',
      status: 'interrupted',
    });
    expect(fixture.actions).toStrictEqual([7]);
    expect(requests).toHaveLength(1);
    await input.lease.release();
    expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
    expect((await coordinator.acquireLocal()).admitted).toBe(false);
  });

  it('uses approved OAuth credentials for later real MCP tool requests without exposing them in history', async () => {
    const { calls, input } = await setupRemoteOAuth([
      completion({ tool_calls: [tool('mcp_remote_read')] }, 'tool_calls'),
      completion({ tool_calls: [tool('mcp_remote_read')] }, 'tool_calls'),
      completion({ content: 'The approved remote answer.' }),
    ]);
    const result = await runBrowserTask(input);
    expect(result.result).toMatchObject({
      effectsUncertain: false,
      status: 'succeeded',
      summary: 'The approved remote answer.',
    });
    expect(calls).toStrictEqual([
      { authorization: 'Bearer test-approved-account', name: 'read' },
      { authorization: 'Bearer test-approved-account', name: 'read' },
    ]);
    expect(JSON.stringify(result)).not.toContain('test-approved-account');
    expect(JSON.stringify(result)).not.toContain('test-approved-refresh');
  });

  it.each(['account', 'scope', 'client'] as const)(
    'stops later actions when OAuth %s changes during a credential read after consent',
    async authority => {
      const { calls, input, requests, server } = await setupRemoteOAuth([
        completion({ tool_calls: [tool('mcp_remote_read')] }, 'tool_calls'),
        completion(
          { tool_calls: [tool('mcp_remote_read'), tool('get_page_snapshot', '{}', 1)] },
          'tool_calls'
        ),
        completion({ content: 'Must not complete with changed authority.' }),
      ]);
      const readStarted = Promise.withResolvers<void>();
      const resumeRead = Promise.withResolvers<void>();
      let paused = false;
      const running = runBrowserTask({
        ...input,
        storage: {
          ...storage,
          getItem: async key => {
            if (key === REMOTE_MCP_STORAGE_KEY && requests.length === 2 && !paused) {
              paused = true;
              readStarted.resolve();
              await resumeRead.promise;
            }
            return structuredClone(fixture.values.get(key));
          },
        },
      });
      await readStarted.promise;
      const changed = structuredClone(server);
      if (authority === 'account') {
        changed.auth.oauth.tokens.access_token = 'test-other-account';
      } else if (authority === 'scope') {
        changed.auth.oauth.tokens.scope = 'read write';
      } else {
        changed.auth.oauth.clientInformation.client_id = 'test-other-client';
      }
      fixture.values.set(REMOTE_MCP_STORAGE_KEY, { servers: [changed] });
      resumeRead.resolve();
      const result = await running;
      expect(result.result).toMatchObject({ reason: 'permission_denied', status: 'failed' });
      expect(calls).toStrictEqual([
        { authorization: 'Bearer test-approved-account', name: 'read' },
      ]);
      expect(fixture.actions).toStrictEqual([]);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('test-other-account');
      expect(JSON.stringify(result)).not.toContain('test-other-client');
    }
  );

  it('preserves live server edits during OAuth refresh and stops before using the new credential', async () => {
    const { calls, input, server } = await setupRemoteOAuth([
      completion({ tool_calls: [tool('mcp_remote_read')] }, 'tool_calls'),
      completion({ content: 'Must not use a refreshed credential without fresh consent.' }),
    ]);
    const dispatch = input.remoteFetch;
    const refreshedTokens = { ...server.auth.oauth.tokens, access_token: 'test-refreshed-account' };
    const unrelated = {
      ...server,
      auth: { type: 'none' },
      enabled: false,
      id: 'unrelated',
      slug: 'unrelated',
      url: 'https://unrelated.example.test/',
    } satisfies RemoteMcpServer;
    const refreshRequests: URLSearchParams[] = [];
    let challenged = false;
    input.remoteFetch = async (url, init) => {
      const address = url instanceof Request ? url.url : url.toString();
      if (address === 'https://mcp.example.test/.well-known/oauth-protected-resource') {
        return Response.json({
          authorization_servers: ['https://auth.example.test/'],
          resource: server.url,
        });
      }
      if (address === 'https://auth.example.test/.well-known/oauth-authorization-server') {
        return Response.json({
          authorization_endpoint: 'https://auth.example.test/authorize',
          issuer: 'https://auth.example.test/',
          response_types_supported: ['code'],
          token_endpoint: 'https://auth.example.test/token',
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (address === 'https://auth.example.test/token') {
        refreshRequests.push(new URLSearchParams(await new Response(init?.body).text()));
        fixture.values.set(REMOTE_MCP_STORAGE_KEY, {
          servers: [{ ...server, displayName: 'Edited during refresh' }, unrelated],
        });
        return Response.json(refreshedTokens);
      }
      if (address === server.url && init?.method === 'POST' && !challenged) {
        challenged = true;
        return new Response(null, {
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
          },
          status: 401,
        });
      }
      return dispatch(url, init);
    };
    const result = await runBrowserTask(input);
    expect(refreshRequests.map(request => Object.fromEntries(request))).toMatchObject([
      {
        client_id: 'test-approved-client',
        grant_type: 'refresh_token',
        refresh_token: 'test-approved-refresh',
      },
    ]);
    await expect(loadRemoteMcpStore(storage)).resolves.toStrictEqual({
      servers: [
        {
          ...server,
          auth: { ...server.auth, oauth: { ...server.auth.oauth, tokens: refreshedTokens } },
          displayName: 'Edited during refresh',
        },
        unrelated,
      ],
    });
    expect(result.result).toMatchObject({ reason: 'permission_denied', status: 'failed' });
    expect(calls).toStrictEqual([]);
    expect(JSON.stringify(result)).not.toContain('test-refreshed-account');
  });

  it('keeps Dangerous mode, workflow flags, WebMCP, and approved Remote MCP tools in shared setup', async () => {
    const { input, requests } = await setup();
    input.settings.mode = 'dangerous';
    if (input.job.approvedTab === undefined) {
      throw new Error('Missing approved tab');
    }
    input.job.approvedTab.effectiveMode = 'dangerous';
    input.settings.remoteMcpServers = [
      {
        allowInSafeMode: false,
        auth: { type: 'none' },
        cachedTools: [{ inputSchema: { properties: {}, type: 'object' }, name: 'read' }],
        displayName: 'Approved remote',
        enabled: true,
        id: 'remote',
        slug: 'remote',
        status: 'connected',
        url: 'https://mcp.example.test/',
      },
    ];
    const result = await runBrowserTask(input);
    expect(result.result.status).toBe('succeeded');
    expect(requests[0]?.body).toContain('"name":"eval"');
    expect(requests[0]?.body).toContain('run_workflow');
    expect(requests[0]?.body).toContain('mcp_remote_read');
    expect(fixture.actions).toStrictEqual([]);
  });
});
