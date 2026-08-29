/* eslint-disable import/no-nodejs-modules, max-lines, jest/no-hooks, jest/no-conditional-in-test, require-await, typescript/require-await, unicorn/no-await-expression-member, typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion -- Mutation fixtures change persisted records deliberately; matcher objects inspect observable outcomes. */
import { locks as nativeLocks } from 'node:worker_threads';
import type {
  BrowserProviderInboundMessage,
  BrowserResult,
} from '@kilocode/cloud-agent-sdk/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_EXECUTION_SAFETY_KEY,
  createBrowserExecutionCoordinator,
} from '../../entrypoints/sidepanel/browser-execution-lock';
import type { BrowserExecutionLease } from '../../entrypoints/sidepanel/browser-execution-lock';
import { createAssistantMessage, createSafeToolCall, createToolResult } from './agent-conversation';
import { AUTH_STORAGE_KEY, clearStoredSession } from './auth';
import { loadBrowserProvider } from './browser-provider-settings';
import type { BrowserApprovalSettings, BrowserProfileStorage } from './browser-provider-settings';
import { BROWSER_TASK_STORAGE_KEY, openBrowserTaskStore } from './browser-task-store';
import type { StoredBrowserJob } from './browser-task-store';

type Delivery = Extract<BrowserProviderInboundMessage, { type: 'provider_job' }>;
const start = 1_788_000_000_000;
const day = 24 * 60 * 60 * 1000;
const leases: BrowserExecutionLease[] = [];
const settings = (): BrowserApprovalSettings => ({
  memorySettings: { autoApproveMemorySaves: false },
  mode: 'safe',
  model: 'explicit-model',
  organizationId: null,
  remoteMcpServers: [],
  thinkingEffort: 'high',
  webMcpSettings: { allowWebMcpInSafeMode: false },
  workflowSettings: {
    allowWorkflowsInSafeMode: false,
    autoApproveWorkflowChanges: false,
    autoApproveWorkflowRuns: false,
  },
});
const tab = {
  effectiveMode: 'safe' as const,
  tabId: 7,
  title: 'Approved tab',
  url: 'https://example.test/task',
};
const resultFor = (delivery: Delivery): BrowserResult => ({
  browserTaskId: delivery.job.browserTaskId,
  effectsUncertain: false,
  evidence: [],
  invocationId: delivery.job.invocationId,
  jobId: delivery.job.jobId,
  providerId: delivery.job.providerId,
  reason: 'completed',
  status: 'succeeded',
  summary: 'The page contains the requested text.',
});
const setup = async () => {
  let time = start;
  const auth = { token: 'token-a', userEmail: 'a@example.test' };
  const values = new Map<string, unknown>([
    [AUTH_STORAGE_KEY, auth],
    [
      'local:kiloAgentConversations',
      {
        activeConversationId: 'visible-local-id',
        conversations: [
          {
            events: [createAssistantMessage('private local transcript')],
            id: 'visible-local-id',
            mode: 'dangerous',
            model: 'local-model',
            title: 'Local conversation',
            updatedAt: new Date(start).toISOString(),
          },
        ],
        openConversationIds: ['visible-local-id'],
      },
    ],
    ['local:kiloAgentConversation', [createAssistantMessage('private legacy transcript')]],
  ]);
  const storageArea: BrowserProfileStorage & Parameters<typeof clearStoredSession>[0] = {
    getItem: key => structuredClone(values.get(key)),
    removeItems: keys => {
      for (const key of keys) {
        values.delete(key);
      }
    },
    setItem: (key, value) => {
      values.set(key, structuredClone(value));
    },
    snapshot: () => Object.fromEntries([...values].map(([key, value]) => [key.slice(6), value])),
  };
  const panel = createBrowserExecutionCoordinator({
    locks: nativeLocks as LockManager,
    storageArea: { ...storageArea, watch: () => () => {} },
  });
  const admission = await panel.acquireProviderOwner();
  if (!admission.admitted) {
    throw new Error(admission.reason);
  }
  const owner = admission.lease;
  leases.push(owner);
  const context = { auth, owner, storageArea };
  const { identity } = await loadBrowserProvider(context);
  const store = await openBrowserTaskStore(context, () => time);
  const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
    conversationMode: 'new',
    goal: 'Read the requested page text.',
    job: {
      browserTaskId: `bt_${crypto.randomUUID()}`,
      createdAt: new Date(time).toISOString(),
      deadlines: {
        approval: new Date(time + 120_000).toISOString(),
        queue: new Date(time + 600_000).toISOString(),
      },
      expiresAt: new Date(time + 7 * day).toISOString(),
      generation: 1,
      invocationId: `b1.${time}.${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`,
      jobId: `bj_${crypto.randomUUID()}`,
      payloadFingerprint: 'a'.repeat(64),
      providerId: identity.providerId,
      status: 'awaiting_approval',
    },
    ownerLabel: 'ses_parent_a',
    type: 'provider_job',
    ...overrides,
  });
  const complete = async (message: Delivery) => {
    await store.approve(message.job.invocationId, tab, settings());
    const events = [
      ...(await store.history(message.job.browserTaskId, message.ownerLabel)),
      createAssistantMessage('Observed page text.'),
    ];
    return store.finish(message.job.invocationId, resultFor(message), events);
  };
  return {
    complete,
    context,
    delivery,
    now: () => time,
    panel,
    setTime: (value: number) => {
      time = value;
    },
    storageArea,
    store,
    values,
  };
};

describe('delegated browser job persistence', () => {
  afterEach(async () => {
    await Promise.all(leases.splice(0).map(lease => lease.release()));
  });

  it('keeps goal-only histories separate from local conversations and unrelated parents', async () => {
    const state = await setup();
    const oldLocal = {
      current: structuredClone(state.values.get('local:kiloAgentConversations')),
      legacy: structuredClone(state.values.get('local:kiloAgentConversation')),
    };
    const first = state.delivery();
    const second = state.delivery({ goal: 'A separate goal.', ownerLabel: 'ses_parent_b' });
    await Promise.all([state.store.accept(first), state.store.accept(second)]);
    await expect(
      state.store.history(first.job.browserTaskId, first.ownerLabel)
    ).resolves.toMatchObject([{ role: 'user', text: first.goal }]);
    await expect(
      state.store.history(second.job.browserTaskId, second.ownerLabel)
    ).resolves.toMatchObject([{ role: 'user', text: second.goal }]);
    expect(JSON.stringify(state.values.get(BROWSER_TASK_STORAGE_KEY))).not.toContain('private');
    expect({
      current: state.values.get('local:kiloAgentConversations'),
      legacy: state.values.get('local:kiloAgentConversation'),
    }).toStrictEqual(oldLocal);
    await expect(
      state.store.history(first.job.browserTaskId, second.ownerLabel)
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
  });

  it.each(['awaiting_approval', 'running', 'succeeded'] as const)(
    'makes duplicate delivery a lookup at %s without another history write',
    async phase => {
      const state = await setup();
      const message = state.delivery();
      await state.store.accept(message);
      if (phase === 'running') {
        await state.store.approve(message.job.invocationId, tab, settings());
      }
      if (phase === 'succeeded') {
        await state.complete(message);
      }
      const before = structuredClone(state.values.get(BROWSER_TASK_STORAGE_KEY));
      const write = state.storageArea.setItem;
      state.storageArea.setItem = () => {
        throw new Error('A lookup must not write.');
      };
      try {
        const duplicate = await state.store.accept(message);
        expect(duplicate).toMatchObject({ job: { snapshot: { status: phase } }, kind: 'existing' });
        expect(state.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(before);
      } finally {
        state.storageArea.setItem = write;
      }
    }
  );

  it.each([
    'goal',
    'ownerLabel',
    'conversationMode',
    'fingerprint',
    'generation',
    'jobId',
    'browserTaskId',
  ] as const)(
    'rejects a conflicting immutable %s without changing the accepted record',
    async field => {
      const state = await setup();
      const message = state.delivery();
      const accepted = await state.store.accept(message);
      const changed = structuredClone(message);
      if (field === 'goal') {
        changed.goal = 'Different goal';
      }
      if (field === 'ownerLabel') {
        changed.ownerLabel = 'ses_other';
      }
      if (field === 'conversationMode') {
        changed.conversationMode = 'continue';
      }
      if (field === 'fingerprint') {
        changed.job.payloadFingerprint = 'b'.repeat(64);
      }
      if (field === 'generation') {
        changed.job.generation += 1;
      }
      if (field === 'jobId') {
        changed.job.jobId = `bj_${crypto.randomUUID()}`;
      }
      if (field === 'browserTaskId') {
        changed.job.browserTaskId = `bt_${crypto.randomUUID()}`;
      }
      await expect(state.store.accept(changed)).rejects.toMatchObject({
        code: 'invocation_conflict',
        retryable: false,
      });
      await expect(state.store.lookup(message.job.invocationId)).resolves.toStrictEqual(
        accepted.job
      );
    }
  );

  it('rejects absent legacy intent instead of creating a new conversation', async () => {
    const state = await setup();
    const legacy = state.delivery();
    delete legacy.conversationMode;
    await expect(state.store.accept(legacy)).rejects.toMatchObject({
      code: 'unsupported',
      retryable: false,
    });
    await expect(state.store.list()).resolves.toStrictEqual([]);
    await expect(
      state.store.history(legacy.job.browserTaskId, legacy.ownerLabel)
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each(['queued', 'awaiting_approval'] as const)(
    'settles legacy %s work with unknown intent and never grants approval after reload',
    async phase => {
      const state = await setup();
      const message = state.delivery();
      const accepted = await state.store.accept(message);
      const raw = state.values.get(BROWSER_TASK_STORAGE_KEY) as {
        jobs: { intent: { conversationMode?: string } }[];
      };
      const [legacy] = raw.jobs;
      if (legacy === undefined) {
        throw new Error('Missing fixture job.');
      }
      delete legacy.intent.conversationMode;
      Object.assign(legacy, { snapshot: { ...message.job, status: phase } });
      const reloaded = await openBrowserTaskStore(state.context, state.now);
      await expect(reloaded.lookup(message.job.invocationId)).resolves.toMatchObject({
        intent: { conversationMode: 'unknown' },
        snapshot: {
          result: { effectsUncertain: false, reason: 'unsupported' },
          status: 'interrupted',
        },
      });
      await expect(
        reloaded.approve(message.job.invocationId, tab, settings())
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(accepted.job.snapshot.status).toBe('awaiting_approval');
    }
  );

  it('requires owned, retained history and fresh settings and tab consent for continuation', async () => {
    const state = await setup();
    const first = state.delivery();
    await state.store.accept(first);
    await state.complete(first);
    const next = state.delivery({
      conversationMode: 'continue',
      goal: 'Follow up only this browser history.',
    });
    next.job.browserTaskId = first.job.browserTaskId;
    const accepted = await state.store.accept(next);
    expect(accepted.job.approval).toBeNull();
    expect(accepted.job.snapshot.approvedTab).toBeUndefined();
    const approvedSettings = {
      ...settings(),
      mode: 'dangerous' as const,
      model: 'new-explicit-model',
      organizationId: 'org-selected',
    };
    const approvedTab = { ...tab, effectiveMode: 'dangerous' as const, tabId: 8 };
    await state.store.approve(next.job.invocationId, approvedTab, approvedSettings);
    approvedSettings.model = 'changed-after-approval';
    approvedSettings.workflowSettings.autoApproveWorkflowRuns = true;
    approvedTab.tabId = 99;
    await expect(state.store.lookup(next.job.invocationId)).resolves.toMatchObject({
      approval: {
        settings: {
          model: 'new-explicit-model',
          organizationId: 'org-selected',
          workflowSettings: { autoApproveWorkflowRuns: false },
        },
        tab: { tabId: 8 },
      },
      snapshot: { status: 'running' },
    });
    await expect(
      state.store.history(first.job.browserTaskId, first.ownerLabel)
    ).resolves.toMatchObject([
      { text: first.goal },
      { text: 'Observed page text.' },
      { text: next.goal },
    ]);
    await expect(state.store.approve(next.job.invocationId, tab, settings())).rejects.toMatchObject(
      { code: 'invalid_request' }
    );
  });

  it.each(['missing', 'owner', 'provider', 'busy'] as const)(
    'rejects %s continuation rather than starting another conversation',
    async reason => {
      const state = await setup();
      const first = state.delivery();
      await state.store.accept(first);
      if (reason !== 'busy') {
        await state.complete(first);
      }
      const next = state.delivery({ conversationMode: 'continue' });
      if (reason !== 'missing') {
        next.job.browserTaskId = first.job.browserTaskId;
      }
      if (reason === 'owner') {
        next.ownerLabel = 'ses_other';
      }
      if (reason === 'provider') {
        next.job.providerId = `bp_${crypto.randomUUID()}`;
      }
      await expect(state.store.accept(next)).rejects.toMatchObject({
        code: {
          busy: 'conversation_busy',
          missing: 'not_found',
          owner: 'owner_mismatch',
          provider: 'owner_mismatch',
        }[reason],
        retryable: false,
      });
      await expect(state.store.list()).resolves.toHaveLength(1);
    }
  );

  it('persists sanitized history and honest empty evidence before returning terminal completion', async () => {
    const state = await setup();
    const message = state.delivery();
    await state.store.accept(message);
    await state.store.approve(message.job.invocationId, tab, settings());
    const call = createSafeToolCall({ name: 'get_viewport_screenshot', tabId: tab.tabId });
    const screenshot = createToolResult({
      ok: true,
      toolCallId: call.id,
      value: { dataUrl: 'data:image/png;base64,private-image-bytes', mediaType: 'image/png' },
    });
    const events = [
      ...(await state.store.history(message.job.browserTaskId, message.ownerLabel)),
      call,
      screenshot,
      createAssistantMessage('Observed the page.'),
    ];
    const gate = Promise.withResolvers<void>();
    const write = state.storageArea.setItem;
    let writing = false;
    let completed = false;
    state.storageArea.setItem = async (key, value) => {
      writing = true;
      await gate.promise;
      await write(key, value);
    };
    const finish = (async () => {
      const job = await state.store.finish(message.job.invocationId, resultFor(message), events);
      completed = true;
      return job;
    })();
    try {
      await vi.waitFor(() => {
        expect(writing).toBe(true);
      });
      expect(completed).toBe(false);
      expect(JSON.stringify(state.values.get(BROWSER_TASK_STORAGE_KEY))).not.toContain(
        'Observed the page.'
      );
    } finally {
      gate.resolve();
    }
    const finished = await finish;
    state.storageArea.setItem = write;
    expect(finished.snapshot.result).toMatchObject({ evidence: [], status: 'succeeded' });
    const reloaded = await openBrowserTaskStore(state.context, state.now);
    expect((await reloaded.lookup(message.job.invocationId)).snapshot.result).toStrictEqual(
      resultFor(message)
    );
    const history = await reloaded.history(message.job.browserTaskId, message.ownerLabel);
    expect(JSON.stringify(history)).not.toContain('private-image-bytes');
    expect(history).toContainEqual(
      expect.objectContaining({
        value: {
          mediaType: 'image/png',
          note: 'Viewport screenshot omitted from persisted history.',
        },
      })
    );
  });

  it('interrupts in-flight work on reload and keeps its durable fence after expiry', async () => {
    const state = await setup();
    const message = state.delivery();
    await state.store.accept(message);
    await state.store.approve(message.job.invocationId, tab, settings());
    const reloaded = await openBrowserTaskStore(state.context, state.now);
    await expect(reloaded.lookup(message.job.invocationId)).resolves.toMatchObject({
      snapshot: { result: { effectsUncertain: true }, status: 'interrupted' },
      uncertaintyFence: true,
    });
    expect({
      admitted: (await state.panel.acquireLocal()).admitted,
      delivery: (await reloaded.accept(message)).kind,
    }).toStrictEqual({ admitted: false, delivery: 'existing' });
    state.setTime(start + 7 * day);
    await reloaded.removeExpired();
    await expect(reloaded.list()).resolves.toStrictEqual([]);
    expect(state.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
    await expect(reloaded.lookup(message.job.invocationId)).rejects.toMatchObject({
      code: 'invocation_expired',
    });
  });

  it('keeps terminal results first-wins and does not rewrite cancelled history with late success', async () => {
    const state = await setup();
    const message = state.delivery();
    await state.store.accept(message);
    const cancelled: BrowserResult = {
      ...resultFor(message),
      effectsUncertain: false,
      reason: 'cancelled',
      status: 'cancelled',
      summary: 'Stopped before approval.',
    };
    const events = await state.store.history(message.job.browserTaskId, message.ownerLabel);
    await state.store.finish(message.job.invocationId, cancelled, events);
    expect(
      (
        await state.store.finish(message.job.invocationId, resultFor(message), [
          createAssistantMessage('Late success'),
        ])
      ).snapshot.result
    ).toStrictEqual(cancelled);
    await expect(
      state.store.history(message.job.browserTaskId, message.ownerLabel)
    ).resolves.toStrictEqual(events);
  });

  it.each(['accept', 'approve', 'finish'] as const)(
    'does not report %s when its storage write fails',
    async phase => {
      const state = await setup();
      const message = state.delivery();
      if (phase !== 'accept') {
        await state.store.accept(message);
      }
      if (phase === 'finish') {
        await state.store.approve(message.job.invocationId, tab, settings());
      }
      const before = structuredClone(state.values.get(BROWSER_TASK_STORAGE_KEY));
      state.storageArea.setItem = () => {
        throw new Error('Quota exceeded with private context');
      };
      const operations = {
        accept: () => state.store.accept(message),
        approve: () => state.store.approve(message.job.invocationId, tab, settings()),
        finish: () =>
          state.store.finish(message.job.invocationId, resultFor(message), [
            createAssistantMessage('Unrecorded result'),
          ]),
      };
      const work = operations[phase]();
      await expect(work).rejects.toMatchObject({
        code: 'storage_failure',
        message: expect.not.stringContaining('private context'),
        retryable: true,
      });
      expect(state.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(before);
    }
  );

  it('rejects oversized multibyte goals, oversized evidence, and unrecordable approval snapshots', async () => {
    const state = await setup();
    await expect(
      state.store.accept(state.delivery({ goal: 'é'.repeat(8193) }))
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const message = state.delivery();
    await state.store.accept(message);
    const approval = settings();
    approval.remoteMcpServers = [
      {
        allowInSafeMode: false,
        auth: { type: 'none' },
        cachedTools: [{ inputSchema: { description: 'x'.repeat(70_000) }, name: 'tool' }],
        displayName: 'Server',
        enabled: true,
        id: 'server',
        slug: 'server',
        status: 'connected',
        url: 'https://example.test/mcp',
      },
    ];
    await expect(
      state.store.approve(message.job.invocationId, tab, approval)
    ).rejects.toMatchObject({ code: 'storage_failure' });
    expect((await state.store.lookup(message.job.invocationId)).snapshot.status).toBe(
      'awaiting_approval'
    );
    await state.store.approve(message.job.invocationId, tab, settings());
    await expect(
      state.store.finish(
        message.job.invocationId,
        {
          ...resultFor(message),
          evidence: Array.from({ length: 9 }, () => ({ text: 'x'.repeat(8192) })),
        },
        []
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await state.store.lookup(message.job.invocationId)).snapshot.status).toBe('running');
  });

  it.each([Number.NaN, 1n, () => 'not JSON'])(
    'rejects nonserializable tool output (%s) instead of silently dropping it',
    async value => {
      const state = await setup();
      const message = state.delivery();
      await state.store.accept(message);
      const before = structuredClone(state.values.get(BROWSER_TASK_STORAGE_KEY));
      await expect(
        state.store.saveHistory(message.job.invocationId, [
          createToolResult({ ok: true, toolCallId: 'tool', value }),
        ])
      ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
      expect(state.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(before);
    }
  );

  it('retains shared history until the last invocation expires and denies expired continuation', async () => {
    const state = await setup();
    const first = state.delivery();
    await state.store.accept(first);
    await state.complete(first);
    state.setTime(start + day);
    const next = state.delivery({ conversationMode: 'continue', goal: 'Follow-up' });
    next.job.browserTaskId = first.job.browserTaskId;
    await state.store.accept(next);
    await state.complete(next);
    state.setTime(start + 7 * day);
    await state.store.removeExpired();
    await expect(state.store.list()).resolves.toHaveLength(1);
    await expect(
      state.store.history(first.job.browserTaskId, first.ownerLabel)
    ).resolves.toHaveLength(4);
    state.setTime(start + 8 * day);
    await expect(
      state.store.history(first.job.browserTaskId, first.ownerLabel)
    ).rejects.toMatchObject({ code: 'invocation_expired' });
    await state.store.removeExpired();
    const late = state.delivery({ conversationMode: 'continue' });
    late.job.browserTaskId = first.job.browserTaskId;
    await expect(state.store.accept(late)).rejects.toMatchObject({ code: 'not_found' });
    await expect(state.store.list()).resolves.toStrictEqual([]);
  });

  it('clears account histories and refuses stale writes or foreign-account adoption after sign-out', async () => {
    const state = await setup();
    const message = state.delivery();
    await state.store.accept(message);
    await clearStoredSession(state.storageArea);
    await expect(state.store.lookup(message.job.invocationId)).rejects.toMatchObject({
      code: 'owner_mismatch',
    });
    await expect(
      state.store.saveHistory(message.job.invocationId, [createAssistantMessage('stale')])
    ).rejects.toMatchObject({ code: 'owner_mismatch' });
    expect(state.values.has(BROWSER_TASK_STORAGE_KEY)).toBe(false);
    const auth = { token: 'token-b', userEmail: 'b@example.test' };
    state.values.set(AUTH_STORAGE_KEY, auth);
    const next = await openBrowserTaskStore({ ...state.context, auth }, state.now);
    await expect(next.list()).resolves.toStrictEqual([]);
    await expect(next.accept({ ...message, conversationMode: 'continue' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects corrupt storage rather than replacing it with an empty delegated store', async () => {
    const state = await setup();
    const corrupt = { jobs: ['private-corrupt-history'], version: 99 };
    state.values.set(BROWSER_TASK_STORAGE_KEY, corrupt);
    await expect(openBrowserTaskStore(state.context, state.now)).rejects.toMatchObject({
      code: 'storage_failure',
    });
    expect(state.values.get(BROWSER_TASK_STORAGE_KEY)).toBe(corrupt);
  });

  it('captures delivery and approval inputs before waiting behind another storage write', async () => {
    const state = await setup();
    const first = state.delivery();
    await state.store.accept(first);
    const gate = Promise.withResolvers<void>();
    const { setItem } = state.storageArea;
    let writing = false;
    state.storageArea.setItem = async (key, value) => {
      writing = true;
      await gate.promise;
      await setItem(key, value);
    };
    const updating = state.store.saveHistory(first.job.invocationId, [
      createAssistantMessage('Earlier write'),
    ]);
    await vi.waitFor(() => {
      expect(writing).toBe(true);
    });
    const snapshot = settings();
    const approving = state.store.approve(first.job.invocationId, tab, snapshot);
    const second = state.delivery({ goal: 'Original delivered goal' });
    const accepting = state.store.accept(second);
    snapshot.model = 'mutated after consent';
    second.goal = 'mutated after delivery';
    gate.resolve();
    await Promise.all([updating, approving, accepting]);
    state.storageArea.setItem = setItem;
    await expect(state.store.lookup(first.job.invocationId)).resolves.toMatchObject({
      approval: { settings: { model: 'explicit-model' } },
    });
    await expect(
      state.store.history(second.job.browserTaskId, second.ownerLabel)
    ).resolves.toMatchObject([{ text: 'Original delivered goal' }]);
  });

  it('serializes native storage writes with logout so a delayed writer cannot restore account data', async () => {
    vi.stubGlobal('navigator', { locks: nativeLocks });
    const state = await setup();
    const message = state.delivery();
    const gate = Promise.withResolvers<void>();
    const { setItem } = state.storageArea;
    let writing = false;
    state.storageArea.setItem = async (key, value) => {
      writing = true;
      await gate.promise;
      await setItem(key, value);
    };
    const accepting = state.store.accept(message);
    await vi.waitFor(() => {
      expect(writing).toBe(true);
    });
    const clearing = clearStoredSession(state.storageArea);
    const stale = (async () => {
      await expect(
        state.store.saveHistory(message.job.invocationId, [createAssistantMessage('stale')])
      ).rejects.toMatchObject({ code: 'owner_mismatch' });
    })();
    gate.resolve();
    try {
      await Promise.all([accepting, clearing, stale]);
      expect(state.values.has(BROWSER_TASK_STORAGE_KEY)).toBe(false);
      expect(state.values.has(AUTH_STORAGE_KEY)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retains bounded observed evidence with a maximum UTF-8 goal and a large approval snapshot', async () => {
    const state = await setup();
    const message = state.delivery({ goal: 'é'.repeat(8192) });
    await state.store.accept(message);
    const approval = settings();
    approval.remoteMcpServers = [
      {
        allowInSafeMode: false,
        auth: { type: 'none' },
        cachedTools: [{ inputSchema: { description: 'x'.repeat(40_000) }, name: 'tool' }],
        displayName: 'Server',
        enabled: true,
        id: 'server',
        slug: 'server',
        status: 'connected',
        url: 'https://example.test/mcp',
      },
    ];
    await state.store.approve(message.job.invocationId, tab, approval);
    const result = {
      ...resultFor(message),
      evidence: Array.from({ length: 3 }, () => ({
        text: 'é'.repeat(4096),
        title: 'Observed title',
        url: 'https://example.test/evidence',
      })),
      summary: 's'.repeat(32 * 1024),
    };
    const history = await state.store.history(message.job.browserTaskId, message.ownerLabel);
    await state.store.finish(message.job.invocationId, result, history);
    const reloaded = await openBrowserTaskStore(state.context, state.now);
    await expect(reloaded.lookup(message.job.invocationId)).resolves.toMatchObject({
      snapshot: { result },
    });
    await expect(
      reloaded.history(message.job.browserTaskId, message.ownerLabel)
    ).resolves.toStrictEqual(history);
  });

  it('rejects invalid consent and expired approval without changing the recorded invocation', async () => {
    const state = await setup();
    const message = state.delivery();
    await state.store.accept(message);
    await expect(
      state.store.approve(message.job.invocationId, tab, { ...settings(), model: '' })
    ).rejects.toMatchObject({ code: 'model_required', retryable: false });
    await expect(
      state.store.approve(
        message.job.invocationId,
        { ...tab, effectiveMode: 'dangerous' },
        settings()
      )
    ).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    state.setTime(start + 120_000);
    await expect(
      state.store.approve(message.job.invocationId, tab, settings())
    ).rejects.toMatchObject({ code: 'invocation_expired' });
    await expect(state.store.lookup(message.job.invocationId)).resolves.toMatchObject({
      approval: null,
      snapshot: { status: 'awaiting_approval' },
    });
  });

  it('rejects a foreign terminal result even when the recorded invocation is already terminal', async () => {
    const state = await setup();
    const message = state.delivery();
    await state.store.accept(message);
    const finished = await state.complete(message);
    const foreign = resultFor(state.delivery({ ownerLabel: 'ses_other' }));
    await expect(state.store.finish(message.job.invocationId, foreign, [])).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(state.store.lookup(message.job.invocationId)).resolves.toStrictEqual(finished);
  });

  it('rejects oversized history without evicting the previous transcript', async () => {
    const state = await setup();
    const message = state.delivery();
    await state.store.accept(message);
    const before = await state.store.history(message.job.browserTaskId, message.ownerLabel);
    await expect(
      state.store.saveHistory(message.job.invocationId, [
        createAssistantMessage('é'.repeat(70_000)),
      ])
    ).rejects.toMatchObject({ code: 'storage_failure' });
    await expect(
      state.store.history(message.job.browserTaskId, message.ownerLabel)
    ).resolves.toStrictEqual(before);
  });

  it('excludes the active job from the 100-job queue limit and rejects a larger stored queue', async () => {
    const state = await setup();
    const first = state.delivery();
    await state.store.accept(first);
    const raw = state.values.get(BROWSER_TASK_STORAGE_KEY) as {
      histories: unknown[];
      jobs: StoredBrowserJob[];
    };
    const [template] = raw.jobs;
    if (template === undefined) {
      throw new Error('Missing fixture.');
    }
    const queued = (index: number): StoredBrowserJob => {
      const job = structuredClone(template);
      const handle = {
        browserTaskId: `bt_${crypto.randomUUID()}` as const,
        invocationId: `b1.${start}.${index.toString(16).padStart(64, '0')}`,
        jobId: `bj_${crypto.randomUUID()}` as const,
        status: 'queued' as const,
      };
      job.intent.job = { ...job.intent.job, ...handle };
      job.snapshot = { ...job.snapshot, ...handle };
      return job;
    };
    raw.jobs = Array.from({ length: 100 }, (_value, index) => queued(index));
    raw.histories = raw.jobs.map(job => ({
      browserTaskId: job.snapshot.browserTaskId,
      events: [],
      expiresAt: job.snapshot.expiresAt,
      ownerLabel: job.intent.ownerLabel,
      providerId: job.snapshot.providerId,
    }));
    const active = state.delivery();
    await expect(state.store.accept(active)).resolves.toMatchObject({ kind: 'accepted' });
    const recorded = state.values.get(BROWSER_TASK_STORAGE_KEY) as { jobs: StoredBrowserJob[] };
    recorded.jobs.push(queued(100));
    const before = structuredClone(recorded);
    await expect(state.store.lookup(active.job.invocationId)).rejects.toMatchObject({
      code: 'capacity_exceeded',
    });
    expect(state.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(before);
  });

  it.each(['expired', 'future', 'renewed'] as const)(
    'rejects %s invocation lifetimes before admission',
    async kind => {
      const state = await setup();
      const message = state.delivery();
      if (kind === 'renewed') {
        message.job.expiresAt = new Date(start + 8 * day).toISOString();
      } else {
        const createdAt = kind === 'expired' ? start - 7 * day : start + 300_001;
        message.job.invocationId = `b1.${createdAt}.${'a'.repeat(64)}`;
        message.job.createdAt = new Date(createdAt).toISOString();
        message.job.expiresAt = new Date(createdAt + 7 * day).toISOString();
        message.job.deadlines = { approval: message.job.expiresAt, queue: message.job.expiresAt };
      }
      await expect(state.store.accept(message)).rejects.toMatchObject({
        code: kind === 'expired' ? 'invocation_expired' : 'invalid_request',
        retryable: false,
      });
      await expect(state.store.list()).resolves.toStrictEqual([]);
    }
  );

  it('rejects the 1,001st retained job without evicting an accepted result', async () => {
    const state = await setup();
    const first = state.delivery();
    await state.store.accept(first);
    await state.complete(first);
    const raw = state.values.get(BROWSER_TASK_STORAGE_KEY) as { jobs: StoredBrowserJob[] };
    const [template] = raw.jobs;
    if (template === undefined) {
      throw new Error('Missing fixture.');
    }
    raw.jobs = Array.from({ length: 1000 }, (_value, index) => {
      const job = structuredClone(template);
      const invocationId = `b1.${start}.${index.toString(16).padStart(64, '0')}`;
      const jobId = `bj_${crypto.randomUUID()}` as const;
      job.intent.job.invocationId = invocationId;
      job.intent.job.jobId = jobId;
      job.snapshot.invocationId = invocationId;
      job.snapshot.jobId = jobId;
      if (job.snapshot.result !== undefined) {
        job.snapshot.result.invocationId = invocationId;
        job.snapshot.result.jobId = jobId;
      }
      return job;
    });
    const before = structuredClone(raw);
    await expect(state.store.accept(state.delivery())).rejects.toMatchObject({
      code: 'capacity_exceeded',
      retryable: true,
    });
    expect(state.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(before);
  });
});
