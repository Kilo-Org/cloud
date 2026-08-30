/* eslint-disable capitalized-comments, id-length, init-declarations, jest/no-hooks, jest/no-untyped-mock-factory, jest/no-conditional-expect, jest/no-conditional-in-test, max-dependencies, max-lines, no-unused-expressions, sort-keys, vitest/prefer-import-in-mock, vitest/prefer-called-times -- test fixture constraints */
/* eslint-disable import/first */
// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { createElement } from 'react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { runningConversationIdsAtom } from './agent-chat-atoms';
import {
  activeConversationIdAtom,
  conversationModeAtom,
  settingsDialogOpenAtom,
} from './settings-dialog-state';
import { WorkflowSettings } from './workflow-settings';
import { workflowRunRequestAtom } from './workflow-settings-state';
import type { UseAgentWorkflowsResult } from './use-agent-workflows';

vi.mock('./use-agent-workflows', () => ({
  useAgentWorkflows: vi.fn(),
}));

vi.mock('@/src/shared/agent-workflows-storage', () => ({
  AGENT_WORKFLOWS_STORAGE_KEY: 'local:kiloAgentWorkflows',
  deleteAgentWorkflow: vi.fn(),
  loadWorkflowSettings: vi.fn(),
  saveWorkflowSettings: vi.fn(),
}));

const lockStorage = vi.hoisted(() => new Map<string, unknown>());
vi.mock('#imports', () => ({
  storage: {
    getItem: (key: string) => lockStorage.get(key),
    setItem: (key: string, value: unknown) => {
      lockStorage.set(key, value);
    },
    watch: () => () => {},
  },
}));
// eslint-disable-next-line import/no-nodejs-modules -- These fixtures exercise native locks under Node.
import { locks as nativeLocks } from 'node:worker_threads';
import { BROWSER_EXECUTION_LOCK, getBrowserExecutionCoordinator } from './browser-execution-lock';
import type { BrowserAdmission, BrowserExecutionLease } from './browser-execution-lock';
import { reserveWorkflowLease, takeWorkflowLease } from './browser-run-context';
const heldLeases = new Set<BrowserExecutionLease>();

import { useAgentWorkflows } from './use-agent-workflows';
import { DEFAULT_WORKFLOW_SETTINGS } from '@/src/shared/agent-workflows';
import {
  deleteAgentWorkflow,
  loadWorkflowSettings,
  saveWorkflowSettings,
} from '@/src/shared/agent-workflows-storage';

const mockUseAgentWorkflows = vi.mocked(useAgentWorkflows);
const mockLoadWorkflowSettings = vi.mocked(loadWorkflowSettings);
const mockSaveWorkflowSettings = vi.mocked(saveWorkflowSettings);
const mockDeleteAgentWorkflow = vi.mocked(deleteAgentWorkflow);

const emptyResult: UseAgentWorkflowsResult = {
  isLoaded: true,
  loadError: false,
  reload: vi.fn(),
  workflows: [],
};

const approvedWorkflow = {
  id: 'wf-1',
  name: 'Order pizza',
  description: 'Order a pizza',
  scopeOrigin: 'https://pizza.example.com',
  script: 'return 1;',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  approvedScriptHash: 'abc123',
};

const createWrapper = (store: ReturnType<typeof createStore>) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(Provider, { store }, children);
  };

describe('workflow settings', () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: nativeLocks });
    lockStorage.clear();
    store = createStore();
    store.set(runningConversationIdsAtom, []);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const request = store.get(workflowRunRequestAtom);
    if (request !== undefined) {
      const reservation = takeWorkflowLease(request);
      if (reservation !== undefined) {
        await reservation.lease.release();
      }
    }
    await Promise.all([...heldLeases].map(lease => lease.release()));
    heldLeases.clear();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('renders all three settings switches and the saved workflows label', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });

    const { getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Allow workflows in safe mode')).toBeDefined();
    });
    expect(getByText('Auto-approve workflow changes')).toBeDefined();
    expect(getByText('Auto-approve workflow runs')).toBeDefined();
    expect(getByText('Saved workflows')).toBeDefined();
  });

  it('renders the explanatory description under each new workflow setting', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });

    const { getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(
        getByText(
          'Save workflow changes without the approval card, and delete without the confirm click.'
        )
      ).toBeDefined();
    });
    expect(getByText('Let Kilo start a workflow run without asking first.')).toBeDefined();
  });

  it('shows empty state when no workflows', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });

    const { getByText, queryByRole } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText(/No workflows yet. Ask Kilo to save one/u)).toBeDefined();
      expect(queryByRole('status')).toBeNull();
    });
  });

  it('shows loading message when not loaded', () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      isLoaded: false,
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });

    const { getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    expect(getByText('Loading…')).toBeDefined();
  });

  it('shows load error with retry button', () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      loadError: true,
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });

    const { getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    expect(getByText("Couldn't load workflows. Try again.")).toBeDefined();
    expect(getByText('Retry')).toBeDefined();
  });

  it('calls reload when retry button is clicked', () => {
    const reload = vi.fn();
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      loadError: true,
      reload,
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });

    const { getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    const retryButton = getByText('Retry');
    if (retryButton instanceof HTMLButtonElement) {
      retryButton.click();
    }

    expect(reload).toHaveBeenCalledOnce();
  });

  it('renders workflow list items', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });

    const { getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Order pizza')).toBeDefined();
    });
  });

  it('sets run request atom and closes settings on Run click', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: true,
    });
    store.set(runningConversationIdsAtom, []);
    store.set(settingsDialogOpenAtom, true);

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      const button = getByLabelText('Run workflow "Order pizza"');
      if (button instanceof HTMLButtonElement) {
        expect(button.disabled).toBe(false);
      }
    });

    const runButton = getByLabelText('Run workflow "Order pizza"');
    if (runButton instanceof HTMLButtonElement) {
      runButton.click();
    }

    await waitFor(() => {
      expect(store.get(workflowRunRequestAtom)).toStrictEqual({ workflowId: 'wf-1' });
      expect(store.get(settingsDialogOpenAtom)).toBe(false);
    });
  });

  it.each([
    { failure: 'request', parameters: false },
    { failure: 'request', parameters: true },
    { failure: 'lease', parameters: false },
    { failure: 'lease', parameters: true },
  ])(
    'retains input after a $failure exception (parameters=$parameters)',
    async ({ failure, parameters }) => {
      mockUseAgentWorkflows.mockReturnValue({
        ...emptyResult,
        workflows: [
          {
            ...approvedWorkflow,
            ...(parameters
              ? { params: [{ name: 'size', description: 'Pizza size', required: true }] }
              : {}),
          },
        ],
      });
      mockLoadWorkflowSettings.mockResolvedValue({
        ...DEFAULT_WORKFLOW_SETTINGS,
        allowWorkflowsInSafeMode: true,
      });
      store.set(settingsDialogOpenAtom, true);
      const coordinator = getBrowserExecutionCoordinator();
      if (failure === 'request') {
        vi.spyOn(coordinator, 'acquireLocal').mockRejectedValueOnce(
          new Error('Admission unavailable. Submit again.')
        );
      } else {
        const admission = await coordinator.acquireLocal();
        if (!admission.admitted) {
          throw new Error(admission.reason);
        }
        await admission.lease.release();
        vi.spyOn(coordinator, 'acquireLocal').mockResolvedValueOnce(admission);
      }
      const view = render(createElement(WorkflowSettings), { wrapper: createWrapper(store) });
      await waitFor(() => {
        expect(view.getByLabelText('Run workflow "Order pizza"')).toHaveProperty('disabled', false);
      });
      fireEvent.click(view.getByLabelText('Run workflow "Order pizza"'));
      if (parameters) {
        fireEvent.change(view.getByRole('textbox'), { target: { value: 'large' } });
        fireEvent.click(view.getByRole('button', { name: 'Run' }));
      }
      await waitFor(() => {
        expect(view.getByRole(parameters ? 'alert' : 'status').textContent).toContain(
          failure === 'request' ? 'Admission unavailable' : 'execution_lease_lost'
        );
      });
      expect(store.get(workflowRunRequestAtom)).toBeUndefined();
      expect(store.get(settingsDialogOpenAtom)).toBe(true);
      if (parameters) {
        expect(view.getByDisplayValue('large')).toBeDefined();
      }
      const owner = await coordinator.acquireProviderOwner();
      if (!owner.admitted) {
        throw new Error(owner.reason);
      }
      heldLeases.add(owner.lease);
      const delegated = await coordinator.acquireDelegated(
        owner.lease,
        'temporary-owner',
        new AbortController().signal
      );
      if (!delegated.admitted) {
        throw new Error(delegated.reason);
      }
      heldLeases.add(delegated.lease);
      await act(async () => {
        await delegated.lease.release();
        await coordinator.refresh();
      });
      expect(view.getByRole(parameters ? 'alert' : 'status').textContent).toContain(
        failure === 'request' ? 'Admission unavailable' : 'execution_lease_lost'
      );
      expect(store.get(workflowRunRequestAtom)).toBeUndefined();
      fireEvent.click(
        parameters
          ? view.getByRole('button', { name: 'Run' })
          : view.getByLabelText('Run workflow "Order pizza"')
      );
      await waitFor(() => {
        expect(store.get(workflowRunRequestAtom)).toStrictEqual({
          workflowId: 'wf-1',
          ...(parameters ? { input: { size: 'large' } } : {}),
        });
        expect(store.get(settingsDialogOpenAtom)).toBe(false);
        expect(view.queryByRole('dialog')).toBeNull();
      });
    }
  );

  it.each(['cancel', 'row unmount', 'Settings unmount'] as const)(
    'discards pending parameter admission after %s',
    async cancellation => {
      mockUseAgentWorkflows.mockReturnValue({
        ...emptyResult,
        workflows: [
          {
            ...approvedWorkflow,
            params: [{ name: 'size', description: 'Pizza size', required: true }],
          },
        ],
      });
      mockLoadWorkflowSettings.mockResolvedValue({
        ...DEFAULT_WORKFLOW_SETTINGS,
        allowWorkflowsInSafeMode: true,
      });
      store.set(settingsDialogOpenAtom, true);
      const coordinator = getBrowserExecutionCoordinator();
      const admission = await coordinator.acquireLocal();
      if (!admission.admitted) {
        throw new Error(admission.reason);
      }
      heldLeases.add(admission.lease);
      const pending = Promise.withResolvers<BrowserAdmission>();
      vi.spyOn(coordinator, 'acquireLocal').mockReturnValueOnce(pending.promise);
      const view = render(createElement(WorkflowSettings), { wrapper: createWrapper(store) });
      await waitFor(() => {
        expect(view.getByLabelText('Run workflow "Order pizza"')).toHaveProperty('disabled', false);
      });
      fireEvent.click(view.getByLabelText('Run workflow "Order pizza"'));
      fireEvent.change(view.getByRole('textbox'), { target: { value: 'large' } });
      fireEvent.click(view.getByRole('button', { name: 'Run' }));
      expect(store.get(workflowRunRequestAtom)).toBeUndefined();
      if (cancellation === 'cancel') {
        fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
      } else if (cancellation === 'row unmount') {
        mockUseAgentWorkflows.mockReturnValue(emptyResult);
        view.rerender(createElement(WorkflowSettings));
      } else {
        view.unmount();
      }
      await act(async () => {
        pending.resolve(admission);
        await pending.promise;
      });
      expect(store.get(workflowRunRequestAtom)).toBeUndefined();
      expect(store.get(settingsDialogOpenAtom)).toBe(true);
      expect(view.queryByRole('dialog')).toBeNull();
      await waitFor(async () => {
        const state = await nativeLocks.query();
        expect(state.held?.some(lock => lock.name === BROWSER_EXECUTION_LOCK)).toBe(false);
      });
    }
  );

  it('releases admission acquired after Settings unmounts', async () => {
    mockUseAgentWorkflows.mockReturnValue({ ...emptyResult, workflows: [approvedWorkflow] });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: true,
    });
    store.set(settingsDialogOpenAtom, true);
    const coordinator = getBrowserExecutionCoordinator();
    const admission = await coordinator.acquireLocal();
    if (!admission.admitted) {
      throw new Error(admission.reason);
    }
    heldLeases.add(admission.lease);
    const pending = Promise.withResolvers<BrowserAdmission>();
    vi.spyOn(coordinator, 'acquireLocal').mockReturnValueOnce(pending.promise);
    const view = render(createElement(WorkflowSettings), { wrapper: createWrapper(store) });
    await waitFor(() => {
      expect(view.getByLabelText('Run workflow "Order pizza"')).toHaveProperty('disabled', false);
    });
    fireEvent.click(view.getByLabelText('Run workflow "Order pizza"'));
    view.unmount();
    pending.resolve(admission);
    await waitFor(async () => {
      const state = await nativeLocks.query();
      expect(state.held?.some(lock => lock.name === BROWSER_EXECUTION_LOCK)).toBe(false);
    });
    expect(store.get(workflowRunRequestAtom)).toBeUndefined();
    expect(store.get(settingsDialogOpenAtom)).toBe(true);
  });

  it('preserves an existing workflow reservation instead of replacing it and leaking its lease', async () => {
    mockUseAgentWorkflows.mockReturnValue({ ...emptyResult, workflows: [approvedWorkflow] });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: true,
    });
    const admission = await getBrowserExecutionCoordinator().acquireLocal();
    if (!admission.admitted) {
      throw new Error(admission.reason);
    }
    heldLeases.add(admission.lease);
    const request = { input: { size: 'small' }, workflowId: 'wf-1' };
    reserveWorkflowLease(request, admission.lease, 'conversation-1');
    store.set(workflowRunRequestAtom, request);
    store.set(settingsDialogOpenAtom, true);
    const view = render(createElement(WorkflowSettings), { wrapper: createWrapper(store) });
    await waitFor(() => {
      expect(view.getByLabelText('Run workflow "Order pizza"')).toHaveProperty('disabled', false);
    });
    fireEvent.click(view.getByLabelText('Run workflow "Order pizza"'));
    await waitFor(() => {
      expect(view.getByRole('status').textContent).toContain('workflow request');
    });
    expect(store.get(workflowRunRequestAtom)).toBe(request);
    expect(store.get(settingsDialogOpenAtom)).toBe(true);
    const reservation = takeWorkflowLease(request);
    await reservation?.lease.release();
    await waitFor(async () => {
      const state = await nativeLocks.query();
      expect(state.held?.some(lock => lock.name === BROWSER_EXECUTION_LOCK)).toBe(false);
    });
  });

  it.each([false, true])(
    'retains Settings input after a local owner disappears (parameters=%s)',
    async parameters => {
      const { storage } = await import('#imports');
      const { BROWSER_EXECUTION_SAFETY_KEY, createBrowserExecutionCoordinator } =
        await import('./browser-execution-lock');
      lockStorage.set(BROWSER_EXECUTION_SAFETY_KEY, {
        localRuns: [{ lockName: `${BROWSER_EXECUTION_LOCK}:local:closed-panel`, tabId: 0 }],
        tabIds: [],
        version: 1,
      });
      mockUseAgentWorkflows.mockReturnValue({
        ...emptyResult,
        workflows: [
          {
            ...approvedWorkflow,
            ...(parameters
              ? { params: [{ name: 'size', description: 'Pizza size', required: true }] }
              : {}),
          },
        ],
      });
      mockLoadWorkflowSettings.mockResolvedValue({
        ...DEFAULT_WORKFLOW_SETTINGS,
        allowWorkflowsInSafeMode: true,
      });
      store.set(settingsDialogOpenAtom, true);
      const view = render(createElement(WorkflowSettings), { wrapper: createWrapper(store) });
      await waitFor(() => {
        expect(view.getByLabelText('Run workflow "Order pizza"')).toHaveProperty('disabled', false);
      });
      fireEvent.click(view.getByLabelText('Run workflow "Order pizza"'));
      if (parameters) {
        fireEvent.change(view.getByRole('textbox'), { target: { value: 'large' } });
        fireEvent.click(view.getByRole('button', { name: 'Run' }));
      }
      await waitFor(() => {
        expect(view.getByRole(parameters ? 'alert' : 'status').textContent).toContain(
          'Close the affected tabs'
        );
      });
      expect(store.get(workflowRunRequestAtom)).toBeUndefined();
      expect(store.get(settingsDialogOpenAtom)).toBe(true);
      const otherPanel = createBrowserExecutionCoordinator({
        locks: nativeLocks as LockManager,
        storageArea: storage,
      });
      await expect(otherPanel.recover(() => Promise.resolve([0]))).resolves.toMatchObject({
        recovered: false,
      });
      await act(async () => {
        await expect(otherPanel.recover(() => Promise.resolve([]))).resolves.toMatchObject({
          recovered: true,
        });
        await getBrowserExecutionCoordinator().refresh();
      });
      expect(store.get(workflowRunRequestAtom)).toBeUndefined();
      expect(view.getByRole(parameters ? 'alert' : 'status').textContent).toContain(
        'input is retained'
      );
      if (parameters) {
        expect(view.getByDisplayValue('large')).toBeDefined();
      }
      fireEvent.click(
        parameters
          ? view.getByRole('button', { name: 'Run' })
          : view.getByLabelText('Run workflow "Order pizza"')
      );
      await waitFor(() => {
        expect(store.get(workflowRunRequestAtom)).toStrictEqual({
          workflowId: 'wf-1',
          ...(parameters ? { input: { size: 'large' } } : {}),
        });
        expect(store.get(settingsDialogOpenAtom)).toBe(false);
      });
    }
  );

  it.each([
    { parameters: false, phase: 'waiting' },
    { parameters: false, phase: 'running' },
    { parameters: true, phase: 'waiting' },
    { parameters: true, phase: 'running' },
  ])(
    'retains Settings input when delegation is $phase (parameters=$parameters)',
    async ({ parameters, phase }) => {
      mockUseAgentWorkflows.mockReturnValue({
        ...emptyResult,
        workflows: [
          {
            ...approvedWorkflow,
            ...(parameters
              ? { params: [{ name: 'size', description: 'Pizza size', required: true }] }
              : {}),
          },
        ],
      });
      mockLoadWorkflowSettings.mockResolvedValue({
        ...DEFAULT_WORKFLOW_SETTINGS,
        allowWorkflowsInSafeMode: true,
      });
      store.set(settingsDialogOpenAtom, true);
      const coordinator = getBrowserExecutionCoordinator();
      const ownerAdmission = await coordinator.acquireProviderOwner();
      if (!ownerAdmission.admitted) {
        throw new Error(ownerAdmission.reason);
      }
      heldLeases.add(ownerAdmission.lease);
      const localAdmission = phase === 'waiting' ? await coordinator.acquireLocal() : undefined;
      if (localAdmission?.admitted === true) {
        heldLeases.add(localAdmission.lease);
      }
      const delegatedPromise = coordinator.acquireDelegated(
        ownerAdmission.lease,
        'parent-order',
        new AbortController().signal
      );
      let delegated: BrowserExecutionLease | undefined;
      if (phase === 'running') {
        const admission = await delegatedPromise;
        if (!admission.admitted) {
          throw new Error(admission.reason);
        }
        delegated = admission.lease;
        heldLeases.add(delegated);
      } else {
        await waitFor(async () => {
          const state = await nativeLocks.query();
          expect(state.pending).toHaveLength(1);
        });
      }
      const view = render(createElement(WorkflowSettings), { wrapper: createWrapper(store) });
      await waitFor(() => {
        expect(view.getByLabelText('Run workflow "Order pizza"')).toHaveProperty('disabled', false);
      });
      fireEvent.click(view.getByLabelText('Run workflow "Order pizza"'));
      if (parameters) {
        fireEvent.change(view.getByRole('textbox'), { target: { value: 'large' } });
        fireEvent.click(view.getByRole('button', { name: 'Run' }));
        await waitFor(() => {
          expect(view.getByRole('alert').textContent).toContain('parent-order');
        });
        expect(view.getByDisplayValue('large')).toBeDefined();
        expect(view.getByRole('dialog')).toBeDefined();
      } else {
        await waitFor(() => {
          expect(view.getByRole('status').textContent).toContain('parent-order');
        });
      }
      expect(store.get(workflowRunRequestAtom)).toBeUndefined();
      expect(store.get(settingsDialogOpenAtom)).toBe(true);
      if (localAdmission?.admitted === true) {
        await localAdmission.lease.release();
      }
      if (delegated === undefined) {
        const admission = await delegatedPromise;
        if (!admission.admitted) {
          throw new Error(admission.reason);
        }
        delegated = admission.lease;
        heldLeases.add(delegated);
      }
      const delegatedLease = delegated;
      await act(async () => {
        await delegatedLease.release();
        await coordinator.refresh();
      });
      expect(view.getByRole('status').textContent).not.toContain('parent-order');
      expect(view.getByRole('status').textContent).toMatch(/input is retained.*Run it again/u);
      if (parameters) {
        expect(view.getByRole('alert').textContent).not.toContain('parent-order');
        expect(view.getByDisplayValue('large')).toBeDefined();
      }
      expect(store.get(workflowRunRequestAtom)).toBeUndefined();
      fireEvent.click(
        parameters
          ? view.getByRole('button', { name: 'Run' })
          : view.getByLabelText('Run workflow "Order pizza"')
      );
      await waitFor(() => {
        expect(store.get(workflowRunRequestAtom)).toStrictEqual({
          workflowId: 'wf-1',
          ...(parameters ? { input: { size: 'large' } } : {}),
        });
        expect(store.get(settingsDialogOpenAtom)).toBe(false);
        expect(view.queryByRole('dialog')).toBeNull();
      });
    }
  );

  it('sets the toggle on click and persists the change', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });
    mockSaveWorkflowSettings.mockResolvedValue();

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    const toggle = getByLabelText('Allow workflows in safe mode');
    await waitFor(() => {
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.disabled).toBe(false);
      }
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockSaveWorkflowSettings).toHaveBeenCalledWith(expect.anything(), {
        ...DEFAULT_WORKFLOW_SETTINGS,
        allowWorkflowsInSafeMode: true,
      });
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.getAttribute('aria-checked')).toBe('true');
      }
    });
  });

  it('persists only the toggled setting key', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: true,
    });
    mockSaveWorkflowSettings.mockResolvedValue();

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    const toggle = getByLabelText('Auto-approve workflow runs');
    await waitFor(() => {
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.disabled).toBe(false);
      }
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockSaveWorkflowSettings).toHaveBeenCalledWith(expect.anything(), {
        ...DEFAULT_WORKFLOW_SETTINGS,
        allowWorkflowsInSafeMode: true,
        autoApproveWorkflowRuns: true,
      });
    });
  });

  it('persists only the auto-approve changes key when toggled', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });
    mockSaveWorkflowSettings.mockResolvedValue();

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    const changesToggle = getByLabelText('Auto-approve workflow changes');
    await waitFor(() => {
      if (changesToggle instanceof HTMLButtonElement) {
        expect(changesToggle.disabled).toBe(false);
      }
    });

    fireEvent.click(changesToggle);

    await waitFor(() => {
      expect(mockSaveWorkflowSettings).toHaveBeenCalledWith(expect.anything(), {
        ...DEFAULT_WORKFLOW_SETTINGS,
        autoApproveWorkflowChanges: true,
      });
      expect(getByLabelText('Auto-approve workflow changes').getAttribute('aria-checked')).toBe(
        'true'
      );
      expect(getByLabelText('Allow workflows in safe mode').getAttribute('aria-checked')).toBe(
        'false'
      );
      expect(getByLabelText('Auto-approve workflow runs').getAttribute('aria-checked')).toBe(
        'false'
      );
    });
  });

  it('rolls back toggle state when save fails', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });
    mockSaveWorkflowSettings.mockRejectedValue(new Error('Storage write failed'));

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    const toggle = getByLabelText('Allow workflows in safe mode');
    await waitFor(() => {
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.disabled).toBe(false);
      }
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.getAttribute('aria-checked')).toBe('false');
      }
    });
  });

  it('keeps toggles disabled and shows a settings error after settings-load failure', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockRejectedValue(new Error('Storage read failed'));

    const { getByLabelText, getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText("Couldn't load settings. Try again.")).toBeDefined();
    });

    const toggle = getByLabelText('Allow workflows in safe mode');
    if (toggle instanceof HTMLButtonElement) {
      expect(toggle.disabled).toBe(true);
    }
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(getByText('Retry')).toBeDefined();
  });

  it('retries the settings load and clears the error after success', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings
      .mockRejectedValueOnce(new Error('Storage read failed'))
      .mockResolvedValueOnce({
        ...DEFAULT_WORKFLOW_SETTINGS,
        allowWorkflowsInSafeMode: true,
      });

    const { getByLabelText, queryByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByLabelText('Retry loading workflow settings')).toBeDefined();
    });

    const retryButton = getByLabelText('Retry loading workflow settings');
    if (retryButton instanceof HTMLButtonElement) {
      retryButton.click();
    }

    await waitFor(() => {
      expect(queryByText("Couldn't load settings. Try again.")).toBeNull();
    });
    const toggle = getByLabelText('Allow workflows in safe mode');
    await waitFor(() => {
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.disabled).toBe(false);
      }
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('shows a settings save error and keeps the prior value on write failure', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });
    mockSaveWorkflowSettings.mockRejectedValue(new Error('Storage write failed'));

    const { getByLabelText, getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    const toggle = getByLabelText('Allow workflows in safe mode');
    await waitFor(() => {
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.disabled).toBe(false);
      }
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(getByText("Couldn't save settings. Try again.")).toBeDefined();
    });
    expect(getByText('Retry')).toBeDefined();
    // The prior value stays visible; the toggle did not silently stay flipped.
    if (toggle instanceof HTMLButtonElement) {
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    }
  });

  it('retries the failed settings save and clears the error after success', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });
    mockSaveWorkflowSettings
      .mockRejectedValueOnce(new Error('Storage write failed'))
      .mockResolvedValueOnce();

    const { getByLabelText, queryByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    const toggle = getByLabelText('Allow workflows in safe mode');
    await waitFor(() => {
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.disabled).toBe(false);
      }
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(getByLabelText('Retry saving workflow settings')).toBeDefined();
    });
    expect(mockSaveWorkflowSettings).toHaveBeenCalledOnce();

    const retryButton = getByLabelText('Retry saving workflow settings');
    if (retryButton instanceof HTMLButtonElement) {
      retryButton.click();
    }

    await waitFor(() => {
      expect(mockSaveWorkflowSettings).toHaveBeenCalledTimes(2);
      expect(mockSaveWorkflowSettings).toHaveBeenLastCalledWith(expect.anything(), {
        ...DEFAULT_WORKFLOW_SETTINGS,
        allowWorkflowsInSafeMode: true,
      });
    });
    await waitFor(() => {
      expect(queryByText("Couldn't save settings. Try again.")).toBeNull();
    });
    if (toggle instanceof HTMLButtonElement) {
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    }
  });

  it('renders three switches off on a fresh store after merge', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({ ...DEFAULT_WORKFLOW_SETTINGS });

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      const toggle = getByLabelText('Allow workflows in safe mode');
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.disabled).toBe(false);
      }
    });

    for (const label of [
      'Allow workflows in safe mode',
      'Auto-approve workflow changes',
      'Auto-approve workflow runs',
    ]) {
      expect(getByLabelText(label).getAttribute('aria-checked')).toBe('false');
    }
  });

  it('calls deleteAgentWorkflow on delete click', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });
    mockDeleteAgentWorkflow.mockResolvedValue();

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByLabelText('Delete workflow "Order pizza"')).toBeDefined();
    });

    const deleteButton = getByLabelText('Delete workflow "Order pizza"');
    if (deleteButton instanceof HTMLButtonElement) {
      deleteButton.click();
    }

    // First click only arms the confirmation.
    expect(mockDeleteAgentWorkflow).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(getByLabelText('Confirm delete "Order pizza"')).toBeDefined();
    });
    const confirmButton = getByLabelText('Confirm delete "Order pizza"');
    if (confirmButton instanceof HTMLButtonElement) {
      confirmButton.click();
    }

    expect(mockDeleteAgentWorkflow).toHaveBeenCalledWith(expect.anything(), 'wf-1');
  });

  it('deletes on first click when auto-approve changes is on', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      autoApproveWorkflowChanges: true,
    });
    mockDeleteAgentWorkflow.mockResolvedValue();

    const { getByLabelText, queryByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      const changesToggle = getByLabelText('Auto-approve workflow changes');
      if (changesToggle instanceof HTMLButtonElement) {
        expect(changesToggle.disabled).toBe(false);
        expect(changesToggle.getAttribute('aria-checked')).toBe('true');
      }
    });

    const deleteButton = getByLabelText('Delete workflow "Order pizza"');
    if (deleteButton instanceof HTMLButtonElement) {
      deleteButton.click();
    }

    expect(mockDeleteAgentWorkflow).toHaveBeenCalledWith(expect.anything(), 'wf-1');
    expect(queryByLabelText('Confirm delete "Order pizza"')).toBeNull();
  });

  it('shows a delete error and keeps the row when delete fails', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });
    mockDeleteAgentWorkflow.mockRejectedValue(new Error('Storage write failed'));

    const { getByLabelText, getByText, queryByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByLabelText('Delete workflow "Order pizza"')).toBeDefined();
    });

    const deleteButton = getByLabelText('Delete workflow "Order pizza"');
    if (deleteButton instanceof HTMLButtonElement) {
      deleteButton.click();
    }

    await waitFor(() => {
      expect(getByLabelText('Confirm delete "Order pizza"')).toBeDefined();
    });
    const confirmButton = getByLabelText('Confirm delete "Order pizza"');
    if (confirmButton instanceof HTMLButtonElement) {
      confirmButton.click();
    }

    await waitFor(() => {
      expect(getByText("Couldn't delete the workflow. Try again.")).toBeDefined();
    });
    expect(getByText('Order pizza')).toBeDefined();

    // The row stays armed, so a later confirm retries and clears the error.
    mockDeleteAgentWorkflow.mockResolvedValue();
    const retryButton = getByLabelText('Confirm delete "Order pizza"');
    if (retryButton instanceof HTMLButtonElement) {
      retryButton.click();
    }

    await waitFor(() => {
      expect(queryByText("Couldn't delete the workflow. Try again.")).toBeNull();
    });
  });

  it('disables Run button for unapproved workflow', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [
        {
          ...approvedWorkflow,
          approvedScriptHash: undefined,
        },
      ],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: true,
    });

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      const button = getByLabelText('Run workflow "Order pizza"');
      if (button instanceof HTMLButtonElement) {
        expect(button.disabled).toBe(true);
      }
    });
  });

  it('disables Run button when safe toggle is off in safe mode', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });
    store.set(conversationModeAtom, 'safe');

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      const button = getByLabelText('Run workflow "Order pizza"');
      if (button instanceof HTMLButtonElement) {
        expect(button.disabled).toBe(true);
        expect(button.title).toBe('Safe mode workflows disabled');
      }
    });
  });

  it('enables Run in dangerous mode with safe toggle off', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: false,
    });
    store.set(conversationModeAtom, 'dangerous');
    store.set(activeConversationIdAtom, 'conversation-1');
    store.set(runningConversationIdsAtom, []);

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      const button = getByLabelText('Run workflow "Order pizza"');
      if (button instanceof HTMLButtonElement) {
        expect(button.disabled).toBe(false);
      }
    });
  });

  it('disables Run when the active conversation is running', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: true,
    });
    store.set(conversationModeAtom, 'safe');
    store.set(activeConversationIdAtom, 'conversation-1');
    store.set(runningConversationIdsAtom, ['conversation-1']);

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      const button = getByLabelText('Run workflow "Order pizza"');
      if (button instanceof HTMLButtonElement) {
        expect(button.disabled).toBe(true);
        expect(button.title).toBe('Conversation is running');
      }
    });
  });

  it('enables Run when a non-active conversation is running (with atoms wired)', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({
      ...DEFAULT_WORKFLOW_SETTINGS,
      allowWorkflowsInSafeMode: true,
    });
    store.set(conversationModeAtom, 'safe');
    store.set(activeConversationIdAtom, 'conversation-1');
    store.set(runningConversationIdsAtom, ['conversation-2']);

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      const button = getByLabelText('Run workflow "Order pizza"');
      if (button instanceof HTMLButtonElement) {
        expect(button.disabled).toBe(false);
      }
    });
  });
});
