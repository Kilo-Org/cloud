/* eslint-disable max-lines, import/max-dependencies, import/first, import/no-nodejs-modules, jest/no-hooks, jest/no-standalone-expect, jest/no-untyped-mock-factory, jest/no-conditional-in-test, jest/max-expects, vitest/prefer-import-in-mock, typescript/consistent-type-definitions, typescript/no-unsafe-type-assertion, require-await, typescript/require-await -- Browser and relay fixtures surround the real provider, approval storage, and Browser/Agents store boundaries. */
// @vitest-environment jsdom
import { webcrypto, createHash } from 'node:crypto';
import { locks as nativeLocks } from 'node:worker_threads';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { atom, getDefaultStore, useAtom, useAtomValue, useStore } from 'jotai';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createUserWebConnection } from '@kilocode/cloud-agent-sdk';
import type { StoredAuth } from '@/src/shared/auth';
import type { createExtensionTrpcClient } from '@/src/shared/extension-trpc-client';
import type { ExtensionAgentsContextValue } from './agents-provider';
import type {
  BrowserJobSnapshot,
  BrowserProviderInboundMessage,
  BrowserResult,
} from '@kilocode/cloud-agent-sdk/schemas';
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
import type { BrowserTaskProviderOptions } from './browser-task-provider';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import type { LlmTurnOutcome } from '@/src/shared/agent-llm-turn-runner-core';

const fixture = vi.hoisted(() => ({
  agents: undefined as ExtensionAgentsContextValue | undefined,
  connection: {} as BrowserTaskProviderOptions['connection'],
  connectionConfigs: [] as Parameters<typeof createUserWebConnection>[0][],
  connections: 0,
  failedReadKey: '',
  models: [
    { id: 'selected-model', isPreferred: true, name: 'Selected model', variants: [] as string[] },
    { id: 'other-model', isPreferred: false, name: 'Other model', variants: [] as string[] },
  ],
  organizationId: '',
  permissions: new Set<() => void>(),
  removed: new Set<(id: number) => void>(),
  retained: 0,
  tabs: [{ id: 7, title: 'Approved tab', url: 'https://example.test/' }],
  turn: async (
    _context: BrowserRunContext,
    _events: AgentConversationEvent[]
  ): Promise<LlmTurnOutcome> => {
    throw new Error('Set the turn fixture.');
  },
  updated: new Set<(id: number, info: { url?: string }) => void>(),
  values: new Map<string, unknown>(),
  waitWrite: undefined as Promise<void> | undefined,
  waitWriteKey: '',
  watchers: new Map<string, Set<() => void>>(),
}));
vi.mock('#imports', () => ({
  browser: {
    permissions: {
      onRemoved: {
        addListener: (fn: () => void) => fixture.permissions.add(fn),
        removeListener: (fn: () => void) => fixture.permissions.delete(fn),
      },
    },
    runtime: {
      sendMessage: async (request: { type: string }) => {
        if (request.type === LIST_INSPECTABLE_TABS_MESSAGE) {
          return { ok: true, tabs: fixture.tabs, type: request.type };
        }
        return {
          ok: true,
          result: {
            effectsUncertain: false,
            ok: true,
            value: {
              dryRunActions: [],
              effectsUncertain: false,
              ok: true,
              value: { done: true, result: 'Observed workflow result.' },
            },
          },
          type: request.type,
        };
      },
    },
    tabs: {
      get: async (id: number) => {
        const tab = fixture.tabs.find(candidate => candidate.id === id);
        if (tab === undefined) {
          throw new Error('Tab closed.');
        }
        return { ...tab, status: 'complete' };
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
    getItem: (key: string) => {
      if (key === fixture.failedReadKey) {
        throw new Error('Storage unavailable.');
      }
      return structuredClone(fixture.values.get(key));
    },
    removeItem: (key: string) => {
      fixture.values.delete(key);
      for (const notify of fixture.watchers.get(key) ?? []) {
        notify();
      }
    },
    setItem: async (key: string, value: unknown) => {
      if (key === fixture.waitWriteKey) {
        await fixture.waitWrite;
      }
      fixture.values.set(key, structuredClone(value));
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
vi.mock(import('@kilocode/cloud-agent-sdk'), async importOriginal => {
  const original = await importOriginal();
  return {
    ...original,
    createUserWebConnection: (config: Parameters<typeof createUserWebConnection>[0]) => {
      fixture.connections += 1;
      fixture.connectionConfigs.push(config);
      // Exercise the real SDK opt-in default without starting a socket.
      const dormant = original.createUserWebConnection(config);
      const disabled = dormant.getBrowserProviderState().status === 'disabled';
      dormant.destroy();
      return {
        ...dormant,
        ...fixture.connection,
        getBrowserProviderState: disabled
          ? () => ({ status: 'disabled' as const })
          : fixture.connection.getBrowserProviderState,
        registerBrowserProvider: disabled
          ? dormant.registerBrowserProvider
          : fixture.connection.registerBrowserProvider,
      };
    },
  };
});
vi.mock('@/src/shared/extension-trpc-client', () => ({
  createExtensionTrpcClient: ({ getToken }: Parameters<typeof createExtensionTrpcClient>[0]) => ({
    activeSessions: {
      createWebTicket: { mutate: async () => ({ token: `ticket:${getToken()}` }) },
    },
  }),
}));
vi.mock('./agents-mode', () => ({ AgentsMode: () => <AgentsProbe /> }));
vi.mock(import('./organization-credit-account'), async importOriginal => ({
  ...(await importOriginal()),
  useOrganizationCreditAccount: () => ({
    organizationOptions: [],
    selectOrganization: vi.fn(),
    selectedOrganizationId: fixture.organizationId,
  }),
}));
vi.mock('./use-gateway-models', () => ({
  useGatewayModels: () => ({
    isLoading: false,
    modelLoadError: undefined,
    modelOptions: fixture.models,
    refetchModels: vi.fn(),
  }),
}));
vi.mock('./use-model-preferences', () => ({
  useModelPreferences: () => ({
    favorites: new Set<string>(),
    refetch: vi.fn(),
    status: 'ready',
    toggleError: false,
    toggleFavorite: vi.fn(),
  }),
}));
vi.mock(import('./browser-run-context'), async importOriginal => ({
  ...(await importOriginal()),
  runBrowserTurn: (context: BrowserRunContext, events: AgentConversationEvent[]) =>
    context.lease.run(async guard => {
      guard();
      return fixture.turn(context, events);
    }),
}));

import { storage } from '#imports';
import { SignedInView } from './auth-views';
import { useExtensionAgents } from './agents-provider';
import { draftAtomFamily, clearPerConversationAtoms } from './agent-chat-atoms';
import { activeConversationIdAtom, settingsDialogOpenAtom } from './settings-dialog-state';
import { workflowRunRequestAtom } from './workflow-settings-state';
import { pendingApprovalAtom, pendingLockAtom } from './pending-approval';
import {
  PROVIDER_OWNER_LOCK,
  BROWSER_EXECUTION_LOCK,
  BROWSER_EXECUTION_SAFETY_KEY,
} from './browser-execution-lock';
import { AUTH_STORAGE_KEY, BROWSER_PROVIDER_IDENTITY_KEY } from '@/src/shared/auth';
import {
  BROWSER_PROVIDER_SETTINGS_KEY,
  browserAccountKey,
} from '@/src/shared/browser-provider-settings';
import { BROWSER_TASK_STORAGE_KEY } from '@/src/shared/browser-task-store';
import { AGENT_MEMORIES_STORAGE_KEY, loadAgentMemories } from '@/src/shared/agent-memories-storage';
import {
  AGENT_WORKFLOWS_STORAGE_KEY,
  loadAgentWorkflows,
} from '@/src/shared/agent-workflows-storage';
import { createAssistantMessage } from '@/src/shared/agent-conversation';
import { normalizeStoredConversationStore } from './agent-conversation-storage';
import { LIST_INSPECTABLE_TABS_MESSAGE } from '@/src/shared/tab-debugger';

const scopeAtom = atom('unset');
const AgentsProbe = () => {
  const [scope, setScope] = useAtom(scopeAtom);
  const [view, setView] = useState('list');
  const store = useStore();
  const context = useExtensionAgents();
  const error = useAtomValue(context.manager.atoms.error);
  useEffect(() => {
    fixture.agents = context;
  }, [context]);
  return (
    <div>
      <p>Agents scope: {scope}</p>
      <p>Agents view: {view}</p>
      <p>Agents organization: {context.organizationId ?? 'personal'}</p>
      <p>Manager store: {store === context.store ? 'matched' : 'mismatched'}</p>
      <p>Manager error: {error ?? 'none'}</p>
      <button
        onClick={() => {
          setScope('private');
          setView('session');
          store.set(context.manager.atoms.error, 'Previous scope error');
        }}
        type="button"
      >
        Set Agents state
      </button>
      <button
        onClick={() => {
          context.manager.clearError();
        }}
        type="button"
      >
        Clear manager error
      </button>
    </div>
  );
};
const auth = { token: 'tree-test-token', userEmail: 'tree@example.test' };
const identity = {
  label: 'Work profile',
  providerId: 'bp_11111111-1111-4111-8111-111111111111' as const,
  providerProof: 'a'.repeat(64),
  version: 1,
};
const outcome = (summary = 'Observed the requested page.'): LlmTurnOutcome => ({
  effectsUncertain: false,
  reason: 'completed',
  status: 'succeeded',
  summary,
  toolResults: [],
});
const waitForAbort = async (context: BrowserRunContext): Promise<LlmTurnOutcome> => {
  const stopped = Promise.withResolvers<void>();
  context.abort.signal.addEventListener(
    'abort',
    () => {
      stopped.resolve();
    },
    { once: true }
  );
  if (context.abort.signal.aborted) {
    stopped.resolve();
  }
  await stopped.promise;
  context.executionGuard();
  return outcome();
};
type Delivery = Extract<BrowserProviderInboundMessage, { type: 'provider_job' }>;
const relay = () => {
  let state: BrowserProviderState = { status: 'ready' };
  let generation = 0;
  let retained = 0;
  // eslint-disable-next-line init-declarations -- Only explicit enablement creates a registration.
  let registration: BrowserProviderRegistration | undefined;
  const rows = new Map<string, BrowserJobSnapshot>();
  const messages = new Set<(message: BrowserProviderInboundMessage) => void>();
  const states = new Set<(state: BrowserProviderState) => void>();
  const send = (message: BrowserProviderInboundMessage): void => {
    for (const listener of messages) {
      listener(structuredClone(message));
    }
  };
  const setState = (next: BrowserProviderState): void => {
    state = next;
    for (const listener of states) {
      listener(next);
    }
  };
  const snapshot = () => ({
    generation,
    jobs: [...rows.values()].filter(job => job.generation === generation),
    providerId: identity.providerId,
    type: 'provider_snapshot' as const,
  });
  const publish = (): void => {
    send(snapshot());
  };
  const renew = () => {
    const lease = {
      generation,
      leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(),
      providerId: identity.providerId,
      requestId: crypto.randomUUID(),
      type: 'provider_lease_ack' as const,
    };
    setState({ lease, status: 'registered' });
    return lease;
  };
  const settle = (job: BrowserJobSnapshot, result: BrowserResult): void => {
    rows.set(job.jobId, { ...job, queuePosition: undefined, result, status: result.status });
    publish();
  };
  const stop = (
    job: BrowserJobSnapshot,
    reason: Exclude<BrowserResult['reason'], 'completed'>
  ): void => {
    settle(job, {
      browserTaskId: job.browserTaskId,
      effectsUncertain: false,
      evidence: [],
      invocationId: job.invocationId,
      jobId: job.jobId,
      providerId: job.providerId,
      reason,
      status: reason === 'cancelled' ? 'cancelled' : 'interrupted',
      summary: `Stopped: ${reason}. Issued actions are not undone.`,
    });
  };
  const connection = {
    approveBrowserProviderJob: (input: BrowserProviderApprovalInput) => {
      const job = rows.get(input.jobId);
      if (job === undefined) {
        throw new Error('Unknown invocation.');
      }
      if (input.approval.decision === 'denied') {
        stop(job, 'approval_denied');
        return;
      }
      rows.set(job.jobId, {
        ...job,
        approvedTab: input.approval.tab,
        deadlines: { ...job.deadlines, execution: new Date(Date.now() + 600_000).toISOString() },
        status: 'running',
      });
      publish();
    },
    cancelBrowserProviderJob: (input: BrowserProviderCancelInput) => {
      const job = rows.get(input.jobId);
      if (job !== undefined) {
        stop(job, 'cancelled');
      }
    },
    getBrowserProviderState: () => state,
    heartbeatBrowserProvider: async () => {
      renew();
      return snapshot();
    },
    markBrowserProviderUnavailable: (input: BrowserProviderUnavailableInput) => {
      setState({ reason: input.reason, retryable: true, status: 'unavailable' });
      for (const job of rows.values()) {
        if (job.result === undefined) {
          stop(job, input.reason);
        }
      }
    },
    onBrowserProviderMessage: (listener: (message: BrowserProviderInboundMessage) => void) => {
      messages.add(listener);
      return () => {
        messages.delete(listener);
      };
    },
    onBrowserProviderStateChange: (listener: (state: BrowserProviderState) => void) => {
      states.add(listener);
      return () => {
        states.delete(listener);
      };
    },
    quiesceBrowserProviderJob: (_input: BrowserProviderQuiescenceInput) => {
      publish();
    },
    registerBrowserProvider: async (input: BrowserProviderRegistration) => {
      registration = input;
      generation += 1;
      return renew();
    },
    requestBrowserProviderStatus: async () => ({
      jobs: [...rows.values()],
      providerId: identity.providerId,
      requestId: crypto.randomUUID(),
      type: 'provider_status_result' as const,
    }),
    retain: () => {
      fixture.retained += 1;
      retained += 1;
      return () => {
        fixture.retained -= 1;
        retained -= 1;
      };
    },
    retryConnection: () => {
      setState({ status: 'ready' });
    },
    sendBrowserProviderResult: (input: BrowserProviderResultInput) => {
      const job = rows.get(input.jobId);
      if (job === undefined) {
        throw new Error('Unknown invocation.');
      }
      settle(job, input.result);
    },
  };
  const delivery = (): Delivery => {
    const now = Date.now();
    return {
      conversationMode: 'new',
      goal: 'Inspect the approved page for this parent.',
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
        ownerLabel: 'ses_parent_12345678',
        payloadFingerprint: 'a'.repeat(64),
        providerId: identity.providerId,
        status: 'awaiting_approval',
      },
      ownerLabel: 'ses_parent_12345678',
      type: 'provider_job',
    };
  };
  return {
    connection,
    delivery,
    dispatch: (message: Delivery) => {
      rows.set(message.job.jobId, message.job);
      send(message);
    },
    publish,
    registration: () => registration,
    retained: () => retained,
    rows,
  };
};
const clients: QueryClient[] = [];
const renderPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const panel = (currentAuth: StoredAuth) => (
    <QueryClientProvider client={client}>
      <SignedInView auth={currentAuth} onSignOut={vi.fn()} />
    </QueryClientProvider>
  );
  const view = render(panel(auth));
  return {
    ...view,
    rerender: (currentAuth = auth) => {
      view.rerender(panel(currentAuth));
    },
  };
};
const openSettings = async () => {
  const trigger = screen.getByRole('button', { name: 'Settings' });
  trigger.focus();
  fireEvent.click(trigger);
  return screen.findByRole('dialog', { name: 'Settings panel' });
};
const enable = async (phase = 'Enabled — idle'): Promise<void> => {
  await screen.findByText('CLI tasks: Disabled');
  const dialog = await openSettings();
  const settings = within(dialog).getByRole('region', { name: 'CLI task settings' });
  expect(
    within(settings).getByRole<HTMLButtonElement>('switch', { name: 'CLI tasks' }).disabled
  ).toBe(true);
  fireEvent.click(within(settings).getByRole('button', { name: 'Model' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Selected model' }));
  await waitFor(() => {
    expect(
      within(settings).getByRole<HTMLButtonElement>('switch', { name: 'CLI tasks' }).disabled
    ).toBe(false);
  });
  fireEvent.click(within(settings).getByRole('switch', { name: 'CLI tasks' }));
  await waitFor(() => {
    expect(within(dialog).getByText(`CLI tasks: ${phase}`)).toBeDefined();
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close settings' }));
};
const approve = async (): Promise<void> => {
  await screen.findByRole('button', { name: 'Approve tab' });
  await screen.findByRole('option', { name: 'Approved tab' });
  fireEvent.change(screen.getByLabelText('Tab to approve'), { target: { value: '7' } });
  const approvalButton = screen.getByRole('button', { name: 'Approve tab' });
  approvalButton.focus();
  fireEvent.click(approvalButton);
  await screen.findByText('CLI tasks: Running');
};
const switchMode = (mode: 'agents' | 'browser'): void => {
  fireEvent.click(screen.getByRole('tab', { name: mode === 'agents' ? 'Agents beta' : 'Browser' }));
};

describe('browser task provider tree', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: nativeLocks });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal('crypto', webcrypto);
    fixture.agents = undefined;
    fixture.connectionConfigs = [];
    fixture.connections = 0;
    fixture.failedReadKey = '';
    fixture.organizationId = '';
    fixture.retained = 0;
    fixture.values.clear();
    fixture.values.set(AUTH_STORAGE_KEY, auth);
    fixture.values.set(BROWSER_PROVIDER_IDENTITY_KEY, identity);
    fixture.tabs = [{ id: 7, title: 'Approved tab', url: 'https://example.test/' }];
    fixture.waitWrite = undefined;
    fixture.waitWriteKey = '';
    fixture.turn = async (context, _events) => {
      context.executionGuard();
      context.appendEvents([createAssistantMessage('Observed the requested page.')]);
      return outcome();
    };
    getDefaultStore().set(scopeAtom, 'browser');
    getDefaultStore().set(settingsDialogOpenAtom, false);
    getDefaultStore().set(workflowRunRequestAtom, undefined);
    getDefaultStore().set(pendingApprovalAtom, undefined);
    getDefaultStore().set(pendingLockAtom, false);
    clearPerConversationAtoms();
  });
  afterEach(async () => {
    cleanup();
    for (const client of clients.splice(0)) {
      client.clear();
    }
    await waitFor(async () => {
      const locks = await nativeLocks.query();
      expect(
        locks.held?.filter(
          lock => lock.name === PROVIDER_OWNER_LOCK || lock.name === BROWSER_EXECUTION_LOCK
        )
      ).toHaveLength(0);
      expect(fixture.retained).toBe(0);
    });
    vi.unstubAllGlobals();
  });

  it.each([
    { name: 'new profile', savedSettings: undefined },
    {
      name: 'saved disabled profile',
      savedSettings: {
        enabled: false,
        mode: 'dangerous',
        model: 'other-model',
        thinkingEffort: 'high',
      },
    },
    {
      name: 'saved enabled profile',
      savedSettings: {
        enabled: true,
        mode: 'safe',
        model: 'selected-model',
        thinkingEffort: 'low',
      },
    },
  ] as const)(
    'reloads a $name after storage initialization fails without changing consent or safety',
    async ({ savedSettings }) => {
      const transport = relay();
      fixture.connection = transport.connection;
      const expectedSettings = savedSettings ?? {
        enabled: false,
        mode: 'safe',
        model: '',
        thinkingEffort: '',
      };
      const record = {
        accountKey: await browserAccountKey(auth),
        settings: expectedSettings,
        version: 1,
      };
      if (savedSettings === undefined) {
        fixture.values.delete(BROWSER_PROVIDER_IDENTITY_KEY);
      } else {
        fixture.values.set(BROWSER_PROVIDER_SETTINGS_KEY, record);
      }
      const safety = { allTabs: true, tabIds: [7], version: 1 };
      fixture.values.set(BROWSER_EXECUTION_SAFETY_KEY, safety);
      fixture.failedReadKey = BROWSER_PROVIDER_SETTINGS_KEY;
      const panel = renderPanel();
      await screen.findByText('CLI tasks: Unavailable');
      expect(screen.queryByRole('button', { name: 'Refresh status' })).toBeNull();
      expect(transport.registration()).toBeUndefined();
      const profile = structuredClone(fixture.values.get(BROWSER_PROVIDER_IDENTITY_KEY));
      fixture.failedReadKey = '';
      // Native navigation is unavailable in jsdom. Unmount on reload, then remount after disposal.
      vi.stubGlobal('location', { reload: panel.unmount });
      fireEvent.click(screen.getByRole('button', { name: 'Reload panel' }));
      await waitFor(async () => {
        expect(screen.queryByRole('region', { name: 'CLI task supervision' })).toBeNull();
        const locks = await nativeLocks.query();
        expect(locks.held?.filter(lock => lock.name === PROVIDER_OWNER_LOCK)).toHaveLength(0);
      });
      renderPanel();
      await screen.findByText(
        expectedSettings.enabled ? 'CLI tasks: Recovery required' : 'CLI tasks: Disabled'
      );
      expect(fixture.values.get(AUTH_STORAGE_KEY)).toStrictEqual(auth);
      expect(fixture.values.get(BROWSER_PROVIDER_IDENTITY_KEY)).toStrictEqual(profile);
      expect(fixture.values.get(BROWSER_PROVIDER_SETTINGS_KEY)).toStrictEqual(record);
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual(safety);
      expect(transport.rows.size).toBe(0);
      expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reload panel' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
      expect(transport.registration()?.providerId).toBe(
        expectedSettings.enabled ? identity.providerId : undefined
      );
      const dialog = await openSettings();
      const settings = within(dialog).getByRole('region', { name: 'CLI task settings' });
      expect(
        within(settings).getByRole('switch', { name: 'CLI tasks' }).getAttribute('aria-checked')
      ).toBe(String(expectedSettings.enabled));
    }
  );

  it('stays off by default, preserves Browser drafts, and keeps one transport and a private Agents store', async () => {
    const transport = relay();
    fixture.connection = transport.connection;
    renderPanel();
    await screen.findByText('CLI tasks: Disabled');
    expect(transport.registration()).toBeUndefined();
    await enable();
    const composer = screen.getByRole('textbox', { name: 'Message agent' });
    fireEvent.change(composer, { target: { value: 'Keep this unsent Browser draft' } });
    const conversationId = getDefaultStore().get(activeConversationIdAtom);
    expect(conversationId).toBeDefined();
    switchMode('agents');
    await expect(screen.findByText('Agents scope: unset')).resolves.toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Set Agents state' }));
    expect(screen.getByText('Manager store: matched')).toBeDefined();
    switchMode('browser');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message agent' }).value).toBe(
      'Keep this unsent Browser draft'
    );
    expect(getDefaultStore().get(scopeAtom)).toBe('browser');
    expect(getDefaultStore().get(draftAtomFamily(conversationId!))).toBe(
      'Keep this unsent Browser draft'
    );
    switchMode('agents');
    expect(screen.getByText('Agents scope: private')).toBeDefined();
    expect(screen.getByText(/Profile: Work profile/u).textContent).toContain(identity.providerId);
    expect(transport.registration()).toMatchObject({
      label: identity.label,
      providerId: identity.providerId,
    });
    expect(fixture.connections).toBe(1);
  });

  it.each(['organization', 'account'] as const)(
    'waits for %s replacement drainage before recovery in the same panel',
    async scope => {
      const transport = relay();
      fixture.connection = transport.connection;
      fixture.organizationId = 'organization-before';
      const entered = Promise.withResolvers<BrowserRunContext>();
      const action = Promise.withResolvers<void>();
      const effects: string[] = [];
      fixture.turn = async context => {
        context.executionGuard();
        effects.push('issued action');
        entered.resolve(context);
        await action.promise;
        context.executionGuard();
        effects.push('stale action');
        return outcome();
      };
      const panel = renderPanel();
      try {
        await enable();
        const supervision = screen.getByRole('region', { name: 'CLI task supervision' });
        switchMode('agents');
        fireEvent.click(screen.getByRole('button', { name: 'Set Agents state' }));
        const previous = fixture.agents;
        expect(screen.getByText('Agents scope: private')).toBeDefined();
        expect(screen.getByText('Agents view: session')).toBeDefined();
        expect(screen.getByText('Manager error: Previous scope error')).toBeDefined();
        const request = transport.delivery();
        act(() => {
          transport.dispatch(request);
        });
        await approve();
        const oldRun = await entered.promise;
        const queued = transport.delivery().job;
        act(() => {
          transport.rows.set(queued.jobId, { ...queued, queuePosition: 1, status: 'queued' });
          transport.publish();
        });
        const replacement = relay();
        const nextAuth =
          scope === 'account'
            ? { token: 'replacement-token', userEmail: 'replacement@example.test' }
            : auth;
        fixture.connection = replacement.connection;
        fixture.organizationId =
          scope === 'organization' ? 'organization-after' : 'organization-before';
        await act(async () => {
          await storage.setItem(
            scope === 'account' ? AUTH_STORAGE_KEY : 'local:kiloSelectedOrganizationId',
            scope === 'account' ? nextAuth : fixture.organizationId
          );
          panel.rerender(nextAuth);
        });
        await waitFor(() => {
          expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
          expect(transport.retained()).toBe(0);
        });
        expect(oldRun.abort.signal.aborted).toBe(true);
        const locks = await nativeLocks.query();
        expect(locks.held).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: PROVIDER_OWNER_LOCK }),
            expect.objectContaining({ name: BROWSER_EXECUTION_LOCK }),
          ])
        );
        expect(replacement.registration()).toBeUndefined();
        expect(replacement.retained()).toBe(1);
        expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
        expect(transport.rows.get(request.job.jobId)?.status).toBe('interrupted');
        expect(transport.rows.get(queued.jobId)?.status).toBe('interrupted');
        if (scope === 'organization') {
          for (const job of transport.rows.values()) {
            replacement.rows.set(job.jobId, job);
          }
        }
        await act(async () => {
          action.resolve();
          await action.promise;
        });
        await screen.findByText(
          scope === 'account' ? 'CLI tasks: Disabled' : 'CLI tasks: Recovery required'
        );
        expect(replacement.registration()?.providerId).toBe(
          scope === 'account' ? undefined : identity.providerId
        );
        if (scope === 'account') {
          await enable('Recovery required');
        }
        await screen.findByText('CLI tasks: Recovery required');
        expect(screen.getByRole('region', { name: 'CLI task supervision' })).toBe(supervision);
        expect(screen.queryByText('CLI tasks: Owned by another panel')).toBeNull();
        expect(screen.getByText('Agents scope: unset')).toBeDefined();
        expect(screen.getByText('Agents view: list')).toBeDefined();
        expect(screen.getByText(`Agents organization: ${fixture.organizationId}`)).toBeDefined();
        expect(screen.getByText('Manager store: matched')).toBeDefined();
        expect(screen.getByText('Manager error: none')).toBeDefined();
        expect(fixture.agents?.manager).not.toBe(previous?.manager);
        expect(fixture.agents?.store).not.toBe(previous?.store);
        expect(fixture.agents?.userWebConnection).not.toBe(previous?.userWebConnection);
        await expect(fixture.connectionConfigs.at(-1)?.getAuthToken()).resolves.toBe(
          `ticket:${nextAuth.token}`
        );
        await expect(
          fixture.agents?.trpcClient.activeSessions.createWebTicket.mutate()
        ).resolves.toStrictEqual({ token: `ticket:${nextAuth.token}` });
        fireEvent.click(screen.getByRole('button', { name: 'Set Agents state' }));
        fireEvent.click(screen.getByRole('button', { name: 'Clear manager error' }));
        expect(screen.getByText('Manager error: none')).toBeDefined();
        expect(getDefaultStore().get(scopeAtom)).toBe('browser');
        expect(replacement.retained()).toBe(2);
        expect(fixture.connections).toBe(2);
        expect(effects).toStrictEqual(['issued action']);
        expect(screen.getByText('Queue empty.')).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: 'Check recovery readiness' }));
        await screen.findByText('Close all affected tabs before recovery.');
        expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
        fixture.tabs = [];
        fireEvent.click(screen.getByRole('button', { name: 'Check recovery readiness' }));
        const recover = await screen.findByRole('button', { name: 'Recover browser control' });
        expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
        expect(effects).toStrictEqual(['issued action']);
        fireEvent.click(recover);
        await screen.findByText('CLI tasks: Enabled — idle');
        expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
          tabIds: [],
          version: 1,
        });
        expect(effects).toStrictEqual(['issued action']);
        expect(transport.rows.get(request.job.jobId)?.status).toBe('interrupted');
        expect(transport.rows.get(queued.jobId)?.status).toBe('interrupted');
        expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
        const fresh = Promise.withResolvers<BrowserRunContext>();
        fixture.turn = async context => {
          context.executionGuard();
          effects.push('new invocation');
          fresh.resolve(context);
          return waitForAbort(context);
        };
        fixture.tabs = [{ id: 7, title: 'Approved tab', url: 'https://example.test/' }];
        act(() => {
          replacement.dispatch(replacement.delivery());
        });
        await screen.findByRole('button', { name: 'Approve tab' });
        expect(effects).toStrictEqual(['issued action']);
        await approve();
        const currentRun = await fresh.promise;
        expect(currentRun.token).toBe(nextAuth.token);
        expect(currentRun.organizationId).toBe(fixture.organizationId);
        expect(effects).toStrictEqual(['issued action', 'new invocation']);
        fireEvent.click(screen.getByRole('button', { name: 'Stop CLI task' }));
        await screen.findByText('Last outcome: cancelled · cancelled');
        expect(transport.retained()).toBe(0);
        expect(fixture.connections).toBe(2);
      } finally {
        action.resolve();
      }
    }
  );

  it('retains the first disposal barrier through another scope change during drainage', async () => {
    const transport = relay();
    fixture.connection = transport.connection;
    const entered = Promise.withResolvers<void>();
    const action = Promise.withResolvers<void>();
    fixture.turn = async context => {
      entered.resolve();
      await action.promise;
      context.executionGuard();
      return outcome();
    };
    const panel = renderPanel();
    try {
      await enable();
      act(() => {
        transport.dispatch(transport.delivery());
      });
      await approve();
      await entered.promise;
      fixture.connection = relay().connection;
      fixture.organizationId = 'organization-next';
      await act(async () => {
        await storage.setItem('local:kiloSelectedOrganizationId', fixture.organizationId);
        panel.rerender();
      });
      await waitFor(() => {
        expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
        expect(transport.retained()).toBe(0);
      });
      fixture.connection = relay().connection;
      fixture.organizationId = 'organization-latest';
      await act(async () => {
        await storage.setItem('local:kiloSelectedOrganizationId', fixture.organizationId);
        panel.rerender();
      });
      await act(async () => {
        action.resolve();
        await action.promise;
      });
      await waitFor(() => {
        expect(screen.getByText(/^CLI tasks:/u).textContent).toBe('CLI tasks: Recovery required');
      });
      expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
    } finally {
      action.resolve();
    }
  });

  it('keeps a running invocation and frozen settings across modes and settings confirmation', async () => {
    const transport = relay();
    fixture.connection = transport.connection;
    fixture.turn = waitForAbort;
    renderPanel();
    await enable();
    const request = transport.delivery();
    act(() => {
      transport.dispatch(request);
    });
    switchMode('agents');
    await approve();
    const settingsDialog = await openSettings();
    const settings = within(settingsDialog).getByRole('region', { name: 'CLI task settings' });
    const settingsWrite = Promise.withResolvers<void>();
    fixture.waitWriteKey = BROWSER_PROVIDER_SETTINGS_KEY;
    fixture.waitWrite = settingsWrite.promise;
    try {
      fireEvent.click(within(settings).getByRole('button', { name: /Safe mode:/u }));
      fireEvent.click(within(settings).getByRole('button', { name: /Dangerous/u }));
      await within(settings).findByText('Saving CLI task settings...');
      const savingStop = within(settingsDialog).getByRole('button', { name: 'Stop CLI task' });
      savingStop.focus();
      expect(document.activeElement).toBe(savingStop);
    } finally {
      await act(async () => {
        settingsWrite.resolve();
        await settingsWrite.promise;
      });
      fixture.waitWriteKey = '';
    }
    await waitFor(() => {
      expect(within(settings).getByRole('button', { name: /Danger mode:/u })).toBeDefined();
    });
    expect(within(settingsDialog).getByText('Mode: Safe · Model: selected-model')).toBeDefined();
    fireEvent.click(within(settings).getByRole('switch', { name: 'CLI tasks' }));
    expect(
      within(settings).getByText(
        'Disabling CLI tasks terminates active and queued jobs. Issued actions are not undone.'
      )
    ).toBeDefined();
    const stop = within(settingsDialog).getByRole('button', { name: 'Stop CLI task' });
    stop.focus();
    expect(document.activeElement).toBe(stop);
    fireEvent.click(within(settings).getByRole('button', { name: 'Keep enabled' }));
    expect(transport.rows.get(request.job.jobId)?.status).toBe('running');
    fireEvent.click(within(settingsDialog).getByRole('button', { name: 'Close settings' }));
    switchMode('browser');
    expect(screen.getByText('Bound tab: Approved tab (ID 7)')).toBeDefined();
    expect(fixture.connections).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop CLI task' }));
    await screen.findByText('Last outcome: cancelled · cancelled');
    expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
  });

  it.each(['browser', 'agents'] as const)(
    'settles real memory approval and keeps Stop through saving and confirmation in %s mode',
    async mode => {
      const transport = relay();
      fixture.connection = transport.connection;
      fixture.turn = async context => {
        await context.requestApproval('memory', {
          createdAt: Date.now(),
          pageTitle: 'Approved tab',
          pageUrl: 'https://example.test/',
          text: 'Remember this approved fact.',
        });
        return waitForAbort(context);
      };
      renderPanel();
      await enable();
      switchMode(mode);
      act(() => {
        transport.dispatch(transport.delivery());
      });
      await approve();
      const dialog = await screen.findByRole('dialog', { name: 'Add to memory' });
      const write = Promise.withResolvers<void>();
      fixture.waitWriteKey = AGENT_MEMORIES_STORAGE_KEY;
      fixture.waitWrite = write.promise;
      try {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save memory' }));
        await waitFor(() => {
          expect(
            within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Save memory' }).disabled
          ).toBe(true);
        });
        const stop = within(dialog).getByRole('button', { name: 'Stop CLI task' });
        stop.focus();
        expect(document.activeElement).toBe(stop);
        await act(async () => {
          write.resolve();
          await write.promise;
        });
        await within(dialog).findByText('Saved to memory');
        await expect(loadAgentMemories(storage)).resolves.toStrictEqual([
          expect.objectContaining({ text: 'Remember this approved fact.' }),
        ]);
        expect(getDefaultStore().get(pendingApprovalAtom)).toBeUndefined();
        expect(getDefaultStore().get(pendingLockAtom)).toBe(false);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Stop CLI task' }));
        await within(dialog).findByText('Last outcome: cancelled · cancelled');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
        await waitFor(() => {
          expect(document.activeElement).toBe(
            screen.getByRole('tab', { name: mode === 'agents' ? 'Agents beta' : 'Browser' })
          );
        });
        switchMode(mode === 'agents' ? 'browser' : 'agents');
        expect(screen.queryByRole('dialog', { name: 'Add to memory' })).toBeNull();
      } finally {
        write.resolve();
      }
    }
  );

  it.each(['browser', 'agents'] as const)(
    'settles real workflow approval on the default store in %s mode',
    async mode => {
      const transport = relay();
      fixture.connection = transport.connection;
      fixture.turn = async context => {
        await context.requestApproval('workflow', {
          createdAt: Date.now(),
          description: 'Read a fact',
          name: 'Approved workflow',
          scopeOrigin: 'https://example.test',
          script: 'return { done: true, result: "fact" };',
        });
        return waitForAbort(context);
      };
      renderPanel();
      await enable();
      switchMode(mode);
      act(() => {
        transport.dispatch(transport.delivery());
      });
      await approve();
      const dialog = await screen.findByRole('dialog', { name: 'Save workflow' });
      const write = Promise.withResolvers<void>();
      fixture.waitWriteKey = AGENT_WORKFLOWS_STORAGE_KEY;
      fixture.waitWrite = write.promise;
      try {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and save' }));
        await within(dialog).findByRole('button', { name: 'Saving...' });
        const stop = within(dialog).getByRole('button', { name: 'Stop CLI task' });
        stop.focus();
        expect(document.activeElement).toBe(stop);
        await act(async () => {
          write.resolve();
          await write.promise;
        });
        await waitFor(() => {
          expect(screen.queryByRole('dialog', { name: 'Save workflow' })).toBeNull();
        });
        const saved = await loadAgentWorkflows(storage);
        expect(saved).toStrictEqual([
          expect.objectContaining({
            approvedScriptHash: createHash('sha256')
              .update('return { done: true, result: "fact" };')
              .digest('hex'),
            name: 'Approved workflow',
          }),
        ]);
        expect(getDefaultStore().get(pendingApprovalAtom)).toBeUndefined();
        expect(getDefaultStore().get(pendingLockAtom)).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Stop CLI task' }));
        await screen.findByText('Last outcome: cancelled · cancelled');
        switchMode(mode === 'agents' ? 'browser' : 'agents');
        expect(screen.queryByRole('dialog', { name: 'Save workflow' })).toBeNull();
      } finally {
        write.resolve();
      }
    }
  );

  it.each(['browser', 'agents'] as const)(
    'consumes a settings workflow request in the mounted Browser chat while %s mode is visible',
    async mode => {
      const transport = relay();
      fixture.connection = transport.connection;
      const script = 'return { done: true, result: input };';
      fixture.values.set(AGENT_WORKFLOWS_STORAGE_KEY, [
        {
          approvedScriptHash: createHash('sha256').update(script).digest('hex'),
          createdAt: 1,
          description: 'Read the page',
          id: 'workflow-1',
          name: 'Read page',
          params: [{ description: 'Value to read', name: 'value', required: true }],
          scopeOrigin: 'https://example.test',
          script,
          updatedAt: 1,
        },
      ]);
      fixture.values.set('local:kiloWorkflowSettings', {
        allowWorkflowsInSafeMode: true,
        autoApproveWorkflowChanges: false,
        autoApproveWorkflowRuns: false,
      });
      renderPanel();
      await screen.findByText('CLI tasks: Disabled');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Model' }).dataset['modelId']).toBe(
          'selected-model'
        );
      });
      switchMode(mode);
      const settings = await openSettings();
      fireEvent.click(
        await within(settings).findByRole('button', { name: 'Run workflow "Read page"' })
      );
      const prompt = await screen.findByRole('dialog', { name: 'Run workflow "Read page"' });
      fireEvent.change(within(prompt).getByRole('textbox'), {
        target: { value: 'retained workflow input' },
      });
      fireEvent.click(within(prompt).getByRole('button', { name: 'Run' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Settings panel' })).toBeNull();
      });
      await waitFor(() => {
        const conversations = normalizeStoredConversationStore(
          fixture.values.get('local:kiloAgentConversations')
        );
        expect(
          conversations?.conversations.flatMap(conversation => conversation.events)
        ).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({
              arguments: { input: { value: 'retained workflow input' }, workflowId: 'workflow-1' },
              name: 'run_workflow',
              type: 'tool-call',
            }),
            expect.objectContaining({ text: 'Observed the requested page.', type: 'message' }),
          ])
        );
      });
      expect(getDefaultStore().get(workflowRunRequestAtom)).toBeUndefined();
      expect(fixture.values.has(BROWSER_TASK_STORAGE_KEY)).toBe(true);
      switchMode(mode === 'agents' ? 'browser' : 'agents');
      expect(getDefaultStore().get(workflowRunRequestAtom)).toBeUndefined();
    }
  );

  it('prepares real all-tabs recovery without clearing quarantine or replaying work', async () => {
    const transport = relay();
    fixture.connection = transport.connection;
    renderPanel();
    await enable();
    await act(async () => {
      await storage.setItem(BROWSER_EXECUTION_SAFETY_KEY, {
        allTabs: true,
        tabIds: [7],
        version: 1,
      });
    });
    await screen.findByText('CLI tasks: Recovery required');
    fireEvent.click(screen.getByRole('button', { name: 'Check recovery readiness' }));
    await screen.findByText(
      'Close all target tabs before recovery. The affected-tab list is not known to be complete.'
    );
    expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
    fixture.tabs = [];
    fireEvent.click(screen.getByRole('button', { name: 'Check recovery readiness' }));
    const recover = await screen.findByRole('button', { name: 'Recover browser control' });
    expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      allTabs: true,
      tabIds: [7],
      version: 1,
    });
    expect(transport.rows.size).toBe(0);
    fireEvent.click(recover);
    await screen.findByText('CLI tasks: Enabled — idle');
    expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toStrictEqual({
      tabIds: [],
      version: 1,
    });
    expect(transport.rows.size).toBe(0);
    expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
  });

  it('confirms disablement before terminating active and queued jobs without clearing quarantine', async () => {
    const transport = relay();
    fixture.connection = transport.connection;
    fixture.turn = waitForAbort;
    renderPanel();
    await enable();
    const request = transport.delivery();
    act(() => {
      transport.dispatch(request);
    });
    await approve();
    const queued = transport.delivery().job;
    act(() => {
      transport.rows.set(queued.jobId, {
        ...queued,
        ownerLabel: 'ses_other_87654321',
        queuePosition: 1,
        status: 'queued',
      });
      transport.publish();
    });
    const dialog = await openSettings();
    const settings = within(dialog).getByRole('region', { name: 'CLI task settings' });
    fireEvent.click(within(settings).getByRole('switch', { name: 'CLI tasks' }));
    expect(transport.rows.get(request.job.jobId)?.status).toBe('running');
    expect(transport.rows.get(queued.jobId)?.status).toBe('queued');
    expect(within(dialog).getByRole('button', { name: 'Stop CLI task' })).toBeDefined();
    fireEvent.click(within(settings).getByRole('button', { name: 'Disable CLI tasks' }));
    await waitFor(() => {
      expect(within(dialog).getByText('CLI tasks: Disabled')).toBeDefined();
    });
    expect(transport.rows.get(request.job.jobId)?.status).toBe('interrupted');
    expect(transport.rows.get(queued.jobId)?.status).toBe('interrupted');
    expect(fixture.values.get(BROWSER_PROVIDER_SETTINGS_KEY)).toMatchObject({
      settings: { enabled: false },
    });
    await waitFor(() => {
      expect(fixture.values.get(BROWSER_EXECUTION_SAFETY_KEY)).toMatchObject({ tabIds: [7] });
    });
    expect(within(dialog).queryByRole('button', { name: 'Recover browser control' })).toBeNull();
  });
});
