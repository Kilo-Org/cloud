/* eslint-disable max-lines, init-declarations, import/max-dependencies, import/first, import/no-nodejs-modules, jest/no-hooks, jest/no-untyped-mock-factory, jest/no-conditional-in-test, jest/no-conditional-expect, jest/max-expects, vitest/prefer-import-in-mock, require-await, typescript/require-await, typescript/consistent-type-definitions, typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion, unicorn/no-await-expression-member -- Table-driven lifetime scenarios check each transition and its durable effects; fixtures retain the browser API types. */
// @vitest-environment jsdom
import { locks as nativeLocks } from 'node:worker_threads';
import { webcrypto } from 'node:crypto';
import { act, render, screen, waitFor } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserJobSnapshot,
  BrowserProviderInboundMessage,
  BrowserProviderOutboundMessage,
  BrowserResult,
} from '@kilocode/cloud-agent-sdk/schemas';
import { browserProviderOutboundMessageSchema } from '@kilocode/cloud-agent-sdk/schemas';
import { BrowserProviderError } from '@kilocode/cloud-agent-sdk/user-web-connection';
import type {
  BrowserProviderState,
  BrowserProviderRegistration,
  BrowserProviderApprovalInput,
  BrowserProviderCancelInput,
  BrowserProviderUnavailableInput,
  BrowserProviderQuiescenceInput,
  BrowserProviderResultInput,
} from '@kilocode/cloud-agent-sdk/user-web-connection';
import type { BrowserRunContext } from './browser-run-context';
import type { LlmTurnOutcome } from '@/src/shared/agent-llm-turn-runner-core';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';

const fixture = vi.hoisted(() => ({
  actions: [] as string[],
  failWrite: '',
  permissions: new Set<() => void>(),
  removed: new Set<(id: number) => void>(),
  tabs: [
    { id: 7, title: 'Approved tab', url: 'https://example.test/task' },
    { id: 8, title: 'Other tab', url: 'https://other.test/' },
  ],
  turn: async (
    _context: BrowserRunContext,
    _events: AgentConversationEvent[]
  ): Promise<LlmTurnOutcome> => {
    throw new Error('Set the test turn.');
  },
  updated: new Set<(id: number, info: { url?: string }) => void>(),
  values: new Map<string, unknown>(),
  watchers: new Map<string, Set<() => void>>(),
  writes: [] as string[],
}));
vi.mock('#imports', () => ({
  browser: {
    permissions: {
      onRemoved: {
        addListener: (fn: () => void) => fixture.permissions.add(fn),
        removeListener: (fn: () => void) => fixture.permissions.delete(fn),
      },
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
      onUpdated: {
        addListener: (fn: (id: number, info: { url?: string }) => void) => fixture.updated.add(fn),
        removeListener: (fn: (id: number, info: { url?: string }) => void) =>
          fixture.updated.delete(fn),
      },
      query: async () => structuredClone(fixture.tabs),
    },
  },
  storage: {
    getItem: (key: string) => structuredClone(fixture.values.get(key)),
    removeItem: (key: string) => {
      fixture.values.delete(key);
    },
    setItem: async (key: string, value: unknown) => {
      if (fixture.failWrite === key) {
        throw new Error('Private storage failure');
      }
      fixture.values.set(key, structuredClone(value));
      fixture.writes.push(key);
      for (const notify of fixture.watchers.get(key) ?? []) {
        notify();
      }
    },
    watch: (key: string, fn: () => void) => {
      const listeners = fixture.watchers.get(key) ?? new Set<() => void>();
      fixture.watchers.set(key, listeners);
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  },
}));
vi.mock('./use-gateway-models', () => ({
  useGatewayModels: () => ({ modelOptions: [{ id: 'selected-model', supportsImages: true }] }),
}));
vi.mock(import('./browser-run-context'), async importOriginal => {
  const original = await importOriginal();
  return {
    ...original,
    runBrowserTurn: (context: BrowserRunContext, events: AgentConversationEvent[]) =>
      context.lease.run(async guard => {
        guard();
        return fixture.turn(context, events);
      }),
  };
});

import { browser, storage } from '#imports';
import {
  AUTH_STORAGE_KEY,
  BROWSER_PROVIDER_IDENTITY_KEY,
  clearStoredSession,
} from '@/src/shared/auth';
import { createAssistantMessage } from '@/src/shared/agent-conversation';
import { BROWSER_TASK_STORAGE_KEY } from '@/src/shared/browser-task-store';
import type { StoredBrowserJob } from '@/src/shared/browser-task-store';
import {
  createBrowserExecutionCoordinator,
  BROWSER_EXECUTION_LOCK,
  BROWSER_EXECUTION_SAFETY_KEY,
  PROVIDER_OWNER_LOCK,
} from './browser-execution-lock';
import type { BrowserExecutionLease } from './browser-execution-lock';
import {
  BrowserTaskProvider,
  createBrowserTaskProviderRuntime,
  useBrowserTask,
} from './browser-task-provider';
import type { BrowserTaskProviderRuntime } from './browser-task-provider';
import { applyApprovalDecision, pendingApprovalAtom, pendingLockAtom } from './pending-approval';

type Delivery = Extract<BrowserProviderInboundMessage, { type: 'provider_job' }>;
type Fence = { invocationId: string; tabId?: number };
const runtimes: BrowserTaskProviderRuntime[] = [];
const localLeases: BrowserExecutionLease[] = [];
const auth = { token: 'test-account-token', userEmail: 'owner@example.test' };
const defaults = {
  enabled: true,
  mode: 'safe' as const,
  model: 'selected-model',
  thinkingEffort: 'high',
};
const outcome = (): LlmTurnOutcome => ({
  effectsUncertain: false,
  reason: 'completed',
  status: 'succeeded',
  summary: 'Observed the requested page.',
  toolResults: [],
});
const terminalResult = (
  job: BrowserJobSnapshot,
  reason: Exclude<BrowserResult['reason'], 'completed'>,
  status: Exclude<BrowserResult['status'], 'succeeded'> = 'interrupted'
): BrowserResult => ({
  browserTaskId: job.browserTaskId,
  effectsUncertain: job.status === 'running',
  evidence: [],
  invocationId: job.invocationId,
  jobId: job.jobId,
  providerId: job.providerId,
  reason,
  status,
  summary: `Relay settled ${reason}.`,
});
const relay = () => {
  let state: BrowserProviderState = { status: 'ready' };
  let registration: BrowserProviderRegistration | undefined;
  // Relay history retains its binding after the SDK clears its registration proof.
  let cachedRegistration: BrowserProviderRegistration | undefined;
  let generation = 0;
  let fence: Fence | undefined;
  let acknowledgeApproval = true;
  let acknowledgeHeartbeat = true;
  let acknowledgeTerminal = true;
  const queued = new Map<string, Delivery>();
  const rows = new Map<string, BrowserJobSnapshot>();
  const messages = new Set<(message: BrowserProviderInboundMessage) => void>();
  const states = new Set<(value: BrowserProviderState) => void>();
  const outbound: BrowserProviderOutboundMessage[] = [];
  const events: string[] = [];
  const heartbeatTimes: number[] = [];
  const setState = (next: BrowserProviderState): void => {
    state = next;
    for (const listener of states) {
      listener(next);
    }
  };
  const send = (message: BrowserProviderInboundMessage): void => {
    for (const listener of messages) {
      listener(structuredClone(message));
    }
  };
  const snapshot = (): void => {
    if (registration !== undefined) {
      send({
        generation,
        jobs: [...rows.values()].filter(job => job.generation === generation),
        providerId: registration.providerId,
        type: 'provider_snapshot',
      });
    }
  };
  const record = (message: BrowserProviderOutboundMessage): void => {
    outbound.push(browserProviderOutboundMessageSchema.parse(message));
  };
  const renew = () => {
    if (registration === undefined) {
      throw new Error('No provider');
    }
    const lease = {
      generation,
      leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(),
      providerId: registration.providerId,
      requestId: crypto.randomUUID(),
      type: 'provider_lease_ack' as const,
    };
    setState({ lease, status: 'registered' });
    return lease;
  };
  const settle = (job: BrowserJobSnapshot, result: BrowserResult): void => {
    if (rows.get(job.jobId)?.result !== undefined) {
      return;
    }
    rows.set(job.jobId, { ...job, result, status: result.status });
    queued.delete(job.jobId);
    if (acknowledgeTerminal) {
      snapshot();
    }
  };
  const dispatch = (message: Delivery): void => {
    rows.set(message.job.jobId, message.job);
    fence = { invocationId: message.job.invocationId };
    send(message);
  };
  const connection = {
    approveBrowserProviderJob: (input: BrowserProviderApprovalInput) => {
      record({ ...input, type: 'provider_approval' });
      const job = rows.get(input.jobId);
      if (job === undefined) {
        throw new Error('Unknown job');
      }
      if (input.approval.decision === 'denied') {
        settle(job, terminalResult(job, 'approval_denied', 'failed'));
        return;
      }
      fence = { invocationId: job.invocationId, tabId: input.approval.tab.tabId };
      rows.set(job.jobId, {
        ...job,
        approvedTab: input.approval.tab,
        deadlines: { ...job.deadlines, execution: new Date(Date.now() + 600_000).toISOString() },
        status: 'running',
      });
      if (acknowledgeApproval) {
        snapshot();
      }
    },
    cancelBrowserProviderJob: (input: BrowserProviderCancelInput) => {
      record({ ...input, type: 'provider_cancel' });
      const job = rows.get(input.jobId);
      if (job === undefined) {
        throw new Error('Unknown job');
      }
      if (job.status === 'running') {
        setState({ reason: 'cancelled', retryable: true, status: 'unavailable' });
      }
      send({ ...input, reason: 'cancelled', type: 'provider_job_cancel' });
      settle(job, terminalResult(job, 'cancelled', 'cancelled'));
    },
    getBrowserProviderState: () => state,
    heartbeatBrowserProvider: async () => {
      heartbeatTimes.push(Date.now());
      if (registration === undefined) {
        throw new BrowserProviderError('provider_unavailable', true);
      }
      if (acknowledgeHeartbeat) {
        renew();
      }
      return {
        generation,
        jobs: [...rows.values()].filter(job => job.generation === generation),
        providerId: registration.providerId,
        type: 'provider_snapshot' as const,
      };
    },
    markBrowserProviderUnavailable: (input: BrowserProviderUnavailableInput) => {
      record({ ...input, type: 'provider_unavailable' });
      cachedRegistration = undefined;
      setState({ reason: input.reason, retryable: true, status: 'unavailable' });
      for (const job of rows.values()) {
        if (job.result === undefined) {
          settle(job, terminalResult(job, input.reason));
        }
      }
    },
    onBrowserProviderMessage: (listener: (message: BrowserProviderInboundMessage) => void) => {
      messages.add(listener);
      return () => {
        messages.delete(listener);
      };
    },
    onBrowserProviderStateChange: (listener: (value: BrowserProviderState) => void) => {
      states.add(listener);
      return () => {
        states.delete(listener);
      };
    },
    quiesceBrowserProviderJob: (input: BrowserProviderQuiescenceInput) => {
      record({ ...input, type: 'provider_quiesced' });
      if (rows.get(input.jobId)?.result === undefined) {
        throw new Error('Premature quiescence');
      }
      if (fence?.invocationId !== input.invocationId || fence.tabId !== input.tabId) {
        throw new Error('Quiescence must match the dispatched fence');
      }
      events.push('quiesced');
      fence = undefined;
      const next = queued.values().next().value;
      if (next !== undefined && state.status === 'registered') {
        queued.delete(next.job.jobId);
        dispatch(next);
      }
    },
    registerBrowserProvider: async (input: BrowserProviderRegistration) => {
      record({
        ...input,
        enabled: true,
        requestId: crypto.randomUUID(),
        type: 'provider_register',
      });
      registration = input;
      cachedRegistration = input;
      if (
        fence !== undefined &&
        (input.recovery?.invocationId !== fence.invocationId ||
          input.recovery?.tabId !== fence.tabId)
      ) {
        setState({ reason: 'provider_unavailable', retryable: true, status: 'unavailable' });
        throw new BrowserProviderError('provider_unavailable', true);
      }
      events.push(input.recovery === undefined ? 'registered' : 'recovered');
      fence = undefined;
      generation += 1;
      return renew();
    },
    requestBrowserProviderStatus: async (
      _cursor?: string,
      identity?: Pick<BrowserProviderRegistration, 'providerId' | 'providerProof'>
    ) => {
      events.push('status');
      const provider = identity ?? cachedRegistration;
      if (provider === undefined) {
        throw new BrowserProviderError('provider_unavailable', true);
      }
      if (
        provider.providerId !== registration?.providerId ||
        provider.providerProof !== registration.providerProof
      ) {
        throw new BrowserProviderError('owner_mismatch', false);
      }
      return {
        jobs: [...rows.values()],
        providerId: provider.providerId,
        requestId: crypto.randomUUID(),
        type: 'provider_status_result' as const,
        ...(fence === undefined ? {} : { unresolvedFence: fence }),
      };
    },
    retain: () => () => {
      events.push('released');
    },
    retryConnection: () => {
      setState({ status: 'ready' });
    },
    sendBrowserProviderResult: (input: BrowserProviderResultInput) => {
      record({ ...input, type: 'provider_result' });
      const persisted = fixture.values.get(BROWSER_TASK_STORAGE_KEY) as {
        jobs: StoredBrowserJob[];
      };
      if (
        !persisted.jobs.some(
          job =>
            job.snapshot.invocationId === input.invocationId && job.snapshot.result !== undefined
        )
      ) {
        throw new Error('Result before persistence');
      }
      events.push('result');
      const job = rows.get(input.jobId);
      if (job === undefined) {
        throw new Error('Unknown job');
      }
      settle(job, input.result);
    },
  };
  const delivery = (overrides: Partial<Delivery> = {}): Delivery => {
    if (registration === undefined) {
      throw new Error('No provider');
    }
    const now = Date.now();
    return {
      conversationMode: 'new',
      goal: 'Read the requested page.',
      job: {
        browserTaskId: `bt_${crypto.randomUUID()}`,
        createdAt: new Date(now).toISOString(),
        deadlines: {
          approval: new Date(now + 120_000).toISOString(),
          queue: new Date(now + 600_000).toISOString(),
        },
        expiresAt: new Date(now + 604_800_000).toISOString(),
        generation,
        invocationId: `b1.${now}.${'a'.repeat(32)}${crypto.randomUUID().replaceAll('-', '')}`,
        jobId: `bj_${crypto.randomUUID()}`,
        payloadFingerprint: 'a'.repeat(64),
        providerId: registration.providerId,
        status: 'awaiting_approval',
      },
      ownerLabel: 'ses_parent_a',
      type: 'provider_job',
      ...overrides,
    };
  };
  return {
    connection,
    delivery,
    dispatch,
    enqueue: (message: Delivery) => {
      queued.set(message.job.jobId, message);
      rows.set(message.job.jobId, { ...message.job, status: 'queued' });
      snapshot();
    },
    events,
    heartbeatTimes,
    outbound,
    renew,
    rows,
    send,
    setApprovalAck: (value: boolean) => {
      acknowledgeApproval = value;
    },
    setFence: (value: Fence) => {
      fence = value;
    },
    setHeartbeatAck: (value: boolean) => {
      acknowledgeHeartbeat = value;
    },
    setState,
    setTerminalAck: (value: boolean) => {
      acknowledgeTerminal = value;
    },
    settle,
    snapshot,
  };
};
const setup = async (enabled = true, supportsLocks = true) => {
  const transport = relay();
  const coordinator = createBrowserExecutionCoordinator({
    locks: supportsLocks ? (nativeLocks as LockManager) : undefined,
    storageArea: storage,
  });
  const runtime = createBrowserTaskProviderRuntime({
    auth,
    connection: transport.connection,
    coordinator,
    organizationId: 'org-approved',
    storageArea: storage,
    supportsImages: () => true,
  });
  runtimes.push(runtime);
  await runtime.start();
  if (enabled && supportsLocks) {
    await runtime.setSettings(defaults);
  }
  return { coordinator, runtime, transport };
};
const waitForConsent = async (runtime: BrowserTaskProviderRuntime) => {
  await waitFor(() => {
    expect(runtime.getSnapshot().phase).toBe('awaiting_approval');
  });
};
const waitForDone = async (runtime: BrowserTaskProviderRuntime) => {
  await waitFor(() => {
    expect(runtime.getSnapshot().active).toBeUndefined();
  });
};

describe('enabled browser provider owner', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    fixture.actions = [];
    fixture.writes = [];
    fixture.failWrite = '';
    fixture.values.clear();
    fixture.values.set(AUTH_STORAGE_KEY, auth);
    fixture.tabs = [
      { id: 7, title: 'Approved tab', url: 'https://example.test/task' },
      { id: 8, title: 'Other tab', url: 'https://other.test/' },
    ];
    fixture.turn = async (context, events) => {
      context.executionGuard();
      fixture.actions.push(
        `run:${context.selectedTab.id}:${events.filter(event => event.type === 'message' && event.role === 'user').length}`
      );
      context.appendEvents([createAssistantMessage('Observed the requested page.')]);
      return outcome();
    };
    getDefaultStore().set(pendingApprovalAtom, undefined);
    getDefaultStore().set(pendingLockAtom, false);
  });
  afterEach(async () => {
    await Promise.all(localLeases.splice(0).map(lease => lease.release()));
    await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fixture.watchers.clear();
    fixture.removed.clear();
    fixture.permissions.clear();
    fixture.updated.clear();
  });

  it('stays disabled with an empty queue until a model is explicitly selected', async () => {
    const { runtime, transport } = await setup(false);
    expect(runtime.getSnapshot()).toMatchObject({
      active: undefined,
      jobs: [],
      phase: 'disabled',
      settings: { enabled: false, mode: 'safe', model: '' },
    });
    await runtime.setSettings({ ...defaults, model: '' });
    expect(runtime.getSnapshot()).toMatchObject({
      message: expect.stringContaining('Select a model'),
      retryable: false,
    });
    expect(transport.outbound).toHaveLength(0);
    expect(fixture.actions).toStrictEqual([]);
  });

  it('keeps a competing panel away from profile proof and delegated work', async () => {
    const first = await setup();
    const writes = [...fixture.writes];
    const second = await setup(false);
    expect(second.runtime.getSnapshot()).toMatchObject({
      message: expect.stringContaining('Another panel'),
      phase: 'owned_elsewhere',
      profile: undefined,
    });
    expect(fixture.writes).toStrictEqual(writes);
    expect(second.transport.outbound).toStrictEqual([]);
    expect(JSON.stringify(first.runtime.getSnapshot())).not.toContain('providerProof');
  });

  it.each([
    { phase: 'unsupported', reason: 'unsupported', retryable: false },
    { phase: 'unavailable', reason: 'provider_unavailable', retryable: true },
  ] as const)('exposes $phase without a stale connecting state', async expected => {
    const { runtime, transport } = await setup();
    transport.setState({
      reason: expected.reason,
      retryable: expected.retryable,
      status: 'unavailable',
    });
    transport.send(transport.delivery());
    expect(runtime.getSnapshot()).toMatchObject({
      active: undefined,
      phase: expected.phase,
      retryable: expected.retryable,
    });
    expect(fixture.actions).toStrictEqual([]);
  });

  it('fails closed when native Web Locks are unavailable', async () => {
    const { runtime, transport } = await setup(false, false);
    expect(runtime.getSnapshot()).toMatchObject({
      message: expect.stringContaining('Web Locks'),
      phase: 'unsupported',
    });
    expect(fixture.values.has(BROWSER_PROVIDER_IDENTITY_KEY)).toBe(false);
    expect(transport.outbound).toStrictEqual([]);
  });

  it('persists consent, waits for relay running, and records history before result and quiescence', async () => {
    const { runtime, transport } = await setup();
    transport.setApprovalAck(false);
    const message = transport.delivery();
    transport.dispatch(message);
    await waitForConsent(runtime);
    expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({
      jobs: [{ approval: null, intent: { goal: message.goal } }],
    });
    await runtime.approve(message.job.jobId, 7);
    await waitFor(() => {
      expect(transport.outbound.some(frame => frame.type === 'provider_approval')).toBe(true);
    });
    expect(fixture.actions).toStrictEqual([]);
    expect(runtime.getSnapshot().active).toMatchObject({
      approval: {
        settings: {
          mode: 'safe',
          model: 'selected-model',
          organizationId: 'org-approved',
          thinkingEffort: 'high',
        },
        tab: { tabId: 7, title: 'Approved tab', url: 'https://example.test/task' },
      },
      goal: message.goal,
      ownerLabel: 'ses_parent_a',
    });
    transport.snapshot();
    await waitForDone(runtime);
    expect(fixture.actions).toStrictEqual(['run:7:1']);
    expect(runtime.getSnapshot()).toMatchObject({
      phase: 'idle',
      result: { evidence: [], status: 'succeeded', summary: 'Observed the requested page.' },
    });
    expect(transport.events.slice(-2)).toStrictEqual(['result', 'quiesced']);
    expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({
      histories: [{ events: [{ text: message.goal }, { text: 'Observed the requested page.' }] }],
    });
  });

  it('freezes settings at approval while local runs drain and never retargets an active tab', async () => {
    const { coordinator, runtime, transport } = await setup();
    const local = await coordinator.acquireLocal();
    if (!local.admitted) {
      throw new Error(local.reason);
    }
    localLeases.push(local.lease);
    const message = transport.delivery();
    transport.dispatch(message);
    await waitForConsent(runtime);
    await runtime.approve(message.job.jobId, 7);
    await waitFor(() => {
      expect(runtime.getSnapshot().phase).toBe('waiting');
    });
    await runtime.setSettings({
      ...defaults,
      mode: 'dangerous',
      model: 'later-model',
      thinkingEffort: 'low',
    });
    fixture.tabs.reverse();
    expect(runtime.getSnapshot().active?.approval?.settings).toMatchObject({
      mode: 'safe',
      model: 'selected-model',
      thinkingEffort: 'high',
    });
    expect(runtime.getSnapshot().active?.job.deadlines.approval).toBe(
      message.job.deadlines.approval
    );
    expect((await coordinator.acquireLocal()).admitted).toBe(false);
    await local.lease.release();
    await waitForDone(runtime);
    expect(fixture.actions).toStrictEqual(['run:7:1']);
    expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({
      jobs: [{ approval: { settings: { mode: 'safe', model: 'selected-model' } } }],
    });
  });

  it('looks up duplicates and continues only isolated browser history with fresh consent', async () => {
    const { runtime, transport } = await setup();
    fixture.values.set('local:kiloAgentConversations', {
      transcript: 'parent or local transcript must not enter',
    });
    const first = transport.delivery();
    transport.dispatch(first);
    await waitForConsent(runtime);
    transport.send(first);
    await runtime.approve(first.job.jobId, 7);
    await waitForDone(runtime);
    transport.send(first);
    await runtime.refreshStatus();
    const next = transport.delivery({ conversationMode: 'continue', goal: 'Read a follow-up.' });
    next.job.browserTaskId = first.job.browserTaskId;
    transport.dispatch(next);
    await waitForConsent(runtime);
    expect(runtime.getSnapshot().active?.approval).toBeUndefined();
    expect(fixture.actions).toStrictEqual(['run:7:1']);
    await runtime.approve(next.job.jobId, 8);
    await waitForDone(runtime);
    expect(fixture.actions).toStrictEqual(['run:7:1', 'run:8:2']);
    expect(JSON.stringify(fixture.values.get(BROWSER_TASK_STORAGE_KEY))).not.toContain(
      'parent or local transcript'
    );
  });

  it.each(['accept', 'approve', 'finish'] as const)(
    'does not announce unrecorded work when %s storage fails',
    async phase => {
      const { runtime, transport } = await setup();
      const message = transport.delivery();
      if (phase === 'accept') {
        fixture.failWrite = BROWSER_TASK_STORAGE_KEY;
      }
      transport.dispatch(message);
      if (phase !== 'accept') {
        await waitForConsent(runtime);
        if (phase === 'approve') {
          fixture.failWrite = BROWSER_TASK_STORAGE_KEY;
        }
        if (phase === 'finish') {
          fixture.turn = async context => {
            fixture.actions.push('executed');
            context.appendEvents([createAssistantMessage('Not persisted')]);
            fixture.failWrite = BROWSER_TASK_STORAGE_KEY;
            return outcome();
          };
        }
        await runtime.approve(message.job.jobId, 7);
      }
      await waitForDone(runtime);
      expect(transport.outbound.filter(frame => frame.type === 'provider_result')).toStrictEqual(
        []
      );
      expect(fixture.actions).toStrictEqual(phase === 'finish' ? ['executed'] : []);
      expect(JSON.stringify(runtime.getSnapshot())).not.toContain('Private storage failure');
      expect(runtime.getSnapshot()).toMatchObject({
        message: expect.stringContaining('storage is unavailable'),
        retryable: true,
      });
      fixture.failWrite = '';
    }
  );

  it('cancels queued work with provider authority, without disturbing the active approval', async () => {
    const { runtime, transport } = await setup();
    const active = transport.delivery();
    transport.dispatch(active);
    await waitForConsent(runtime);
    const queued = { ...transport.delivery().job, status: 'queued' as const };
    transport.rows.set(queued.jobId, queued);
    transport.snapshot();
    runtime.cancel(queued.jobId);
    expect(runtime.getSnapshot().active?.job.jobId).toBe(active.job.jobId);
    expect(transport.rows.get(queued.jobId)?.status).toBe('cancelled');
    expect(transport.outbound.filter(frame => frame.type === 'provider_cancel')).toMatchObject([
      { generation: queued.generation, jobId: queued.jobId, providerId: queued.providerId },
    ]);
    expect(
      JSON.stringify(transport.outbound.filter(frame => frame.type === 'provider_cancel'))
    ).not.toContain('capability');
    expect(fixture.actions).toStrictEqual([]);
  });

  it('cancels a pending memory approval and prevents any later agent action or stale save', async () => {
    const { runtime, transport } = await setup();
    fixture.turn = async context => {
      await context.requestApproval('memory', {
        createdAt: Date.now(),
        pageTitle: 'Approved tab',
        pageUrl: 'https://example.test/task',
        text: 'A memory',
      });
      context.executionGuard();
      fixture.actions.push('after approval');
      return outcome();
    };
    const message = transport.delivery();
    transport.dispatch(message);
    await waitForConsent(runtime);
    await runtime.approve(message.job.jobId, 7);
    await waitFor(() => {
      expect(getDefaultStore().get(pendingApprovalAtom)?.kind).toBe('memory');
    });
    const pending = getDefaultStore().get(pendingApprovalAtom);
    if (pending === undefined) {
      throw new Error('Missing approval');
    }
    runtime.cancel(message.job.jobId);
    await waitForDone(runtime);
    expect(
      (await applyApprovalDecision(storage, 'memory', pending.draft, true, pending)).status
    ).toBe('aborted');
    expect(fixture.actions).toStrictEqual([]);
    expect(getDefaultStore().get(pendingApprovalAtom)).toBeUndefined();
    expect(fixture.values.has('local:kiloAgentMemories')).toBe(false);
    expect(runtime.getSnapshot().result?.status).toBe('cancelled');
  });

  it('waits for an issued action to unwind after Stop and keeps uncertain execution quarantined', async () => {
    const { coordinator, runtime, transport } = await setup();
    const gate = Promise.withResolvers<void>();
    fixture.turn = async context => {
      context.executionGuard();
      fixture.actions.push('issued');
      await gate.promise;
      context.executionGuard();
      fixture.actions.push('subsequent');
      return outcome();
    };
    const message = transport.delivery();
    transport.dispatch(message);
    await waitForConsent(runtime);
    await runtime.approve(message.job.jobId, 7);
    await waitFor(() => {
      expect(fixture.actions).toStrictEqual(['issued']);
    });
    runtime.cancel(message.job.jobId);
    expect((await coordinator.acquireLocal()).admitted).toBe(false);
    expect(transport.events).not.toContain('quiesced');
    gate.resolve();
    await waitForDone(runtime);
    expect(fixture.actions).toStrictEqual(['issued']);
    expect(runtime.getSnapshot().result).toMatchObject({
      effectsUncertain: true,
      status: 'cancelled',
    });
    expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
    expect((await coordinator.acquireLocal()).admitted).toBe(false);
    expect(transport.events).not.toContain('quiesced');
  });

  describe('recovery preparation', () => {
    it('prepares a withdrawn profile without restoring cached proof or execution authority', async () => {
      const { coordinator, runtime, transport } = await setup();
      const admission = await coordinator.acquireLocal();
      if (!admission.admitted) {
        throw new Error(admission.reason);
      }
      localLeases.push(admission.lease);
      await admission.lease.quarantine(8);
      await admission.lease.release();
      await waitFor(() => {
        expect(runtime.getSnapshot().phase).toBe('recovery');
      });
      await expect(transport.connection.requestBrowserProviderStatus()).rejects.toThrow(
        'provider_unavailable'
      );
      fixture.tabs = fixture.tabs.filter(tab => tab.id !== 8);
      const previous = structuredClone(runtime.getSnapshot());
      const safety = structuredClone(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY));
      const persisted = structuredClone(fixture.values.get(BROWSER_TASK_STORAGE_KEY));
      const outbound = structuredClone(transport.outbound);
      const writes = [...fixture.writes];

      await expect(runtime.prepareRecovery()).resolves.toMatchObject({ ready: true });
      await expect(transport.connection.requestBrowserProviderStatus()).rejects.toThrow(
        'provider_unavailable'
      );
      expect(transport.connection.getBrowserProviderState().status).toBe('unavailable');
      expect(runtime.getSnapshot()).toStrictEqual(previous);
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(safety);
      expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(persisted);
      expect(fixture.writes).toStrictEqual(writes);
      expect(transport.outbound).toStrictEqual(outbound);
      expect((await coordinator.acquireLocal()).admitted).toBe(false);
      expect(fixture.actions).toStrictEqual([]);
    });

    it.each([undefined, 0, 7])(
      'reports a closed, drained fence with tab %s without recovering or changing results',
      async tabId => {
        const { coordinator, runtime, transport } = await setup();
        const message = transport.delivery();
        transport.dispatch(message);
        await waitForConsent(runtime);
        await runtime.approve(message.job.jobId, 7);
        await waitForDone(runtime);
        const fence: Fence = {
          invocationId: `b1.${Date.now() - 700_000_000}.${'b'.repeat(64)}`,
          ...(tabId === undefined ? {} : { tabId }),
        };
        transport.setFence(fence);
        transport.setState({
          reason: 'provider_unavailable',
          retryable: true,
          status: 'unavailable',
        });
        const safety = { allTabs: true, tabIds: [0, 7], version: 1 };
        fixture.values.set(BROWSER_EXECUTION_SAFETY_KEY, safety);
        fixture.tabs = [];
        await coordinator.refresh();
        const persisted = structuredClone(fixture.values.get(BROWSER_TASK_STORAGE_KEY));
        const result = structuredClone(runtime.getSnapshot().result);
        const outbound = structuredClone(transport.outbound);
        const writes = [...fixture.writes];

        await expect(runtime.prepareRecovery()).resolves.toMatchObject({
          ready: true,
          reason: expect.stringContaining('Recover explicitly'),
        });
        await expect(runtime.prepareRecovery()).resolves.toMatchObject({ ready: true });
        expect(runtime.getSnapshot()).toMatchObject({
          active: undefined,
          phase: 'recovery',
          result,
        });
        await expect(runtime.refreshStatus()).resolves.toStrictEqual(fence);
        expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(safety);
        expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(persisted);
        expect(fixture.writes).toStrictEqual(writes);
        expect(transport.outbound).toStrictEqual(outbound);
        expect(fixture.actions).toStrictEqual(['run:7:1']);
        expect((await coordinator.acquireLocal()).admitted).toBe(false);
      }
    );

    it('cannot prepare while an active task still awaits consent', async () => {
      const { runtime, transport } = await setup();
      transport.dispatch(transport.delivery());
      await waitForConsent(runtime);
      const previous = runtime.getSnapshot();
      const outbound = structuredClone(transport.outbound);
      const persisted = structuredClone(fixture.values.get(BROWSER_TASK_STORAGE_KEY));
      await expect(runtime.prepareRecovery()).resolves.toMatchObject({
        ready: false,
        reason: expect.stringContaining('unwinding'),
      });
      expect(runtime.getSnapshot()).toStrictEqual(previous);
      expect(transport.outbound).toStrictEqual(outbound);
      expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(persisted);
      expect(fixture.actions).toStrictEqual([]);
    });

    it('keeps an empty provider empty without creating recovery authority', async () => {
      const { runtime, transport } = await setup();
      const previous = runtime.getSnapshot();
      const writes = [...fixture.writes];
      const outbound = structuredClone(transport.outbound);
      await expect(runtime.prepareRecovery()).resolves.toMatchObject({ ready: true });
      expect(runtime.getSnapshot()).toStrictEqual(previous);
      expect(fixture.writes).toStrictEqual(writes);
      expect(transport.outbound).toStrictEqual(outbound);
      expect(fixture.actions).toStrictEqual([]);
    });

    it.each([
      { kind: 'remote zero', openId: 0, reason: 'Close the affected tab', tabId: 0, tabIds: [] },
      {
        kind: 'remote uninspectable',
        openId: 7,
        reason: 'Close the affected tab',
        tabId: 7,
        tabIds: [],
      },
      {
        kind: 'local zero',
        openId: 0,
        reason: 'Close all affected tabs',
        tabId: undefined,
        tabIds: [0],
      },
      {
        kind: 'allTabs',
        openId: 8,
        reason: 'Close all target tabs',
        tabId: undefined,
        tabIds: [7],
      },
      { kind: 'allTabs', openId: 0, reason: 'Close all target tabs', tabId: undefined, tabIds: [] },
    ])('blocks an open $kind tab outside the inspectable inventory', async testCase => {
      const { coordinator, runtime, transport } = await setup();
      const fence: Fence = {
        invocationId: `b1.${Date.now() - 700_000_000}.${'c'.repeat(64)}`,
        ...(testCase.tabId === undefined ? {} : { tabId: testCase.tabId }),
      };
      transport.setFence(fence);
      const safety = {
        ...(testCase.kind === 'allTabs' ? { allTabs: true } : {}),
        tabIds: testCase.tabIds,
        version: 1,
      };
      fixture.values.set(BROWSER_EXECUTION_SAFETY_KEY, safety);
      fixture.tabs = [{ id: testCase.openId, title: 'Uninspectable', url: 'chrome://settings' }];
      await coordinator.refresh();
      const outbound = structuredClone(transport.outbound);
      await expect(runtime.prepareRecovery()).resolves.toMatchObject({
        ready: false,
        reason: expect.stringContaining(testCase.reason),
      });
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(safety);
      await expect(runtime.refreshStatus()).resolves.toStrictEqual(fence);
      expect(transport.outbound).toStrictEqual(outbound);
      expect(fixture.actions).toStrictEqual([]);
    });

    it('retrieves a fresh fence instead of reusing a status request that predates preparation', async () => {
      const { runtime, transport } = await setup();
      const requested = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const status = transport.connection.requestBrowserProviderStatus;
      const spy = vi
        .spyOn(transport.connection, 'requestBrowserProviderStatus')
        .mockImplementationOnce(async () => {
          const page = await status();
          requested.resolve();
          await resume.promise;
          return page;
        });
      const retrieving = runtime.refreshStatus();
      await requested.promise;
      const fence = { invocationId: `b1.${Date.now()}.${'f'.repeat(64)}`, tabId: 0 };
      transport.setFence(fence);
      fixture.tabs = [{ id: 0, title: 'Affected tab', url: 'chrome://settings' }];
      const preparing = runtime.prepareRecovery();
      try {
        resume.resolve();
        await retrieving;
        await expect(preparing).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('Close the affected tab'),
        });
        expect(runtime.getSnapshot().unresolvedFence).toStrictEqual(fence);
        expect(transport.events).not.toContain('recovered');
        expect(fixture.actions).toStrictEqual([]);
      } finally {
        resume.resolve();
        await retrieving;
        await preparing;
        spy.mockRestore();
      }
    });

    it('enumerates again under the native lock instead of reusing the preflight tab list', async () => {
      const { coordinator, runtime, transport } = await setup();
      transport.setFence({ invocationId: `b1.${Date.now()}.${'d'.repeat(64)}`, tabId: 0 });
      fixture.tabs = [];
      const prepare = coordinator.prepareRecovery;
      const spy = vi.spyOn(coordinator, 'prepareRecovery').mockImplementationOnce(getTabs => {
        fixture.tabs = [{ id: 0, title: 'Affected tab', url: 'chrome://settings' }];
        return prepare(getTabs);
      });
      try {
        await expect(runtime.prepareRecovery()).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('Close the affected tab'),
        });
        expect(transport.events).not.toContain('recovered');
        expect(fixture.actions).toStrictEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      { code: 'provider_unavailable', guidance: 'Reopen the signed-in panel', retryable: true },
      { code: 'request_timeout', guidance: 'Reconnect and retrieve status', retryable: true },
      { code: 'permission_denied', guidance: 'Restore provider access', retryable: false },
    ] as const)('fails closed on $code status without probing registration', async failure => {
      const { runtime, transport } = await setup();
      const previous = runtime.getSnapshot();
      const outbound = structuredClone(transport.outbound);
      const writes = [...fixture.writes];
      transport.connection.requestBrowserProviderStatus = async () => {
        throw new BrowserProviderError(failure.code, failure.retryable);
      };
      await expect(runtime.prepareRecovery()).resolves.toMatchObject({
        ready: false,
        reason: expect.stringContaining(failure.guidance),
      });
      expect(runtime.getSnapshot()).toStrictEqual(previous);
      expect(transport.outbound).toStrictEqual(outbound);
      expect(fixture.writes).toStrictEqual(writes);
      expect(fixture.actions).toStrictEqual([]);
    });

    it('rejects a foreign provider on a later status page before tab or safety preparation', async () => {
      const { runtime, transport } = await setup();
      const { providerId } = transport.delivery().job;
      transport.connection.requestBrowserProviderStatus = async (cursor?: string) => ({
        jobs: [],
        providerId: cursor === undefined ? providerId : `bp_${crypto.randomUUID()}`,
        requestId: crypto.randomUUID(),
        type: 'provider_status_result',
        ...(cursor === undefined ? { nextCursor: 'next' } : {}),
      });
      const writes = [...fixture.writes];
      const outbound = structuredClone(transport.outbound);
      await expect(runtime.prepareRecovery()).resolves.toMatchObject({
        ready: false,
        reason: expect.stringContaining('owning signed-in panel'),
      });
      expect(transport.outbound).toStrictEqual(outbound);
      expect(fixture.writes).toStrictEqual(writes);
      expect(fixture.actions).toStrictEqual([]);
    });

    it.each(['tabs', 'storage'] as const)(
      'returns concrete guidance for failed %s access',
      async failed => {
        const { runtime, transport } = await setup();
        const tabs = await browser.tabs.query({});
        const tabsApi: {
          query: (queryInfo: Parameters<typeof browser.tabs.query>[0]) => Promise<typeof tabs>;
        } = browser.tabs;
        const storageApi = storage as { getItem: (key: string) => unknown };
        const { getItem } = storageApi;
        const query = vi.spyOn(tabsApi, 'query');
        const read = vi.spyOn(storageApi, 'getItem');
        if (failed === 'tabs') {
          query.mockRejectedValueOnce(new Error('Private browser error'));
        } else {
          read.mockImplementation(key => {
            if (key === BROWSER_EXECUTION_SAFETY_KEY) {
              throw new Error('Private storage error');
            }
            return getItem(key);
          });
        }
        try {
          const readiness = await runtime.prepareRecovery();
          expect(readiness).toMatchObject({
            ready: false,
            reason: expect.stringContaining(
              failed === 'tabs' ? 'Restore browser tab access' : 'Restore storage'
            ),
          });
          expect(readiness.reason).not.toContain('Private');
          expect(transport.events).not.toContain('recovered');
          expect(fixture.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
          expect(fixture.actions).toStrictEqual([]);
        } finally {
          query.mockRestore();
          read.mockRestore();
        }
      }
    );

    it.each(['disabled', 'disposed', 'unsupported'] as const)(
      'cannot prepare a %s provider',
      async state => {
        const { runtime, transport } = await setup(state !== 'disabled', state !== 'unsupported');
        if (state === 'disposed') {
          await runtime.dispose();
        }
        const outbound = structuredClone(transport.outbound);
        const writes = [...fixture.writes];
        const guidance = {
          disabled: 'Enable CLI tasks',
          disposed: 'Reopen the signed-in panel',
          unsupported: 'Restore browser Web Locks support',
        };
        await expect(runtime.prepareRecovery()).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining(guidance[state]),
        });
        expect(transport.outbound).toStrictEqual(outbound);
        expect(fixture.writes).toStrictEqual(writes);
        expect(fixture.actions).toStrictEqual([]);
      }
    );

    it('rejects a released provider owner after status retrieval starts', async () => {
      const transport = relay();
      const coordinator = createBrowserExecutionCoordinator({
        locks: nativeLocks as LockManager,
        storageArea: storage,
      });
      const owner = await coordinator.acquireProviderOwner();
      if (!owner.admitted) {
        throw new Error(owner.reason);
      }
      const runtime = createBrowserTaskProviderRuntime({
        auth,
        connection: transport.connection,
        coordinator: { ...coordinator, acquireProviderOwner: async () => owner },
        organizationId: 'org-approved',
        storageArea: storage,
      });
      runtimes.push(runtime);
      await runtime.start();
      await runtime.setSettings(defaults);
      const requested = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const status = transport.connection.requestBrowserProviderStatus;
      transport.connection.requestBrowserProviderStatus = async () => {
        const page = await status();
        requested.resolve();
        await resume.promise;
        return page;
      };
      const preparing = runtime.prepareRecovery();
      try {
        await requested.promise;
        await owner.lease.release();
        resume.resolve();
        await expect(preparing).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('Use the owning panel'),
        });
        expect(fixture.actions).toStrictEqual([]);
        expect(transport.events).not.toContain('recovered');
      } finally {
        resume.resolve();
        await preparing;
      }
    });

    it.each([
      { operation: 'registration', response: 'page' },
      { operation: 'registration', response: 'failure' },
      { operation: 'recovery', response: 'page' },
      { operation: 'recovery', response: 'failure' },
      { operation: 'recovery registration', response: 'page' },
      { operation: 'recovery registration', response: 'failure' },
      { operation: 'recovery bootstrap', response: 'page' },
      { operation: 'recovery bootstrap', response: 'failure' },
    ] as const)(
      'does not publish stale $operation status $response into a changed account',
      async ({ operation, response }) => {
        const { runtime, transport } = await setup();
        if (operation === 'registration') {
          await runtime.setSettings({ ...defaults, enabled: false });
        }
        const paused = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const status = transport.connection.requestBrowserProviderStatus;
        const spy = vi.spyOn(transport.connection, 'requestBrowserProviderStatus');
        if (operation === 'recovery registration') {
          spy.mockImplementationOnce(status);
        } else if (operation === 'recovery bootstrap') {
          spy.mockRejectedValueOnce(new BrowserProviderError('provider_unavailable', true));
        }
        spy.mockImplementationOnce(async () => {
          const page = await status();
          const staleJob = transport.delivery().job;
          paused.resolve();
          await resume.promise;
          if (response === 'failure') {
            throw new BrowserProviderError('disconnected', true);
          }
          return {
            ...page,
            jobs: [staleJob],
            unresolvedFence: { invocationId: staleJob.invocationId, tabId: 0 },
          };
        });
        const pending =
          operation === 'registration' ? runtime.setSettings(defaults) : runtime.recover();
        try {
          await paused.promise;
          await storage.setItem(AUTH_STORAGE_KEY, {
            token: 'other-token',
            userEmail: 'other@example.test',
          });
          const previous = structuredClone(runtime.getSnapshot());
          const outbound = structuredClone(transport.outbound);
          const persisted = structuredClone(fixture.values.get(BROWSER_TASK_STORAGE_KEY));
          resume.resolve();
          await pending;
          expect(runtime.getSnapshot()).toStrictEqual(previous);
          expect(transport.outbound).toStrictEqual(outbound);
          expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(persisted);
          expect(fixture.actions).toStrictEqual([]);
        } finally {
          resume.resolve();
          await pending;
          spy.mockRestore();
        }
      }
    );

    describe.each(['registration', 'recovery registration', 'recovery bootstrap'] as const)(
      'pending %s lifetime',
      operation => {
        it.each([
          { change: 'auth', response: 'success', stage: 'request' },
          { change: 'auth', response: 'failure', stage: 'request' },
          { change: 'auth', response: 'success', stage: 'coordinator refresh' },
          { change: 'auth', response: 'failure', stage: 'coordinator refresh' },
          { change: 'dispose', response: 'success', stage: 'coordinator refresh' },
          { change: 'dispose', response: 'failure', stage: 'coordinator refresh' },
        ] as const)(
          'ignores delayed $stage $response after $change without withdrawing a replacement',
          async ({ change, response, stage }) => {
            const { coordinator, runtime, transport } = await setup();
            if (operation === 'registration') {
              await runtime.setSettings({ ...defaults, enabled: false });
            }
            const paused = Promise.withResolvers<void>();
            const resume = Promise.withResolvers<void>();
            const pause = async () => {
              paused.resolve();
              await resume.promise;
              if (response === 'failure') {
                throw new BrowserProviderError('permission_denied', false);
              }
            };
            const register = transport.connection.registerBrowserProvider;
            const { refresh } = coordinator;
            const spy =
              stage === 'request'
                ? vi
                    .spyOn(transport.connection, 'registerBrowserProvider')
                    .mockImplementationOnce(async input => {
                      const lease = await register(input);
                      await pause();
                      return lease;
                    })
                : vi.spyOn(coordinator, 'refresh').mockImplementationOnce(async () => {
                    await refresh();
                    await pause();
                  });
            const statusSpy =
              operation === 'recovery bootstrap'
                ? vi
                    .spyOn(transport.connection, 'requestBrowserProviderStatus')
                    .mockRejectedValueOnce(new BrowserProviderError('provider_unavailable', true))
                : undefined;
            const pending =
              operation === 'registration' ? runtime.setSettings(defaults) : runtime.recover();
            try {
              await paused.promise;
              if (change === 'dispose') {
                await runtime.dispose();
              } else {
                await storage.setItem(AUTH_STORAGE_KEY, {
                  token: 'other-token',
                  userEmail: 'other@example.test',
                });
                const previousRegistration = transport.outbound.findLast(
                  frame => frame.type === 'provider_register'
                );
                if (previousRegistration === undefined) {
                  throw new Error('Missing registration');
                }
                // A replacement provider must survive the old registration's completion.
                await register({
                  generation: previousRegistration.generation + 1,
                  label: previousRegistration.label,
                  providerId: previousRegistration.providerId,
                  providerProof: previousRegistration.providerProof,
                });
                fixture.values.set(BROWSER_EXECUTION_SAFETY_KEY, { tabIds: [8], version: 1 });
                await refresh();
              }
              const previous = structuredClone(runtime.getSnapshot());
              const providerState = structuredClone(transport.connection.getBrowserProviderState());
              const outbound = structuredClone(transport.outbound);
              const persisted = structuredClone(fixture.values.get(BROWSER_TASK_STORAGE_KEY));
              const safety = structuredClone(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY));
              resume.resolve();
              await pending;
              expect(runtime.getSnapshot()).toStrictEqual(previous);
              expect(transport.connection.getBrowserProviderState()).toStrictEqual(providerState);
              expect(transport.outbound).toStrictEqual(outbound);
              expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(persisted);
              expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(safety);
              expect(fixture.actions).toStrictEqual([]);
            } finally {
              resume.resolve();
              await pending;
              spy.mockRestore();
              statusSpy?.mockRestore();
            }
          }
        );
      }
    );

    it('keeps preparation valid across a matching lease renewal', async () => {
      const { coordinator, runtime, transport } = await setup();
      const paused = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const prepare = coordinator.prepareRecovery;
      const spy = vi.spyOn(coordinator, 'prepareRecovery').mockImplementationOnce(async getTabs => {
        const readiness = await prepare(getTabs);
        paused.resolve();
        await resume.promise;
        return readiness;
      });
      const preparing = runtime.prepareRecovery();
      try {
        await paused.promise;
        transport.renew();
        const previous = structuredClone(runtime.getSnapshot());
        const outbound = structuredClone(transport.outbound);
        resume.resolve();
        await expect(preparing).resolves.toMatchObject({ ready: true });
        expect(runtime.getSnapshot()).toStrictEqual(previous);
        expect(transport.outbound).toStrictEqual(outbound);
        expect(fixture.actions).toStrictEqual([]);
      } finally {
        resume.resolve();
        await preparing;
        spy.mockRestore();
      }
    });

    describe.each(['status', 'later status page', 'tabs', 'coordinator'] as const)(
      'pending %s completion',
      stage => {
        it.each([
          'invocation',
          'finished invocation',
          'disable',
          'auth',
          'organization',
          'dispose',
          'generation',
          'provider binding',
          'disconnect',
          'reconnect',
        ] as const)('cannot report ready or change a newer state after %s', async change => {
          const { coordinator, runtime, transport } = await setup();
          const retainedFence = { invocationId: `b1.${Date.now()}.${'e'.repeat(64)}` };
          const queued: BrowserJobSnapshot = {
            ...transport.delivery().job,
            ownerLabel: 'ses_parent_old',
            queuePosition: 1,
            status: 'queued',
          };
          transport.rows.set(queued.jobId, queued);
          transport.setFence(retainedFence);
          if (change === 'disconnect' || change === 'reconnect') {
            transport.setState({
              reason: 'provider_unavailable',
              retryable: true,
              status: 'unavailable',
            });
          }
          await runtime.refreshStatus();
          const paused = Promise.withResolvers<void>();
          const resume = Promise.withResolvers<void>();
          const pause = async () => {
            paused.resolve();
            await resume.promise;
          };
          if (stage === 'status' || stage === 'later status page') {
            const status = transport.connection.requestBrowserProviderStatus;
            const staleJob = transport.delivery().job;
            vi.spyOn(transport.connection, 'requestBrowserProviderStatus').mockImplementation(
              async (cursor?: string) => {
                const page = await status();
                if (stage === 'later status page' && cursor === undefined) {
                  return { ...page, jobs: [], nextCursor: 'next' };
                }
                await pause();
                return {
                  ...page,
                  jobs: [...page.jobs, staleJob],
                  unresolvedFence: { invocationId: staleJob.invocationId, tabId: 0 },
                };
              }
            );
          } else if (stage === 'tabs') {
            const tabs = await browser.tabs.query({});
            const tabsApi: {
              query: (queryInfo: Parameters<typeof browser.tabs.query>[0]) => Promise<typeof tabs>;
            } = browser.tabs;
            vi.spyOn(tabsApi, 'query').mockImplementationOnce(async () => {
              await pause();
              return tabs;
            });
          } else {
            const prepare = coordinator.prepareRecovery;
            vi.spyOn(coordinator, 'prepareRecovery').mockImplementationOnce(async getTabs => {
              const readiness = await prepare(getTabs);
              await pause();
              return readiness;
            });
          }
          const preparing = runtime.prepareRecovery();
          try {
            await paused.promise;
            transport.rows.set(queued.jobId, {
              ...queued,
              ownerLabel: 'ses_parent_new',
              queuePosition: 2,
            });
            transport.snapshot();
            if (change === 'invocation' || change === 'finished invocation') {
              const message = transport.delivery();
              transport.dispatch(message);
              await waitForConsent(runtime);
              if (change === 'finished invocation') {
                runtime.reject(message.job.jobId);
                await waitForDone(runtime);
              }
            } else if (change === 'disable') {
              await runtime.setSettings({ ...defaults, enabled: false });
            } else if (change === 'auth') {
              await storage.setItem(AUTH_STORAGE_KEY, {
                token: 'other-token',
                userEmail: 'other@example.test',
              });
            } else if (change === 'organization') {
              await storage.setItem('local:kiloSelectedOrganizationId', 'other-org');
            } else if (change === 'dispose') {
              await runtime.dispose();
            } else if (change === 'disconnect' || change === 'reconnect') {
              transport.setState({ status: 'disconnected' });
              if (change === 'reconnect') {
                transport.setState({ status: 'negotiating' });
                transport.setState({
                  reason: 'provider_unavailable',
                  retryable: true,
                  status: 'unavailable',
                });
              }
            } else {
              const state = transport.connection.getBrowserProviderState();
              if (state.status !== 'registered') {
                throw new Error('Expected a registered provider');
              }
              transport.setState({
                ...state,
                lease: {
                  ...state.lease,
                  ...(change === 'generation'
                    ? { generation: state.lease.generation + 1 }
                    : { providerId: `bp_${crypto.randomUUID()}` }),
                },
              });
            }
            const previous = structuredClone(runtime.getSnapshot());
            const outbound = structuredClone(transport.outbound);
            const persisted = structuredClone(fixture.values.get(BROWSER_TASK_STORAGE_KEY));
            const safety = structuredClone(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY));
            resume.resolve();
            await expect(preparing).resolves.toMatchObject({
              ready: false,
              reason: expect.stringMatching(/Wait|Enable|Reopen/u),
            });
            expect(runtime.getSnapshot()).toStrictEqual(previous);
            expect(runtime.getSnapshot().unresolvedFence).toStrictEqual(retainedFence);
            expect(transport.outbound).toStrictEqual(outbound);
            expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(persisted);
            expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(safety);
            expect(fixture.actions).toStrictEqual([]);
          } finally {
            resume.resolve();
            await preparing;
            vi.restoreAllMocks();
          }
        });
      }
    );

    it('retries only eligible failed releases after successful status without clearing the fence', async () => {
      const { coordinator, runtime, transport } = await setup();
      const admission = await coordinator.acquireLocal();
      if (!admission.admitted) {
        throw new Error(admission.reason);
      }
      localLeases.push(admission.lease);
      const resume = Promise.withResolvers<void>();
      const work = admission.lease.run(() => resume.promise);
      fixture.failWrite = BROWSER_EXECUTION_SAFETY_KEY;
      await expect(admission.lease.quarantine(7)).rejects.toThrow('Private storage failure');
      await expect(admission.lease.release()).rejects.toThrow('Private storage failure');
      fixture.tabs = [];
      const status = transport.connection.requestBrowserProviderStatus;
      try {
        fixture.failWrite = '';
        transport.connection.requestBrowserProviderStatus = async () => {
          throw new BrowserProviderError('provider_unavailable', true);
        };
        await expect(runtime.prepareRecovery()).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('Reopen the signed-in panel'),
        });
        expect(fixture.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
        transport.connection.requestBrowserProviderStatus = status;
        await expect(runtime.prepareRecovery()).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('unwinding'),
        });
        expect(fixture.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
        expect(
          (await nativeLocks.query()).held?.some(lock => lock.name === BROWSER_EXECUTION_LOCK)
        ).toBe(true);
        resume.resolve();
        await work;
        transport.setFence({ invocationId: `b1.${Date.now()}.${'a'.repeat(64)}`, tabId: 0 });
        fixture.tabs = [{ id: 0, title: 'Affected tab', url: 'chrome://settings' }];
        await expect(runtime.prepareRecovery()).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('Close the affected tab'),
        });
        expect(fixture.values.has(BROWSER_EXECUTION_SAFETY_KEY)).toBe(false);
        fixture.tabs = [];
        fixture.failWrite = BROWSER_EXECUTION_SAFETY_KEY;
        await expect(runtime.prepareRecovery()).resolves.toMatchObject({
          ready: false,
          reason: expect.stringContaining('Restore storage'),
        });
        fixture.failWrite = '';
        const outbound = structuredClone(transport.outbound);
        await expect(runtime.prepareRecovery()).resolves.toMatchObject({ ready: true });
        expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
          tabIds: [7],
          version: 1,
        });
        expect(
          (await nativeLocks.query()).held?.some(lock => lock.name === BROWSER_EXECUTION_LOCK)
        ).toBe(false);
        expect((await coordinator.acquireLocal()).admitted).toBe(false);
        expect(transport.outbound).toStrictEqual(outbound);
        expect(fixture.actions).toStrictEqual([]);
      } finally {
        fixture.failWrite = '';
        transport.connection.requestBrowserProviderStatus = status;
        resume.resolve();
        await work;
        await coordinator.prepareRecovery(async () => []);
      }
    });

    it.each(['remote tab', 'allTabs', 'execution lock', 'status', 'disable'] as const)(
      'rechecks %s during actual recovery after a ready result',
      async change => {
        const { coordinator, runtime, transport } = await setup();
        transport.setFence({ invocationId: `b1.${Date.now()}.${'e'.repeat(64)}`, tabId: 7 });
        fixture.tabs = [];
        await expect(runtime.prepareRecovery()).resolves.toMatchObject({ ready: true });
        if (change === 'remote tab') {
          fixture.tabs = [{ id: 7, title: 'Affected', url: 'chrome://settings' }];
        } else if (change === 'allTabs') {
          fixture.values.set(BROWSER_EXECUTION_SAFETY_KEY, {
            allTabs: true,
            tabIds: [],
            version: 1,
          });
          fixture.tabs = [{ id: 8, title: 'Other', url: 'chrome://settings' }];
        } else if (change === 'execution lock') {
          const local = await coordinator.acquireLocal();
          if (!local.admitted) {
            throw new Error(local.reason);
          }
          localLeases.push(local.lease);
        } else if (change === 'status') {
          transport.connection.requestBrowserProviderStatus = async () => {
            throw new BrowserProviderError('permission_denied', false);
          };
        } else {
          await runtime.setSettings({ ...defaults, enabled: false });
        }
        const safety = structuredClone(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY));
        await runtime.recover();
        expect(transport.events).not.toContain('recovered');
        expect(
          transport.outbound.filter(
            frame => frame.type === 'provider_register' && frame.recovery !== undefined
          )
        ).toStrictEqual([]);
        expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(safety);
        expect(fixture.actions).toStrictEqual([]);
      }
    );
  });

  it.each([undefined, 7])(
    'recovers an expired fence with tab %s by status, closure, and a fresh generation',
    async tabId => {
      const { runtime, transport } = await setup();
      const fence: Fence = {
        invocationId: `b1.${Date.now() - 700_000_000}.${'b'.repeat(64)}`,
        ...(tabId === undefined ? {} : { tabId }),
      };
      transport.setFence(fence);
      transport.setState({
        reason: 'provider_unavailable',
        retryable: true,
        status: 'unavailable',
      });
      if (tabId !== undefined) {
        const bound = fixture.tabs.find(tab => tab.id === tabId);
        if (bound === undefined) {
          throw new Error('Missing affected tab');
        }
        bound.url = 'chrome://settings';
        await runtime.recover();
        expect(transport.events).not.toContain('recovered');
        fixture.tabs = fixture.tabs.filter(tab => tab.id !== tabId);
      }
      await runtime.recover();
      expect(transport.events.indexOf('status')).toBeLessThan(
        transport.events.indexOf('recovered')
      );
      expect(
        transport.outbound.findLast(frame => frame.type === 'provider_register')
      ).toMatchObject({
        recovery: { invocationId: fence.invocationId, locksDrained: true, tabClosed: true },
      });
      if (tabId === undefined) {
        expect(JSON.stringify(transport.outbound.at(-1))).not.toContain('tabId');
      }
      expect(runtime.getSnapshot()).toMatchObject({ active: undefined, phase: 'idle' });
      expect(fixture.actions).toStrictEqual([]);
      const fresh = transport.delivery({ goal: 'Explicit work after recovery.' });
      transport.dispatch(fresh);
      await waitForConsent(runtime);
      await runtime.approve(fresh.job.jobId, 8);
      await waitForDone(runtime);
      expect(fixture.actions).toStrictEqual(['run:8:1']);
    }
  );

  it('passes every open tab to all-tabs recovery, including tabs outside the affected list', async () => {
    const { runtime, transport } = await setup();
    fixture.values.set(BROWSER_EXECUTION_SAFETY_KEY, { allTabs: true, tabIds: [7], version: 1 });
    fixture.tabs = fixture.tabs.filter(tab => tab.id !== 7);
    const fence = { invocationId: `b1.${Date.now() - 700_000_000}.${'c'.repeat(64)}` };
    transport.setFence(fence);
    await runtime.recover();
    expect(runtime.getSnapshot().message).toContain('Close all target tabs');
    expect(transport.events).not.toContain('recovered');
    fixture.tabs = [];
    await runtime.recover();
    expect(runtime.getSnapshot().phase).toBe('idle');
    expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [],
      version: 1,
    });
  });

  it('keeps the account-independent fence when authentication clears during issued work', async () => {
    const { runtime, transport } = await setup();
    const gate = Promise.withResolvers<void>();
    fixture.turn = async context => {
      fixture.actions.push('issued');
      await gate.promise;
      context.executionGuard();
      fixture.actions.push('later');
      return outcome();
    };
    const message = transport.delivery();
    transport.dispatch(message);
    await waitForConsent(runtime);
    await runtime.approve(message.job.jobId, 7);
    await waitFor(() => {
      expect(fixture.actions).toStrictEqual(['issued']);
    });
    const disposing = runtime.dispose();
    await waitFor(() => {
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
    });
    await clearStoredSession({
      removeItems: keys => {
        for (const key of keys) {
          fixture.values.delete(key);
        }
      },
      snapshot: () =>
        Object.fromEntries([...fixture.values].map(([key, value]) => [key.slice(6), value])),
    });
    gate.resolve();
    await disposing;
    expect(fixture.actions).toStrictEqual(['issued']);
    expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
    expect(fixture.values.has(BROWSER_TASK_STORAGE_KEY)).toBe(false);
  });

  it('rejects stale generations and running snapshots that have no live consent', async () => {
    const { runtime, transport } = await setup();
    const stale = transport.delivery();
    stale.job.generation += 1;
    transport.send(stale);
    const historical = transport.delivery().job;
    transport.send({
      generation: historical.generation,
      jobs: [
        {
          ...historical,
          approvedTab: {
            effectiveMode: 'safe',
            tabId: 7,
            title: 'Old consent',
            url: 'https://example.test/',
          },
          status: 'running',
        },
      ],
      providerId: historical.providerId,
      type: 'provider_snapshot',
    });
    await runtime.refreshStatus();
    expect({ actions: fixture.actions, active: runtime.getSnapshot().active }).toStrictEqual({
      actions: [],
      active: undefined,
    });
    expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({ jobs: [] });
  });

  describe.each(['provider_snapshot', 'provider_status_result'] as const)(
    '%s queue metadata',
    pageType => {
      it.each(['awaiting_approval', 'running', 'cancelled'] as const)(
        'preserves paginated ranks through a queued-to-%s transition without granting authority',
        async status => {
          vi.useFakeTimers();
          const { runtime, transport } = await setup();
          const startedAt = Date.now();
          const head: BrowserJobSnapshot = {
            ...transport.delivery().job,
            jobId: 'bj_ffffffff-ffff-4fff-8fff-ffffffffffff',
          };
          const first: BrowserJobSnapshot = {
            ...head,
            ownerLabel: 'ses_parent_a',
            queuePosition: 1,
            status: 'queued',
          };
          const second: BrowserJobSnapshot = {
            ...transport.delivery().job,
            jobId: 'bj_00000000-0000-4000-8000-000000000001',
            ownerLabel: 'ses_parent_b',
            queuePosition: 2,
            status: 'queued',
          };
          const legacy: BrowserJobSnapshot = {
            ...transport.delivery().job,
            jobId: 'bj_80000000-0000-4000-8000-000000000001',
            status: 'queued',
          };
          let firstPage = [second, legacy];
          let lastPage = [first];
          const page = (cursor?: string) => ({
            jobs: structuredClone(cursor === legacy.jobId ? lastPage : firstPage),
            ...(cursor === legacy.jobId ? {} : { nextCursor: legacy.jobId }),
          });
          transport.connection.heartbeatBrowserProvider = async (cursor?: string) => ({
            ...page(cursor),
            generation: head.generation,
            providerId: head.providerId,
            type: 'provider_snapshot',
          });
          transport.connection.requestBrowserProviderStatus = async (cursor?: string) => ({
            ...page(cursor),
            providerId: head.providerId,
            requestId: crypto.randomUUID(),
            type: 'provider_status_result',
          });
          const refresh = () =>
            pageType === 'provider_snapshot'
              ? vi.advanceTimersByTimeAsync(5000)
              : runtime.refreshStatus();
          const persisted = structuredClone(fixture.values.get(BROWSER_TASK_STORAGE_KEY));
          const writes = [...fixture.writes];
          const outbound = structuredClone(transport.outbound);
          await vi.advanceTimersByTimeAsync(1000);
          await refresh();
          const previous = runtime.getSnapshot();
          const previousCopy = structuredClone(previous);
          expect(previous.jobs).toStrictEqual([second, legacy, first]);
          expect(previous.jobs[1]).not.toHaveProperty('ownerLabel');
          expect(previous.jobs[1]).not.toHaveProperty('queuePosition');

          const promoted = { ...second, queuePosition: 1 };
          delete promoted.ownerLabel;
          const transitioned: BrowserJobSnapshot = {
            ...head,
            ownerLabel: 'ses_parent_a',
            status,
            ...(status === 'running'
              ? {
                  approvedTab: {
                    effectiveMode: 'safe' as const,
                    tabId: 7,
                    title: 'Approved tab',
                    url: 'https://example.test/task',
                  },
                  deadlines: {
                    ...head.deadlines,
                    execution: new Date(startedAt + 600_000).toISOString(),
                  },
                }
              : {}),
            ...(status === 'cancelled'
              ? { result: terminalResult(head, 'cancelled', 'cancelled') }
              : {}),
          };
          firstPage = [promoted, legacy];
          lastPage = [transitioned];
          await refresh();
          expect(runtime.getSnapshot().jobs).toStrictEqual([promoted, legacy, transitioned]);
          expect(runtime.getSnapshot().jobs[0]).not.toHaveProperty('ownerLabel');
          expect(runtime.getSnapshot().jobs[2]).not.toHaveProperty('queuePosition');
          expect(previous).toStrictEqual(previousCopy);
          await runtime.approve(head.jobId, 7);
          await runtime.approve(legacy.jobId, 8);
          expect(runtime.getSnapshot()).toMatchObject({ active: undefined, phase: 'idle' });
          expect(fixture.actions).toStrictEqual([]);
          expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(persisted);
          expect(fixture.writes).toStrictEqual(writes);
          expect(transport.outbound).toStrictEqual(outbound);

          await vi.advanceTimersByTimeAsync(startedAt + 15_001 - Date.now());
          expect(runtime.getSnapshot().phase).toBe('interrupted');
          expect(fixture.actions).toStrictEqual([]);
        }
      );

      it.each([
        'browserTaskId',
        'generation',
        'invocationId',
        'payloadFingerprint',
        'providerId',
      ] as const)('rejects terminal metadata with a different %s', async field => {
        const { runtime, transport } = await setup();
        const { job } = transport.delivery();
        const terminal: BrowserJobSnapshot = {
          ...job,
          ownerLabel: 'ses_parent_a',
          result: terminalResult(job, 'cancelled', 'cancelled'),
          status: 'cancelled',
        };
        transport.rows.set(job.jobId, terminal);
        transport.snapshot();
        const previous = structuredClone(runtime.getSnapshot());
        const different: BrowserJobSnapshot = {
          ...transport.delivery().job,
          generation: job.generation + 1,
          payloadFingerprint: 'b'.repeat(64),
          providerId: `bp_${crypto.randomUUID()}`,
        };
        const wrong: BrowserJobSnapshot = {
          ...job,
          [field]: different[field],
          ownerLabel: 'ses_parent_other',
          queuePosition: 1,
          status: 'queued',
        };
        if (pageType === 'provider_snapshot') {
          transport.send({
            generation: wrong.generation,
            jobs: [wrong],
            providerId: wrong.providerId,
            type: 'provider_snapshot',
          });
        } else {
          transport.connection.requestBrowserProviderStatus = async () => ({
            jobs: [wrong],
            providerId: wrong.providerId,
            requestId: crypto.randomUUID(),
            type: 'provider_status_result',
          });
          if (field === 'providerId') {
            const request = runtime.refreshStatus();
            await expect(request).rejects.toThrow('owner_mismatch');
          } else {
            await runtime.refreshStatus();
          }
        }
        expect(runtime.getSnapshot()).toStrictEqual(previous);
        expect(fixture.actions).toStrictEqual([]);
        expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({ jobs: [] });
      });
    }
  );

  it('exposes current status metadata without treating it as consent or a live running acknowledgement', async () => {
    const { runtime, transport } = await setup();
    transport.setApprovalAck(false);
    const message = transport.delivery();
    transport.dispatch(message);
    await waitForConsent(runtime);
    const running: BrowserJobSnapshot = {
      ...message.job,
      approvedTab: {
        effectiveMode: 'safe',
        tabId: 7,
        title: 'Approved tab',
        url: 'https://example.test/task',
      },
      deadlines: {
        ...message.job.deadlines,
        execution: new Date(Date.now() + 600_000).toISOString(),
      },
      ownerLabel: message.ownerLabel,
      status: 'running',
    };
    transport.rows.set(message.job.jobId, running);
    await runtime.refreshStatus();
    expect(runtime.getSnapshot()).toMatchObject({
      active: { approval: undefined, job: { status: 'awaiting_approval' } },
      jobs: [running],
      phase: 'awaiting_approval',
    });
    expect(fixture.actions).toStrictEqual([]);
    expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({
      jobs: [{ approval: null, snapshot: { status: 'awaiting_approval' } }],
    });

    await runtime.approve(message.job.jobId, 7);
    await waitFor(() => {
      expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({
        jobs: [{ approval: { tab: { tabId: 7 } } }],
      });
    });
    await runtime.refreshStatus();
    expect(runtime.getSnapshot().phase).toBe('waiting');
    expect(fixture.actions).toStrictEqual([]);
    transport.snapshot();
    await waitForDone(runtime);
    expect(fixture.actions).toStrictEqual(['run:7:1']);
    expect(runtime.getSnapshot().result?.status).toBe('succeeded');
  });

  it.each(['provider_snapshot', 'provider_status_result'] as const)(
    'restores terminal owners from %s without changing cancellation or stored results',
    async pageType => {
      const { runtime, transport } = await setup();
      const message = transport.delivery();
      const initial: BrowserJobSnapshot = {
        ...message.job,
        ownerLabel: message.ownerLabel,
        queuePosition: 1,
        status: 'queued',
      };
      transport.rows.set(initial.jobId, initial);
      transport.snapshot();
      const queuedSnapshot = runtime.getSnapshot();
      const queuedCopy = structuredClone(queuedSnapshot);
      expect(queuedSnapshot.jobs).toStrictEqual([initial]);
      transport.dispatch(message);
      await waitForConsent(runtime);
      const queued: BrowserJobSnapshot = {
        ...transport.delivery().job,
        ownerLabel: 'ses_parent_b',
        queuePosition: 2,
        status: 'queued',
      };
      transport.rows.set(queued.jobId, queued);
      transport.snapshot();
      runtime.cancel(message.job.jobId);
      await waitForDone(runtime);
      const terminal = transport.rows.get(message.job.jobId);
      if (terminal?.result === undefined) {
        throw new Error('Missing terminal fixture');
      }
      const previous = runtime.getSnapshot();
      const previousCopy = structuredClone(previous);
      expect(previous.jobs[0]).not.toHaveProperty('ownerLabel');
      expect(previous.jobs[0]).not.toHaveProperty('queuePosition');
      expect(previous.result).toMatchObject({ reason: 'cancelled', status: 'cancelled' });
      const persisted = structuredClone(fixture.values.get(BROWSER_TASK_STORAGE_KEY));
      const writes = [...fixture.writes];
      const outbound = structuredClone(transport.outbound);
      const refresh = async (): Promise<void> => {
        if (pageType === 'provider_snapshot') {
          transport.snapshot();
          return;
        }
        await runtime.refreshStatus();
      };
      const labelled = { ...terminal, ownerLabel: message.ownerLabel };
      transport.rows.set(message.job.jobId, labelled);
      transport.rows.set(queued.jobId, { ...queued, queuePosition: 1 });
      await refresh();
      const restored = {
        ...previous,
        jobs: [labelled, { ...queued, queuePosition: 1 }],
      };
      expect(runtime.getSnapshot()).toStrictEqual(restored);

      const late: BrowserJobSnapshot = {
        ...message.job,
        ownerLabel: message.ownerLabel,
        result: {
          browserTaskId: message.job.browserTaskId,
          effectsUncertain: false,
          evidence: [],
          invocationId: message.job.invocationId,
          jobId: message.job.jobId,
          providerId: message.job.providerId,
          reason: 'completed',
          status: 'succeeded',
          summary: 'Late success',
        },
        status: 'succeeded',
      };
      transport.rows.set(message.job.jobId, late);
      await refresh();
      expect(runtime.getSnapshot()).toStrictEqual(restored);
      transport.rows.set(message.job.jobId, terminal);
      await refresh();
      expect(runtime.getSnapshot()).toStrictEqual(restored);
      transport.rows.set(message.job.jobId, initial);
      await refresh();
      expect(runtime.getSnapshot()).toStrictEqual(restored);
      expect(runtime.getSnapshot().jobs[0]).not.toHaveProperty('queuePosition');
      expect(previous).toStrictEqual(previousCopy);
      expect(queuedSnapshot).toStrictEqual(queuedCopy);
      expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toStrictEqual(persisted);
      expect(fixture.writes).toStrictEqual(writes);
      expect(transport.outbound).toStrictEqual(outbound);
      expect(fixture.actions).toStrictEqual([]);
    }
  );

  it.each(['rejection', 'cancellation', 'cancellation while waiting'] as const)(
    'offers fresh FIFO consent after %s without recovery',
    async termination => {
      const { coordinator, runtime, transport } = await setup();
      let local: BrowserExecutionLease | undefined;
      if (termination === 'cancellation while waiting') {
        const admission = await coordinator.acquireLocal();
        if (!admission.admitted) {
          throw new Error(admission.reason);
        }
        local = admission.lease;
        localLeases.push(local);
      }
      const first = transport.delivery();
      const next = transport.delivery({ goal: 'Read the next page.', ownerLabel: 'ses_parent_b' });
      transport.dispatch(first);
      await waitForConsent(runtime);
      transport.enqueue(next);
      const queued: BrowserJobSnapshot = {
        ...next.job,
        ownerLabel: next.ownerLabel,
        queuePosition: 1,
        status: 'queued',
      };
      transport.rows.set(next.job.jobId, queued);
      transport.snapshot();
      const beforeDispatch = runtime.getSnapshot();
      expect(beforeDispatch.jobs).toContainEqual(queued);
      if (local !== undefined) {
        await runtime.approve(first.job.jobId, 7);
        await waitFor(() => {
          expect(runtime.getSnapshot().phase).toBe('waiting');
        });
      }
      transport.setTerminalAck(false);
      if (termination === 'rejection') {
        runtime.reject(first.job.jobId);
      } else {
        runtime.cancel(first.job.jobId);
      }
      const reason = termination === 'rejection' ? 'approval_denied' : 'cancelled';
      await waitFor(() => {
        expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({
          jobs: [{ approval: null, snapshot: { result: { effectsUncertain: false, reason } } }],
        });
      });
      expect(runtime.getSnapshot().active?.job.jobId).toBe(first.job.jobId);
      expect(transport.connection.getBrowserProviderState().status).toBe('registered');
      expect(transport.rows.get(next.job.jobId)?.status).toBe('queued');
      expect(transport.events).not.toContain('quiesced');
      expect(fixture.actions).toStrictEqual([]);

      transport.setTerminalAck(true);
      transport.snapshot();
      await waitFor(() => {
        expect(runtime.getSnapshot()).toMatchObject({
          active: { approval: undefined, goal: next.goal, job: { jobId: next.job.jobId } },
          phase: 'awaiting_approval',
          result: { reason },
        });
      });
      expect(runtime.getSnapshot().active?.ownerLabel).toBe(next.ownerLabel);
      expect(runtime.getSnapshot().active?.job).not.toHaveProperty('queuePosition');
      expect(
        runtime.getSnapshot().jobs.find(job => job.jobId === next.job.jobId)
      ).not.toHaveProperty('queuePosition');
      expect(beforeDispatch.jobs).toContainEqual(queued);
      expect(
        transport.outbound.find(frame => frame.type === 'provider_quiesced')
      ).not.toHaveProperty('tabId');
      expect(fixture.actions).toStrictEqual([]);
      await local?.release();
      await waitFor(() => {
        expect(coordinator.getSnapshot().delegated).toBe('idle');
      });
      await runtime.approve(next.job.jobId, 8);
      await waitForDone(runtime);
      expect(fixture.actions).toStrictEqual(['run:8:1']);
      expect(runtime.getSnapshot().phase).toBe('idle');
      expect(transport.rows.get(first.job.jobId)?.result).toMatchObject({ reason });
      expect(transport.events).not.toContain('recovered');
    }
  );

  it.each(['rejection', 'cancellation'] as const)(
    'preserves the next consent when a stale tab approval resumes after %s',
    async termination => {
      const { runtime, transport } = await setup();
      const idleMessage = runtime.getSnapshot().message;
      const first = transport.delivery();
      const next = transport.delivery({ goal: 'Read the next page.', ownerLabel: 'ses_parent_b' });
      transport.dispatch(first);
      await waitForConsent(runtime);
      transport.enqueue(next);
      const tabs = await browser.tabs.query({});
      const tabsApi: {
        query: (queryInfo: Parameters<typeof browser.tabs.query>[0]) => Promise<typeof tabs>;
      } = browser.tabs;
      const enumerating = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const query = vi.spyOn(tabsApi, 'query').mockImplementationOnce(async () => {
        enumerating.resolve();
        await resume.promise;
        return tabs;
      });
      const approving = runtime.approve(first.job.jobId, 7);
      try {
        await enumerating.promise;
        if (termination === 'rejection') {
          runtime.reject(first.job.jobId);
        } else {
          runtime.cancel(first.job.jobId);
        }
        await waitFor(() => {
          expect(runtime.getSnapshot()).toMatchObject({
            active: {
              approval: undefined,
              goal: next.goal,
              job: { jobId: next.job.jobId },
              ownerLabel: next.ownerLabel,
            },
            phase: 'awaiting_approval',
          });
        });
        const awaitingConsent = runtime.getSnapshot();
        resume.resolve();
        await approving;
        expect(runtime.getSnapshot()).toStrictEqual(awaitingConsent);
        expect(fixture.actions).toStrictEqual([]);
        await runtime.approve(next.job.jobId, 8);
        await waitForDone(runtime);
        expect(fixture.actions).toStrictEqual(['run:8:1']);
        expect(runtime.getSnapshot()).toMatchObject({
          message: idleMessage,
          phase: 'idle',
          result: { jobId: next.job.jobId, reason: 'completed', status: 'succeeded' },
        });
      } finally {
        resume.resolve();
        await approving;
        query.mockRestore();
      }
    }
  );

  it.each([
    { reason: 'provider_unavailable', retryable: true },
    { reason: 'permission_denied', retryable: false },
  ] as const)(
    'reports current tab approval failure $reason without starting work',
    async failure => {
      const { runtime, transport } = await setup();
      const message = transport.delivery();
      transport.dispatch(message);
      await waitForConsent(runtime);
      const tabs = await browser.tabs.query({});
      const tabsApi: {
        query: (queryInfo: Parameters<typeof browser.tabs.query>[0]) => Promise<typeof tabs>;
      } = browser.tabs;
      const query = vi
        .spyOn(tabsApi, 'query')
        .mockRejectedValueOnce(new BrowserProviderError(failure.reason, failure.retryable));
      try {
        await runtime.approve(message.job.jobId, 7);
        expect(runtime.getSnapshot()).toMatchObject({
          active: { approval: undefined, job: { jobId: message.job.jobId } },
          message: expect.stringContaining(failure.reason),
          phase: 'unavailable',
          retryable: failure.retryable,
        });
        expect(fixture.actions).toStrictEqual([]);
      } finally {
        query.mockRestore();
      }
      if (failure.retryable) {
        await runtime.approve(message.job.jobId, 7);
        await waitForDone(runtime);
        expect(fixture.actions).toStrictEqual(['run:7:1']);
        expect(runtime.getSnapshot().result).toMatchObject({ status: 'succeeded' });
      } else {
        runtime.reject(message.job.jobId);
        await waitForDone(runtime);
        expect(fixture.actions).toStrictEqual([]);
        expect(runtime.getSnapshot().result).toMatchObject({ reason: 'approval_denied' });
      }
    }
  );

  it.each(['drained', 'failed'] as const)(
    'waits for a %s lease release before acknowledging quiescence',
    async releaseOutcome => {
      const { coordinator, runtime, transport } = await setup();
      const releasing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const acquire = coordinator.acquireDelegated;
      const admissionSpy = vi
        .spyOn(coordinator, 'acquireDelegated')
        .mockImplementationOnce(async (...args) => {
          const admission = await acquire(...args);
          if (!admission.admitted) {
            return admission;
          }
          localLeases.push(admission.lease);
          return {
            admitted: true,
            lease: {
              ...admission.lease,
              release: async () => {
                releasing.resolve();
                await release.promise;
                if (releaseOutcome === 'failed') {
                  throw new Error('Execution lease did not drain');
                }
                await admission.lease.release();
              },
            },
          };
        });
      const first = transport.delivery();
      const next = transport.delivery({ goal: 'Read after drainage.' });
      transport.dispatch(first);
      await waitForConsent(runtime);
      transport.enqueue(next);
      await runtime.approve(first.job.jobId, 7);
      await releasing.promise;
      admissionSpy.mockRestore();
      try {
        expect(runtime.getSnapshot().active?.job.status).toBe('succeeded');
        expect(transport.rows.get(next.job.jobId)?.status).toBe('queued');
        expect(transport.events).not.toContain('quiesced');
      } finally {
        release.resolve();
      }
      if (releaseOutcome === 'failed') {
        await waitForDone(runtime);
        expect(runtime.getSnapshot().phase).toBe('recovery');
        expect(transport.rows.get(next.job.jobId)?.status).toBe('queued');
        expect(transport.events).not.toContain('quiesced');
      } else {
        await waitFor(() => {
          expect(runtime.getSnapshot()).toMatchObject({
            active: { approval: undefined, job: { jobId: next.job.jobId } },
            phase: 'awaiting_approval',
          });
        });
      }
      expect(fixture.actions).toStrictEqual(['run:7:1']);
    }
  );

  it.each(['workflow', 'memory', 'browser'] as const)(
    'invalidates %s authority revoked during pending tab enumeration',
    async permission => {
      const { runtime, transport } = await setup();
      const key =
        permission === 'workflow' ? 'local:kiloWorkflowSettings' : 'local:kiloMemorySettings';
      const flag =
        permission === 'workflow' ? 'allowWorkflowsInSafeMode' : 'autoApproveMemorySaves';
      await storage.setItem(key, { [flag]: true });
      const message = transport.delivery();
      transport.dispatch(message);
      await waitForConsent(runtime);
      const tabs = await browser.tabs.query({});
      const tabsApi: {
        query: (queryInfo: Parameters<typeof browser.tabs.query>[0]) => Promise<typeof tabs>;
      } = browser.tabs;
      const enumerating = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const query = vi.spyOn(tabsApi, 'query').mockImplementationOnce(async () => {
        enumerating.resolve();
        await resume.promise;
        return tabs;
      });
      const approving = runtime.approve(message.job.jobId, 7);
      await enumerating.promise;
      if (permission === 'browser') {
        for (const listener of fixture.permissions) {
          listener();
        }
      } else {
        await storage.setItem(key, { [flag]: false });
      }
      resume.resolve();
      await approving;
      query.mockRestore();
      await waitForDone(runtime);
      expect(fixture.actions).toStrictEqual([]);
      expect(runtime.getSnapshot().result).toMatchObject({ reason: 'permission_denied' });
      expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({
        jobs: [{ approval: null, snapshot: { result: { reason: 'permission_denied' } } }],
      });
      expect(transport.outbound.filter(frame => frame.type === 'provider_approval')).toStrictEqual(
        []
      );
    }
  );

  it('ignores an old permission-read failure after FIFO advances to an approved job', async () => {
    const { coordinator, runtime, transport } = await setup();
    const local = await coordinator.acquireLocal();
    if (!local.admitted) {
      throw new Error(local.reason);
    }
    localLeases.push(local.lease);
    const first = transport.delivery();
    const next = transport.delivery({
      goal: 'Read after cancellation.',
      ownerLabel: 'ses_parent_b',
    });
    transport.dispatch(first);
    await waitForConsent(runtime);
    transport.enqueue(next);
    await runtime.approve(first.job.jobId, 7);
    await waitFor(() => {
      expect(runtime.getSnapshot().phase).toBe('waiting');
    });
    const read = Promise.withResolvers<unknown>();
    const reading = Promise.withResolvers<void>();
    const storageApi = storage as { getItem: (key: string) => unknown };
    const { getItem } = storageApi;
    const spy = vi.spyOn(storageApi, 'getItem').mockImplementation(key => {
      if (key === 'local:kiloRemoteMcpServers') {
        reading.resolve();
        return read.promise;
      }
      return getItem(key);
    });
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    fixture.turn = async context => {
      running.resolve();
      await finish.promise;
      context.executionGuard();
      fixture.actions.push('next job');
      return outcome();
    };
    try {
      await storage.setItem('local:kiloMemorySettings', { autoApproveMemorySaves: false });
      await reading.promise;
      spy.mockRestore();
      runtime.cancel(first.job.jobId);
      await waitFor(() => {
        expect(runtime.getSnapshot()).toMatchObject({
          active: { job: { jobId: next.job.jobId } },
          phase: 'awaiting_approval',
        });
      });
      await local.lease.release();
      await runtime.approve(next.job.jobId, 8);
      await running.promise;
      await act(async () => {
        read.reject(new Error('Old permission read failed'));
        await expect(read.promise).rejects.toThrow('Old permission read failed');
      });
      expect(runtime.getSnapshot()).toMatchObject({
        active: { job: { jobId: next.job.jobId } },
        phase: 'running',
      });
      finish.resolve();
      await waitForDone(runtime);
      expect(fixture.actions).toStrictEqual(['next job']);
      expect(runtime.getSnapshot().result).toMatchObject({
        jobId: next.job.jobId,
        reason: 'completed',
      });
      expect(transport.outbound.some(frame => frame.type === 'provider_unavailable')).toBe(false);
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).not.toMatchObject({ tabIds: [8] });
    } finally {
      spy.mockRestore();
      read.resolve({ servers: [] });
      finish.resolve();
    }
  });

  it.each(['workflow', 'memory'] as const)(
    'blocks an approved %s action while permission validation waits for storage',
    async permission => {
      const { runtime, transport } = await setup();
      const key =
        permission === 'workflow' ? 'local:kiloWorkflowSettings' : 'local:kiloMemorySettings';
      const flag =
        permission === 'workflow' ? 'allowWorkflowsInSafeMode' : 'autoApproveMemorySaves';
      await storage.setItem(key, { [flag]: true });
      const running = Promise.withResolvers<void>();
      const actNow = Promise.withResolvers<void>();
      fixture.turn = async context => {
        running.resolve();
        await actNow.promise;
        context.executionGuard();
        fixture.actions.push(`revoked ${permission} action`);
        return outcome();
      };
      const message = transport.delivery();
      transport.dispatch(message);
      await waitForConsent(runtime);
      await runtime.approve(message.job.jobId, 7);
      await running.promise;
      const read = Promise.withResolvers<unknown>();
      const reading = Promise.withResolvers<void>();
      const storageApi = storage as { getItem: (key: string) => unknown };
      const { getItem } = storageApi;
      const spy = vi.spyOn(storageApi, 'getItem').mockImplementation(storageKey => {
        if (storageKey === 'local:kiloRemoteMcpServers') {
          reading.resolve();
          return read.promise;
        }
        return getItem(storageKey);
      });
      try {
        await storage.setItem(key, { [flag]: false });
        await reading.promise;
        actNow.resolve();
        await waitForDone(runtime);
        expect(fixture.actions).toStrictEqual([]);
        expect(runtime.getSnapshot().result).toMatchObject({ reason: 'permission_denied' });
      } finally {
        spy.mockRestore();
        read.resolve({ servers: [] });
        actNow.resolve();
      }
    }
  );

  it('requires every overlapping permission check before unchanged authority can run', async () => {
    const { runtime, transport } = await setup();
    const running = Promise.withResolvers<() => void>();
    const finish = Promise.withResolvers<void>();
    fixture.turn = async context => {
      running.resolve(context.executionGuard);
      await finish.promise;
      context.executionGuard();
      fixture.actions.push('validated action');
      return outcome();
    };
    const message = transport.delivery();
    transport.dispatch(message);
    await waitForConsent(runtime);
    await runtime.approve(message.job.jobId, 7);
    const guard = await running.promise;
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    const reads = [first, second];
    const storageApi = storage as { getItem: (key: string) => unknown };
    const { getItem } = storageApi;
    const spy = vi.spyOn(storageApi, 'getItem').mockImplementation(key => {
      if (key === 'local:kiloRemoteMcpServers') {
        return reads.shift()?.promise;
      }
      return getItem(key);
    });
    try {
      await storage.setItem('local:kiloMemorySettings', { autoApproveMemorySaves: false });
      await storage.setItem('local:kiloWorkflowSettings', { allowWorkflowsInSafeMode: false });
      expect(reads).toHaveLength(0);
      expect(guard).toThrow('permission_denied');
      await act(async () => {
        first.resolve({ servers: [] });
        await first.promise;
      });
      expect(guard).toThrow('permission_denied');
      await act(async () => {
        second.resolve({ servers: [] });
        await second.promise;
      });
      expect(guard).not.toThrow();
      finish.resolve();
      await waitForDone(runtime);
      expect(fixture.actions).toStrictEqual(['validated action']);
      expect(runtime.getSnapshot().result?.reason).toBe('completed');
    } finally {
      spy.mockRestore();
      first.resolve({ servers: [] });
      second.resolve({ servers: [] });
      finish.resolve();
    }
  });

  it.each(['binding', 'closed', 'uninspectable'] as const)(
    'interrupts %s tab loss before the next action',
    async kind => {
      const { runtime, transport } = await setup();
      const gate = Promise.withResolvers<void>();
      fixture.turn = async context => {
        fixture.actions.push('issued');
        await gate.promise;
        context.executionGuard();
        fixture.actions.push('later');
        return outcome();
      };
      const message = transport.delivery();
      transport.dispatch(message);
      await waitForConsent(runtime);
      await runtime.approve(message.job.jobId, 7);
      await waitFor(() => {
        expect(fixture.actions).toStrictEqual(['issued']);
      });
      const running = transport.rows.get(message.job.jobId);
      if (running?.approvedTab === undefined) {
        throw new Error('Missing running fixture');
      }
      if (kind === 'binding') {
        transport.rows.set(running.jobId, {
          ...running,
          approvedTab: { ...running.approvedTab, tabId: 8 },
        });
        transport.snapshot();
      }
      if (kind === 'closed') {
        fixture.tabs = fixture.tabs.filter(tab => tab.id !== 7);
        for (const listener of fixture.removed) {
          listener(7);
        }
      }
      if (kind === 'uninspectable') {
        for (const listener of fixture.updated) {
          listener(7, { url: 'chrome://settings' });
        }
      }
      gate.resolve();
      await waitForDone(runtime);
      expect(fixture.actions).toStrictEqual(['issued']);
      expect(runtime.getSnapshot().result).toMatchObject({
        reason: 'tab_lost',
        status: 'interrupted',
      });
    }
  );

  it('heartbeats every five seconds and cannot renew an expired local lease with a late acknowledgement', async () => {
    vi.useFakeTimers();
    const { runtime, transport } = await setup();
    const start = Date.now();
    const message = transport.delivery();
    transport.dispatch(message);
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().phase).toBe('awaiting_approval');
    });
    transport.setHeartbeatAck(false);
    await vi.advanceTimersByTimeAsync(15_001);
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().active).toBeUndefined();
    });
    expect(transport.heartbeatTimes.slice(0, 2)).toStrictEqual([start + 5000, start + 10_000]);
    expect(runtime.getSnapshot().result?.reason).toBe('lease_expired');
    transport.renew();
    transport.dispatch(transport.delivery());
    await vi.advanceTimersByTimeAsync(1);
    expect({ actions: fixture.actions, active: runtime.getSnapshot().active }).toStrictEqual({
      actions: [],
      active: undefined,
    });
  });

  it.each(['approval_timeout', 'execution_timeout'] as const)(
    'enforces the relay %s deadline locally',
    async reason => {
      vi.useFakeTimers();
      const { runtime, transport } = await setup();
      const gate = Promise.withResolvers<void>();
      fixture.turn = async context => {
        fixture.actions.push('issued');
        await gate.promise;
        context.executionGuard();
        fixture.actions.push('later');
        return outcome();
      };
      const message = transport.delivery();
      message.job.deadlines.approval = new Date(Date.now() + 1000).toISOString();
      transport.dispatch(message);
      await vi.waitFor(() => {
        expect(runtime.getSnapshot().phase).toBe('awaiting_approval');
      });
      if (reason === 'execution_timeout') {
        transport.setApprovalAck(false);
        await runtime.approve(message.job.jobId, 7);
        await vi.waitFor(() => {
          expect(transport.rows.get(message.job.jobId)?.status).toBe('running');
        });
        const running = transport.rows.get(message.job.jobId);
        if (running === undefined) {
          throw new Error('Missing running fixture');
        }
        transport.rows.set(running.jobId, {
          ...running,
          deadlines: { ...running.deadlines, execution: new Date(Date.now() + 500).toISOString() },
        });
        transport.snapshot();
        await vi.waitFor(() => {
          expect(fixture.actions).toStrictEqual(['issued']);
        });
      }
      await vi.advanceTimersByTimeAsync(1100);
      gate.resolve();
      await vi.waitFor(() => {
        expect(runtime.getSnapshot().active).toBeUndefined();
      });
      expect(runtime.getSnapshot().result?.reason).toBe(reason);
      expect(fixture.actions).not.toContain('later');
    }
  );

  it.each(['disconnect', 'disable', 'permission', 'organization', 'auth'] as const)(
    'aborts on %s while an issued action unwinds',
    async cause => {
      const { runtime, transport } = await setup();
      const gate = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      fixture.turn = async context => {
        ({ signal } = context.abort);
        fixture.actions.push('issued');
        await gate.promise;
        context.executionGuard();
        fixture.actions.push('later');
        return outcome();
      };
      const message = transport.delivery();
      transport.dispatch(message);
      await waitForConsent(runtime);
      await runtime.approve(message.job.jobId, 7);
      await waitFor(() => {
        expect(fixture.actions).toStrictEqual(['issued']);
      });
      if (cause === 'disconnect') {
        transport.setState({ status: 'disconnected' });
      }
      if (cause === 'disable') {
        await runtime.setSettings({ ...defaults, enabled: false });
      }
      if (cause === 'permission') {
        for (const listener of fixture.permissions) {
          listener();
        }
      }
      if (cause === 'organization') {
        await storage.setItem('local:kiloSelectedOrganizationId', 'new-org');
      }
      if (cause === 'auth') {
        await storage.setItem(AUTH_STORAGE_KEY, {
          token: 'other-token',
          userEmail: 'other@example.test',
        });
      }
      try {
        expect(signal?.aborted).toBe(true);
      } finally {
        gate.resolve();
        await runtime.dispose();
      }
      expect(fixture.actions).toStrictEqual(['issued']);
      expect(transport.events).not.toContain('quiesced');
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
    }
  );

  it('withdraws a locally quarantined provider and recovers after the SDK clears its proof cache', async () => {
    const { coordinator, runtime, transport } = await setup();
    const admission = await coordinator.acquireLocal();
    if (!admission.admitted) {
      throw new Error(admission.reason);
    }
    localLeases.push(admission.lease);
    await admission.lease.quarantine(8);
    await admission.lease.release();
    await waitFor(() => {
      expect(runtime.getSnapshot().phase).toBe('recovery');
    });
    expect(transport.connection.getBrowserProviderState().status).toBe('unavailable');
    fixture.tabs = fixture.tabs.filter(tab => tab.id !== 8);
    await runtime.recover();
    expect(runtime.getSnapshot().phase).toBe('idle');
    expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [],
      version: 1,
    });
    expect(fixture.actions).toStrictEqual([]);
  });

  it('requires drained native locks before fresh recovery registration', async () => {
    const { coordinator, runtime, transport } = await setup();
    transport.setFence({ invocationId: `b1.${Date.now() - 700_000_000}.${'d'.repeat(64)}` });
    const admission = await coordinator.acquireLocal();
    if (!admission.admitted) {
      throw new Error(admission.reason);
    }
    localLeases.push(admission.lease);
    await runtime.recover();
    expect(runtime.getSnapshot().message).toContain('unwinding');
    expect(transport.events).not.toContain('recovered');
    await admission.lease.release();
    await runtime.recover();
    expect(transport.events).toContain('recovered');
    expect(fixture.actions).toStrictEqual([]);
  });

  it('reloads recorded work as status rather than replaying old consent or actions', async () => {
    const { runtime, transport } = await setup();
    const message = transport.delivery();
    transport.dispatch(message);
    await waitForConsent(runtime);
    await runtime.dispose();
    const coordinator = createBrowserExecutionCoordinator({
      locks: nativeLocks as LockManager,
      storageArea: storage,
    });
    const reopened = createBrowserTaskProviderRuntime({
      auth,
      connection: transport.connection,
      coordinator,
      organizationId: 'org-approved',
      storageArea: storage,
    });
    runtimes.push(reopened);
    await reopened.start();
    transport.setState({ status: 'ready' });
    await reopened.refreshStatus();
    transport.send(message);
    expect({ actions: fixture.actions, active: reopened.getSnapshot().active }).toStrictEqual({
      actions: [],
      active: undefined,
    });
    expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({
      jobs: [{ snapshot: { status: 'interrupted' } }],
    });
    expect(transport.outbound.filter(frame => frame.type === 'provider_approval')).toStrictEqual(
      []
    );
  });

  it.each([
    { replacements: 2, scenario: 'a completed intermediate disposal' },
    { replacements: 4, scenario: 'repeated scope replacements' },
  ])('retains earlier drainage across $scenario', async ({ replacements }) => {
    vi.stubGlobal('navigator', { locks: nativeLocks });
    const transport = relay();
    const drain = Promise.withResolvers<void>();
    const runTurn = fixture.turn;
    let signal: AbortSignal | undefined;
    let current: BrowserTaskProviderRuntime | undefined;
    fixture.turn = async context => {
      ({ signal } = context.abort);
      context.executionGuard();
      fixture.actions.push('issued');
      await drain.promise;
      context.executionGuard();
      fixture.actions.push('after disposal');
      return outcome();
    };
    const View = () => {
      const task = useBrowserTask();
      current = task;
      return <output>{task.state.phase}</output>;
    };
    const view = (organizationId: string) => (
      <BrowserTaskProvider
        auth={auth}
        connection={transport.connection}
        organizationId={organizationId}
      >
        <View />
      </BrowserTaskProvider>
    );
    const mounted = render(view('org-0'));
    try {
      await screen.findByText('disabled');
      if (current === undefined) {
        throw new Error('Missing provider runtime');
      }
      const first = current;
      await act(async () => {
        await first.setSettings(defaults);
      });
      const message = transport.delivery();
      act(() => {
        transport.dispatch(message);
      });
      await screen.findByText('awaiting_approval');
      await act(async () => {
        await first.approve(message.job.jobId, 7);
      });
      await waitFor(() => {
        expect(fixture.actions).toStrictEqual(['issued']);
      });

      for (let replacement = 1; replacement <= replacements; replacement += 1) {
        act(() => {
          mounted.rerender(view(`org-${replacement}`));
        });
        expect(signal?.aborted).toBe(true);
        // Let no-work cleanup settle while the first runtime still drains its issued action.
        // eslint-disable-next-line no-await-in-loop -- Commit and flush each replacement before the next scope.
        await act(async () => {
          transport.setState({ status: 'ready' });
          await nativeLocks.query();
        });
        expect(current.getSnapshot()).toMatchObject({
          active: undefined,
          jobs: [],
          phase: 'connecting',
          profile: undefined,
        });
        expect(fixture.actions).toStrictEqual(['issued']);
      }
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
      expect(
        (await nativeLocks.query()).held?.some(lock => lock.name === PROVIDER_OWNER_LOCK)
      ).toBe(true);

      await act(async () => {
        drain.resolve();
      });
      await screen.findByText('recovery');
      const newest = current;
      expect(newest.getSnapshot()).toMatchObject({
        active: undefined,
        unresolvedFence: { invocationId: message.job.invocationId, tabId: 7 },
      });
      expect(transport.rows.get(message.job.jobId)?.result).toMatchObject({
        effectsUncertain: true,
        reason: 'provider_unavailable',
        status: 'interrupted',
      });
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
      expect(fixture.actions).toStrictEqual(['issued']);
      fixture.tabs = fixture.tabs.filter(tab => tab.id !== 7);
      await act(async () => {
        await newest.recover();
      });
      expect(screen.getByText('idle')).toBeDefined();
      expect(fixture.actions).toStrictEqual(['issued']);

      fixture.turn = runTurn;
      const fresh = transport.delivery({ goal: 'New work in the latest scope.' });
      act(() => {
        transport.dispatch(fresh);
      });
      await screen.findByText('awaiting_approval');
      expect(fixture.actions).toStrictEqual(['issued']);
      await act(async () => {
        await newest.approve(fresh.job.jobId, 8);
      });
      await screen.findByText('idle');
      expect(fixture.actions).toStrictEqual(['issued', 'run:8:1']);
      expect(fixture.values.get(BROWSER_TASK_STORAGE_KEY)).toMatchObject({
        jobs: [
          { snapshot: { result: { status: 'interrupted' } } },
          {
            approval: { settings: { organizationId: `org-${replacements}` } },
            snapshot: { result: { jobId: fresh.job.jobId, status: 'succeeded' } },
          },
        ],
      });
    } finally {
      await act(async () => {
        drain.resolve();
        mounted.unmount();
      });
      await waitFor(async () => {
        expect(
          (await nativeLocks.query()).held?.some(
            lock => lock.name === PROVIDER_OWNER_LOCK || lock.name === BROWSER_EXECUTION_LOCK
          )
        ).toBe(false);
      });
    }
  });

  it('owns and releases the provider through the injectable component lifetime', async () => {
    vi.stubGlobal('navigator', { locks: nativeLocks });
    const transport = relay();
    const View = () => {
      const { state } = useBrowserTask();
      return <output>{state.phase}</output>;
    };
    const mounted = render(
      <BrowserTaskProvider auth={auth} connection={transport.connection} organizationId={undefined}>
        <View />
      </BrowserTaskProvider>,
      { reactStrictMode: true }
    );
    await screen.findByText('disabled');
    expect((await nativeLocks.query()).held?.some(lock => lock.name === PROVIDER_OWNER_LOCK)).toBe(
      true
    );
    act(() => {
      mounted.unmount();
    });
    await waitFor(async () => {
      expect(
        (await nativeLocks.query()).held?.some(lock => lock.name === PROVIDER_OWNER_LOCK)
      ).toBe(false);
    });
    expect(transport.outbound).toStrictEqual([]);
  });
});
