/* eslint-disable max-lines, import/max-dependencies, import/first, jest/no-hooks, jest/no-untyped-mock-factory, jest/max-expects, vitest/prefer-import-in-mock, typescript/consistent-type-definitions, typescript/no-unsafe-type-assertion, require-await, typescript/require-await -- State fixtures exercise the controls; the separate tree suite uses the real provider and stores. */
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserJobSnapshot, BrowserResult } from '@kilocode/cloud-agent-sdk/schemas';
import type { storage as wxtStorage } from '#imports';
import type {
  BrowserTaskProviderRuntime,
  BrowserTaskProviderSnapshot,
} from './browser-task-provider';
import type { BrowserExecutionSnapshot } from './browser-execution-lock';
import type { InspectableTab } from '@/src/shared/tab-debugger';
import type { StoredAgentConversationStore } from '@/src/shared/agent-conversation-tabs';
import type { BrowserProviderSettings } from '@/src/shared/browser-provider-settings';

const fixture = vi.hoisted(() => ({
  execution: {} as BrowserExecutionSnapshot,
  listeners: new Set<() => void>(),
  readiness: { ready: false, reason: 'Close the affected tab before recovery.' },
  runtime: undefined as
    | Pick<BrowserTaskProviderRuntime, 'getSnapshot' | 'setSettings' | 'subscribe'>
    | undefined,
  state: {} as BrowserTaskProviderSnapshot,
  tabs: [] as InspectableTab[],
  tabsUnavailable: false,
}));
vi.mock('#imports', async importOriginal => ({
  ...(await importOriginal<{ storage: typeof wxtStorage }>()),
  browser: {
    tabs: {
      query: async () => {
        if (fixture.tabsUnavailable) {
          throw new Error('Tab access unavailable.');
        }
        return fixture.tabs;
      },
    },
  },
}));
vi.mock('./browser-task-provider', () => ({
  useBrowserTask: () => {
    const runtime = fixture.runtime ?? {
      getSnapshot: () => fixture.state,
      subscribe: (listener: () => void) => {
        fixture.listeners.add(listener);
        return () => {
          fixture.listeners.delete(listener);
        };
      },
    };
    return {
      ...actions,
      ...runtime,
      state: useSyncExternalStore(runtime.subscribe, runtime.getSnapshot),
    };
  },
}));
vi.mock(import('./browser-execution-lock'), async importOriginal => ({
  ...(await importOriginal()),
  useBrowserExecutionSnapshot: () => fixture.execution,
}));
vi.mock('./browser-task-runner', () => ({ getBrowserTaskTabs: async () => fixture.tabs }));
vi.mock('./use-model-preferences', () => ({
  useModelPreferences: () => ({
    favorites: new Set<string>(),
    refetch: vi.fn(),
    status: 'ready',
    toggleError: false,
    toggleFavorite: vi.fn(),
  }),
}));
vi.mock('./use-gateway-models', () => ({
  useGatewayModels: () => ({
    isLoading: false,
    modelLoadError: undefined,
    modelOptions: [
      {
        id: 'selected-model',
        isPreferred: false,
        name: 'Selected model',
        variants: ['low', 'high'],
      },
      { id: 'other-model', isPreferred: false, name: 'Other model', variants: [] },
    ],
    refetchModels: vi.fn(),
  }),
}));
vi.mock('./use-tab-debugger', () => ({
  useTabDebugger: () => ({
    inspectableTabs: fixture.tabs,
    isLoadingTabs: false,
    selectTab: vi.fn(),
    selectedTabId: undefined,
    tabDebuggerError: undefined,
  }),
}));

import {
  BrowserTaskControls,
  BrowserTaskSettings,
  BrowserTaskSurface,
} from './browser-task-controls';
import { BrowserTaskSupervisionSlot } from './browser-task-supervision-slot';
import { ModelPicker } from './model-picker';
import { ConversationHistoryButton } from './conversation-history-button';
import { WorkflowRunPrompt } from './workflow-run-prompt';

const job = (suffix = 'abcdefgh'): BrowserJobSnapshot => ({
  browserTaskId: `bt_${suffix}`,
  createdAt: '2026-08-29T20:00:00.000Z',
  deadlines: {
    approval: '2026-08-29T20:02:00.000Z',
    execution: '2026-08-29T20:10:00.000Z',
    queue: '2026-08-29T20:10:00.000Z',
  },
  expiresAt: '2026-09-05T20:00:00.000Z',
  generation: 1,
  invocationId: `invocation-${suffix}`,
  jobId: `bj_${suffix}`,
  payloadFingerprint: 'a'.repeat(64),
  providerId: 'bp_profile',
  status: 'awaiting_approval',
});
const change = (next: Partial<BrowserTaskProviderSnapshot>): void => {
  fixture.state = { ...fixture.state, ...next };
  for (const listener of fixture.listeners) {
    listener();
  }
};
const finish = (
  reason: Exclude<BrowserResult['reason'], 'completed'>,
  status: Exclude<BrowserResult['status'], 'succeeded'>
): void => {
  const { active } = fixture.state;
  if (active === undefined) {
    return;
  }
  const result: BrowserResult = {
    ...active.job,
    effectsUncertain: false,
    evidence: [],
    reason,
    status,
    summary: 'The invocation ended without replay.',
  };
  change({ active: undefined, jobs: [{ ...active.job, result, status }], phase: 'idle', result });
};
const actions = {
  approve: async (jobId: string, tabId: number) => {
    const { active, settings } = fixture.state;
    const tab = fixture.tabs.find(candidate => candidate.id === tabId);
    if (active?.job.jobId !== jobId || settings === undefined || tab === undefined) {
      return;
    }
    const approvedTab = {
      effectiveMode: settings.mode,
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
    };
    change({
      active: { ...active, job: { ...active.job, approvedTab, status: 'running' } },
      phase: 'running',
    });
  },
  cancel: (jobId: string) => {
    if (fixture.state.active?.job.jobId === jobId) {
      finish('cancelled', 'cancelled');
    } else {
      change({ jobs: fixture.state.jobs.filter(row => row.jobId !== jobId) });
    }
  },
  prepareRecovery: async () => fixture.readiness,
  recover: async () => {
    change({ message: 'Recovered; new work requires fresh consent.', phase: 'idle' });
  },
  refreshStatus: async () => {
    change({ message: 'Stored status retrieved without execution.' });
  },
  reject: () => {
    finish('approval_denied', 'failed');
  },
  retryConnection: () => {
    change({ message: 'Connecting without resubmission.', phase: 'connecting' });
  },
  setSettings: async (settings: BrowserProviderSettings) => {
    change({ settings });
  },
};
const clients: QueryClient[] = [];
const renderControls = (children?: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const surface = (content: ReactNode) => (
    <QueryClientProvider client={client}>
      <BrowserTaskSurface>
        <button type="button">Outside</button>
        <BrowserTaskControls />
        {content}
      </BrowserTaskSurface>
    </QueryClientProvider>
  );
  const view = render(surface(children));
  return {
    ...view,
    rerender: (content: ReactNode) => {
      view.rerender(surface(content));
    },
  };
};
const auth = { token: 'unit-token', userEmail: 'owner@example.test' };
const SettingsOverlay = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
        }}
        type="button"
      >
        Settings
      </button>
      {open ? (
        <div aria-label="Settings panel" aria-modal="true" role="dialog">
          <button
            onClick={() => {
              setOpen(false);
            }}
            type="button"
          >
            Close settings
          </button>
          <BrowserTaskSupervisionSlot />
          <BrowserTaskSettings auth={auth} organizationId={undefined} />
        </div>
      ) : null}
    </>
  );
};
const openSettings = (): HTMLElement => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  return screen.getByRole('dialog', { name: 'Settings panel' });
};
const createSettingsRuntime = (
  enabled: boolean,
  persist: (settings: BrowserProviderSettings) => Promise<void>
) => {
  let state: BrowserTaskProviderSnapshot = {
    ...fixture.state,
    phase: enabled ? 'idle' : 'disabled',
    settings: { enabled, mode: 'safe', model: 'selected-model', thinkingEffort: 'low' },
  };
  const listeners = new Set<() => void>();
  const writes: { pending: Promise<void> | undefined } = { pending: undefined };
  return {
    getSnapshot: () => state,
    // Match the provider contract: publish settings only after serialized persistence finishes.
    setSettings: (settings: BrowserProviderSettings) => {
      const previous = writes.pending;
      writes.pending = (async () => {
        await previous;
        try {
          await persist(settings);
          state = { ...state, phase: settings.enabled ? 'idle' : 'disabled', settings };
        } catch {
          state = {
            ...state,
            message: 'Browser task storage is unavailable. Restore storage access and retry.',
            phase: 'unavailable',
            retryable: true,
          };
        }
        for (const listener of listeners) {
          listener();
        }
      })();
      return writes.pending;
    },
    settled: async () => {
      await writes.pending;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
const modelOptions = [
  { id: 'selected-model', isPreferred: false, name: 'Selected model', variants: [] },
];
const emptyConversations: [] = [];
const emptyStore = {} as StoredAgentConversationStore;
const noParams: [] = [];
const ModalExamples = () => {
  const [workflowOpen, setWorkflowOpen] = useState(false);
  return (
    <>
      <ModelPicker
        auth={auth}
        disabled={false}
        model=""
        modelOptions={modelOptions}
        onModelChange={vi.fn()}
        organizationId={undefined}
      />
      <ConversationHistoryButton
        activeConversationId=""
        conversations={emptyConversations}
        conversationStore={emptyStore}
        onDeleteConversation={vi.fn()}
        onOpenConversation={vi.fn()}
      />
      <button
        onClick={() => {
          setWorkflowOpen(true);
        }}
        type="button"
      >
        Open workflow prompt
      </button>
      {workflowOpen ? (
        <WorkflowRunPrompt
          name="Example"
          onCancel={() => {
            setWorkflowOpen(false);
          }}
          onRun={() => {
            setWorkflowOpen(false);
          }}
          params={noParams}
        />
      ) : null}
    </>
  );
};

describe('browser task controls', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    fixture.runtime = undefined;
    fixture.tabsUnavailable = false;
    fixture.tabs = [
      { id: 7, title: 'Requested page', url: 'https://example.test/requested' },
      { id: 8, title: 'Another page', url: 'https://other.test/' },
    ];
    fixture.state = {
      active: undefined,
      jobs: [],
      message: 'Provider status detail.',
      phase: 'disabled',
      profile: { label: 'Work browser', providerId: 'bp_profile' },
      result: undefined,
      retryable: false,
      settings: { enabled: false, mode: 'safe', model: 'selected-model', thinkingEffort: '' },
      unresolvedFence: undefined,
    };
    fixture.execution = {
      blockedReason: undefined,
      delegated: 'idle',
      delegationUnavailableReason: undefined,
      localRuns: 0,
      owner: undefined,
      providerOwned: true,
      quarantinedTabIds: [],
    };
    fixture.readiness = { ready: false, reason: 'Close the affected tab before recovery.' };
  });
  afterEach(() => {
    cleanup();
    for (const client of clients.splice(0)) {
      client.clear();
    }
    fixture.listeners.clear();
  });

  it.each([
    {
      choice: 'Other model',
      expected: { model: 'other-model' },
      setting: 'model',
      trigger: 'Model',
    },
    {
      choice: /^Dangerous/u,
      expected: { mode: 'dangerous' },
      setting: 'mode',
      trigger: /Safe mode:/u,
    },
  ])(
    'keeps confirmed disablement after reopening Settings and attempting a $setting change',
    async ({ trigger, choice, expected }) => {
      const write = Promise.withResolvers<void>();
      const persisted: { settings: BrowserProviderSettings | undefined } = { settings: undefined };
      const runtime = createSettingsRuntime(true, async settings => {
        await write.promise;
        persisted.settings = settings;
      });
      fixture.runtime = runtime;
      renderControls(<SettingsOverlay />);
      try {
        openSettings();
        fireEvent.click(screen.getByRole('switch', { name: 'CLI tasks' }));
        fireEvent.click(screen.getByRole('button', { name: 'Disable CLI tasks' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
        expect(screen.queryByRole('region', { name: 'CLI task settings' })).toBeNull();
        const reopened = openSettings();
        const savingVisible = within(reopened).queryByText('Saving CLI task settings...') !== null;
        const disabledControls = [
          screen.getByRole<HTMLButtonElement>('switch', { name: 'CLI tasks' }),
          screen.getByRole<HTMLButtonElement>('button', { name: 'Model' }),
          screen.getByRole<HTMLButtonElement>('button', { name: /Safe mode:/u }),
          screen.getByRole<HTMLSelectElement>('combobox', { name: 'Thinking effort' }),
        ].map(control => control.disabled);
        fireEvent.click(screen.getByRole('button', { name: trigger }));
        // Select an option only if the pending save incorrectly lets its picker open.
        for (const option of screen.queryAllByRole('button', { name: choice })) {
          fireEvent.click(option);
        }
        fireEvent.change(screen.getByRole('combobox', { name: 'Thinking effort' }), {
          target: { value: 'high' },
        });
        await act(async () => {
          write.resolve();
          await runtime.settled();
        });
        expect(persisted.settings).toStrictEqual({
          enabled: false,
          mode: 'safe',
          model: 'selected-model',
          thinkingEffort: 'low',
        });
        expect(savingVisible).toBe(true);
        expect(disabledControls).toStrictEqual([true, true, true, true]);
        expect(screen.getByRole('switch', { name: 'CLI tasks' }).getAttribute('aria-checked')).toBe(
          'false'
        );
        fireEvent.click(screen.getByRole('button', { name: trigger }));
        fireEvent.click(screen.getByRole('button', { name: choice }));
        fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
        await act(async () => {
          await runtime.settled();
        });
        const saved = openSettings();
        expect(persisted.settings).toMatchObject({ ...expected, enabled: false });
        expect(within(saved).getByText('CLI tasks: Disabled')).toBeDefined();
        expect(within(saved).queryByText('Saving CLI task settings...')).toBeNull();
      } finally {
        await act(async () => {
          write.resolve();
          await runtime.settled();
        });
      }
    }
  );

  it('restores settings retry controls after a failed save across overlay closure without enabling', async () => {
    const write = Promise.withResolvers<void>();
    const persisted: { settings: BrowserProviderSettings | undefined } = { settings: undefined };
    const persist = vi
      .fn(async (settings: BrowserProviderSettings) => {
        persisted.settings = settings;
      })
      .mockReturnValueOnce(write.promise);
    const runtime = createSettingsRuntime(false, persist);
    fixture.runtime = runtime;
    renderControls(<SettingsOverlay />);
    openSettings();
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking effort' }), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    const reopened = openSettings();
    await act(async () => {
      write.reject(new Error('Storage unavailable.'));
      await runtime.settled();
    });
    expect(within(reopened).getByText(/Restore storage access and retry/u)).toBeDefined();
    expect(within(reopened).queryByText('Saving CLI task settings...')).toBeNull();
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Thinking effort' }).disabled
    ).toBe(false);
    expect(screen.getByRole('switch', { name: 'CLI tasks' }).getAttribute('aria-checked')).toBe(
      'false'
    );
    expect(persisted.settings).toBeUndefined();
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking effort' }), {
      target: { value: 'high' },
    });
    await act(async () => {
      await runtime.settled();
    });
    expect(persisted.settings).toMatchObject({ enabled: false, thinkingEffort: 'high' });
    expect(within(reopened).getByText('CLI tasks: Disabled')).toBeDefined();
  });

  it('keeps a replacement runtime save pending when the old runtime save completes', async () => {
    const oldWrite = Promise.withResolvers<void>();
    const nextWrite = Promise.withResolvers<void>();
    const oldRuntime = createSettingsRuntime(true, () => oldWrite.promise);
    const nextRuntime = createSettingsRuntime(false, () => nextWrite.promise);
    fixture.runtime = oldRuntime;
    const view = renderControls(<SettingsOverlay />);
    try {
      openSettings();
      fireEvent.click(screen.getByRole('switch', { name: 'CLI tasks' }));
      fireEvent.click(screen.getByRole('button', { name: 'Disable CLI tasks' }));
      fixture.runtime = nextRuntime;
      view.rerender(<SettingsOverlay />);
      const mode = screen.getByRole<HTMLButtonElement>('button', { name: /Safe mode:/u });
      expect(mode.disabled).toBe(false);
      fireEvent.click(mode);
      fireEvent.click(screen.getByRole('button', { name: /^Dangerous/u }));
      await act(async () => {
        oldWrite.resolve();
        await oldRuntime.settled();
      });
      expect(screen.getByText('Saving CLI task settings...')).toBeDefined();
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /Safe mode:/u }).disabled).toBe(
        true
      );
      expect(screen.getByRole('switch', { name: 'CLI tasks' }).getAttribute('aria-checked')).toBe(
        'false'
      );
      await act(async () => {
        nextWrite.resolve();
        await nextRuntime.settled();
      });
      expect(screen.queryByText('Saving CLI task settings...')).toBeNull();
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: /Danger mode:/u }).disabled
      ).toBe(false);
      expect(screen.getByRole('switch', { name: 'CLI tasks' }).getAttribute('aria-checked')).toBe(
        'false'
      );
    } finally {
      await act(async () => {
        oldWrite.resolve();
        nextWrite.resolve();
        await Promise.all([oldRuntime.settled(), nextRuntime.settled()]);
      });
    }
  });

  it.each([
    ['disabled', 'Disabled'],
    ['idle', 'Enabled — idle'],
    ['connecting', 'Connecting'],
    ['unsupported', 'Unsupported'],
    ['unavailable', 'Unavailable'],
    ['owned_elsewhere', 'Owned by another panel'],
    ['awaiting_approval', 'Tab approval required'],
    ['waiting', 'Waiting for browser control'],
    ['running', 'Running'],
    ['interrupted', 'Interrupted'],
    ['recovery', 'Recovery required'],
  ] as const)('announces %s without a stale owner or a loading queue', (phase, label) => {
    fixture.state = { ...fixture.state, phase };
    renderControls();
    expect(screen.getByRole('status').textContent).toBe(`CLI tasks: ${label}`);
    expect(screen.getByText('Queue empty.')).toBeDefined();
    expect(screen.queryByText(/Owner session:/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop CLI task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload panel' })).toBeNull();
  });

  it('offers a named reload with storage guidance only for retryable initialization failure', () => {
    fixture.state = {
      ...fixture.state,
      phase: 'unavailable',
      profile: undefined,
      retryable: true,
      settings: undefined,
    };
    renderControls();
    expect(screen.getByText(/Restore storage access, then reload this panel/u)).toBeDefined();
    expect(
      screen.getByText(/Reload preserves your account, saved settings, and safety records/u)
    ).toBeDefined();
    const reload = screen.getByRole<HTMLButtonElement>('button', { name: 'Reload panel' });
    expect(reload.disabled).toBe(false);
    reload.focus();
    expect(document.activeElement).toBe(reload);
    expect(screen.queryByRole('button', { name: 'Refresh status' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check recovery readiness' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
    expect(screen.queryByText(/Retrieve status first/u)).toBeNull();
    act(() => {
      change({ retryable: false });
    });
    expect(screen.queryByRole('button', { name: 'Reload panel' })).toBeNull();
    expect(screen.queryByText(/Restore storage access, then reload this panel/u)).toBeNull();
  });

  it.each([
    { delegated: 'idle', label: 'local browser work', localRuns: 1 },
    { delegated: 'running', label: 'delegated execution', localRuns: 0 },
    { delegated: 'waiting', label: 'pending execution cleanup', localRuns: 0 },
  ] as const)('blocks initialization reload during $label', ({ delegated, localRuns }) => {
    fixture.state = {
      ...fixture.state,
      phase: 'unavailable',
      profile: undefined,
      retryable: true,
      settings: undefined,
    };
    fixture.execution = { ...fixture.execution, delegated, localRuns };
    renderControls();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reload panel' }).disabled).toBe(
      true
    );
    expect(
      screen.getByText('Stop browser work and wait for cleanup before reloading.')
    ).toBeDefined();
    act(() => {
      fixture.execution = { ...fixture.execution, delegated: 'idle', localRuns: 0 };
      change({});
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reload panel' }).disabled).toBe(
      false
    );
    expect(
      screen.queryByText('Stop browser work and wait for cleanup before reloading.')
    ).toBeNull();
  });

  it('requires an explicit candidate and approval while retaining a long goal after tab loss', async () => {
    const goal = `Inspect ${'long goal '.repeat(160)}`;
    fixture.state = {
      ...fixture.state,
      active: {
        approval: undefined,
        goal,
        job: job(),
        ownerLabel: 'ses_same-repository_owner-12345678',
      },
      phase: 'awaiting_approval',
      settings: { enabled: true, mode: 'dangerous', model: 'selected-model', thinkingEffort: '' },
    };
    const view = renderControls();
    await screen.findByRole('option', { name: 'Requested page' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve tab' }).disabled).toBe(
      true
    );
    fireEvent.change(screen.getByLabelText('Tab to approve'), { target: { value: '7' } });
    expect(screen.getByText('Address: https://example.test/requested')).toBeDefined();
    expect(screen.getByText('Mode: Dangerous · Model: selected-model')).toBeDefined();
    expect(screen.getByText('Bound tab: Not approved')).toBeDefined();
    fixture.tabs = fixture.tabs.filter(tab => tab.id !== 7);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tabs' }));
    await screen.findByText(/That candidate tab is no longer available/u);
    expect(view.container.textContent).toContain(goal);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve tab' }).disabled).toBe(
      true
    );
    fireEvent.change(screen.getByLabelText('Tab to approve'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve tab' }));
    await screen.findByText('Bound tab: Another page (ID 8)');
    expect(screen.getByText('CLI tasks: Running')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Stop CLI task' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
  });

  it('keeps the execution deadline for a terminal invocation that is still draining', () => {
    const bound = {
      ...job(),
      approvedTab: {
        effectiveMode: 'safe' as const,
        tabId: 7,
        title: 'Closed tab',
        url: 'https://example.test/',
      },
    };
    const result: BrowserResult = {
      ...bound,
      effectsUncertain: true,
      evidence: [],
      reason: 'tab_lost',
      status: 'interrupted',
      summary: 'The bound tab closed.',
    };
    fixture.state = {
      ...fixture.state,
      active: {
        approval: undefined,
        goal: 'Inspect the bound page',
        job: { ...bound, result, status: 'interrupted' },
        ownerLabel: 'ses_12345678',
      },
      phase: 'interrupted',
      result,
    };
    renderControls();
    expect(screen.getByText(/Execution deadline:/u)).toBeDefined();
    expect(screen.queryByText(/Approval deadline:/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop CLI task' })).toBeNull();
  });

  it('rejects consent without approving a tab or leaving stale actions', async () => {
    fixture.state = {
      ...fixture.state,
      active: { approval: undefined, goal: 'Read only', job: job(), ownerLabel: 'ses_12345678' },
      phase: 'awaiting_approval',
    };
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await screen.findByText('Last outcome: failed · approval_denied');
    expect(screen.getByText('No uncertain effects reported.')).toBeDefined();
    expect(screen.getByText('No observed evidence.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
    expect(screen.queryByText(/Bound tab:/u)).toBeNull();
  });

  it('uses authoritative queue ranks and labels and cancels only the selected queued job', () => {
    fixture.state = {
      ...fixture.state,
      jobs: [
        {
          ...job('second02'),
          ownerLabel: 'ses_owner_bbbbbbbb',
          queuePosition: 2,
          status: 'queued',
        },
        { ...job('legacy00'), status: 'queued' },
        {
          ...job('first001'),
          ownerLabel: 'ses_owner_aaaaaaaa',
          queuePosition: 1,
          status: 'queued',
        },
      ],
      phase: 'idle',
    };
    renderControls();
    const list = screen.getByRole('list', { name: 'Queued CLI tasks' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map(row => row.textContent)).toStrictEqual([
      expect.stringContaining('Queue position: 1'),
      expect.stringContaining('Queue position: 2'),
      expect.stringContaining('Queue position: Unknown'),
    ]);
    expect(within(rows[2]!).getByText('Owner session: Unknown')).toBeDefined();
    expect(within(rows[0]!).getByText(/Queue deadline:/u).textContent).not.toContain('Unknown');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued task second02' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/ses_owner_aaaaaaaa/u)).toBeDefined();
    expect(screen.queryByText(/ses_owner_bbbbbbbb/u)).toBeNull();
  });

  it('retains affected IDs with current metadata and closure status without retargeting', async () => {
    fixture.execution = { ...fixture.execution, quarantinedTabIds: [7, 42] };
    fixture.state = {
      ...fixture.state,
      unresolvedFence: { invocationId: 'retained-invocation', tabId: 7 },
    };
    fixture.tabs = [
      { id: 7, title: 'Current settings page', url: 'chrome://settings/' },
      { id: 8, title: 'Unrelated tab', url: 'https://other.test/' },
    ];
    renderControls();
    const list = screen.getByRole('list', { name: 'Affected tabs' });
    await within(list).findByText('Title: Current settings page');
    expect(within(list).getByText('Address: chrome://settings/')).toBeDefined();
    expect(
      within(list).getByText('Tab ID 7: Open — close this tab before recovery.')
    ).toBeDefined();
    expect(within(list).getByText('Tab ID 42: Closed')).toBeDefined();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fixture.tabs = fixture.tabs.filter(tab => tab.id !== 7);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh affected tabs' }));
    await within(list).findByText('Tab ID 7: Closed');
    expect(within(list).queryByText(/Unrelated tab/u)).toBeNull();
    expect(within(list).queryByText(/Current settings page/u)).toBeNull();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    act(() => {
      fixture.execution = { ...fixture.execution, quarantinedTabIds: [] };
      change({ unresolvedFence: undefined });
    });
    expect(screen.queryByRole('list', { name: 'Affected tabs' })).toBeNull();
  });

  it('reports unknown closure after a tab read fails and refreshes without inventing a closed tab', async () => {
    fixture.execution = { ...fixture.execution, quarantinedTabIds: [7] };
    renderControls();
    const list = screen.getByRole('list', { name: 'Affected tabs' });
    await within(list).findByText('Title: Requested page');
    fixture.tabsUnavailable = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh affected tabs' }));
    await screen.findByText('Could not retrieve affected tabs. Restore tab access and refresh.');
    expect(within(list).getByText('Tab ID 7: Closure unknown')).toBeDefined();
    expect(within(list).queryByText(/Closed|Requested page/u)).toBeNull();
    fixture.tabsUnavailable = false;
    fixture.tabs = [{ id: 7, title: '', url: '' }];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh affected tabs' }));
    await within(list).findByText('Tab ID 7: Open — close this tab before recovery.');
    expect(within(list).queryByText(/Title:|Address:/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
  });

  it('does not invent an outcome or an affected identity from the current tabs', () => {
    renderControls();
    expect(screen.queryByText(/Last outcome:/u)).toBeNull();
    expect(screen.queryByText(/Observed evidence|uncertain effects/u)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Affected tabs' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh affected tabs' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check recovery readiness' })).toBeNull();
  });

  it('separates status retrieval, preparation, and explicit recovery and invalidates stale readiness', async () => {
    fixture.state = {
      ...fixture.state,
      phase: 'recovery',
      settings: { enabled: true, mode: 'safe', model: 'selected-model', thinkingEffort: '' },
    };
    renderControls();
    expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByText('Status retrieved. This does not approve execution or resubmit work.');
    expect(screen.getByText('CLI tasks: Recovery required')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Check recovery readiness' }));
    await screen.findByText('Close the affected tab before recovery.');
    expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
    fixture.readiness = {
      ready: true,
      reason: 'Tabs closed and locks drained. Quarantine remains until explicit recovery.',
    };
    fireEvent.click(screen.getByRole('button', { name: 'Check recovery readiness' }));
    await screen.findByRole('button', { name: 'Recover browser control' });
    expect(screen.getByText('CLI tasks: Recovery required')).toBeDefined();
    act(() => {
      change({ message: 'Provider state changed.' });
    });
    expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check recovery readiness' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Recover browser control' }));
    await screen.findByText('CLI tasks: Enabled — idle');
    expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
  });

  it('shows concrete all-tabs and unsupported-lock instructions without a recovery bypass', async () => {
    fixture.state = { ...fixture.state, phase: 'unsupported' };
    fixture.execution = {
      ...fixture.execution,
      blockedReason:
        'Close all target tabs before recovery. The affected-tab list is not known to be complete.',
      delegationUnavailableReason: 'Web Locks unavailable.',
    };
    renderControls();
    expect(
      screen.getByText(
        'Recovery requires Web Locks. Restore browser Web Locks support before recovering.'
      )
    ).toBeDefined();
    expect(
      screen.getByText(
        'Close all target tabs before recovery. The affected-tab list is not known to be complete.'
      )
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    fixture.readiness = { ready: false, reason: 'Web Locks must be restored before recovery.' };
    fireEvent.click(screen.getByRole('button', { name: 'Check recovery readiness' }));
    await screen.findByText('Web Locks must be restored before recovery.');
    expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
  });

  it('offers reconnect only for retryable unavailability and never invents consent from status', async () => {
    fixture.state = {
      ...fixture.state,
      message: 'provider_unavailable',
      phase: 'unavailable',
      retryable: true,
    };
    renderControls();
    expect(screen.queryByRole('button', { name: 'Reload panel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await screen.findByText('CLI tasks: Connecting');
    expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
    act(() => {
      change({ message: 'owner_mismatch', phase: 'unavailable', retryable: false });
    });
    expect(screen.getByText('owner_mismatch')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it.each([
    [
      'provider_unavailable',
      true,
      'Status unavailable: provider_unavailable. Reconnect and retrieve status again. No work was resubmitted.',
    ],
    [
      'owner_mismatch',
      false,
      'Status denied: owner_mismatch. Restore provider access before retrieving status. No work was resubmitted.',
    ],
  ] as const)(
    'keeps the %s status failure distinct without execution approval',
    async (reason, retryable, message) => {
      const { BrowserProviderError } =
        await import('@kilocode/cloud-agent-sdk/user-web-connection');
      vi.spyOn(actions, 'refreshStatus').mockRejectedValueOnce(
        new BrowserProviderError(reason, retryable)
      );
      fixture.state = { ...fixture.state, phase: 'unavailable', retryable };
      renderControls();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
      await screen.findByText(message);
      expect(screen.queryByRole('button', { name: 'Approve tab' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Recover browser control' })).toBeNull();
    }
  );

  it.each([
    {
      close: 'Close model picker',
      lastName: 'Search models',
      lastRole: 'searchbox',
      name: 'Select model',
      opener: 'Model',
    },
    {
      close: 'Close history',
      lastName: 'Refresh status',
      lastRole: 'button',
      name: 'Conversation history',
      opener: 'History',
    },
    {
      close: 'Cancel',
      lastName: 'Run',
      lastRole: 'button',
      name: 'Run workflow "Example"',
      opener: 'Open workflow prompt',
    },
  ])(
    'keeps Stop, focus containment, and focus restoration inside the $opener overlay',
    async ({ close, lastName, lastRole, name, opener }) => {
      fixture.state = {
        ...fixture.state,
        active: {
          approval: undefined,
          goal: 'Long goal '.repeat(100),
          job: {
            ...job(),
            approvedTab: {
              effectiveMode: 'safe',
              tabId: 7,
              title: 'Long title '.repeat(100),
              url: `https://example.test/${'long-path/'.repeat(100)}`,
            },
            status: 'running',
          },
          ownerLabel: 'ses_owner_12345678',
        },
        phase: 'running',
      };
      renderControls(<ModalExamples />);
      const trigger = screen.getByRole('button', { name: opener });
      trigger.focus();
      fireEvent.click(trigger);
      const dialog = await screen.findByRole('dialog', { name });
      const stop = within(dialog).getByRole('button', { name: 'Stop CLI task' });
      expect(within(dialog).getByText(/Bound tab:/u)).toBeDefined();
      expect(within(dialog).getByText(/ses_owner_12345678/u)).toBeDefined();
      const [first] = within(dialog).getAllByRole('button');
      const last = within(dialog).getByRole(lastRole, { name: lastName });
      last.focus();
      fireEvent.keyDown(dialog, { key: 'Tab' });
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
      screen.getByRole('button', { name: 'Outside' }).focus();
      expect(dialog.contains(document.activeElement)).toBe(true);
      stop.focus();
      expect(document.activeElement).toBe(stop);
      fireEvent.click(within(dialog).getByRole('button', { name: close }));
      await waitFor(() => {
        expect(document.activeElement).toBe(trigger);
      });
      fireEvent.click(trigger);
      const reopened = await screen.findByRole('dialog', { name });
      fireEvent.click(within(reopened).getByRole('button', { name: 'Stop CLI task' }));
      await waitFor(() => {
        expect(within(reopened).queryByRole('button', { name: 'Stop CLI task' })).toBeNull();
      });
      expect(within(reopened).getByText('Last outcome: cancelled · cancelled')).toBeDefined();
    }
  );
});
