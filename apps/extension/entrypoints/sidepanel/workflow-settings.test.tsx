/* eslint-disable capitalized-comments, id-length, init-declarations, jest/no-hooks, jest/no-untyped-mock-factory, jest/no-conditional-expect, jest/no-conditional-in-test, max-lines, no-unused-expressions, sort-keys, vitest/prefer-import-in-mock, vitest/prefer-called-times -- test fixture constraints */
/* eslint-disable import/first */
// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { createElement } from 'react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
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

vi.mock('#imports', () => ({
  storage: {},
}));

import { useAgentWorkflows } from './use-agent-workflows';
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
    store = createStore();
    store.set(runningConversationIdsAtom, []);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('renders the toggle heading and saved workflows label', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });

    const { getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(getByText('Allow workflows in safe mode')).toBeDefined();
    });
    expect(getByText('Saved workflows')).toBeDefined();
  });

  it('shows empty state when no workflows', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });

    const { getByText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(
        getByText('No workflows yet. Kilo offers to save one when you repeat steps on a site.')
      ).toBeDefined();
    });
  });

  it('shows loading message when not loaded', () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      isLoaded: false,
    });
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });

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
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });

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
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });

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
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });

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
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: true });
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

    expect(store.get(workflowRunRequestAtom)).toStrictEqual({ workflowId: 'wf-1' });
    expect(store.get(settingsDialogOpenAtom)).toBe(false);
  });

  it('sets the toggle on click and persists the change', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });
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
        allowWorkflowsInSafeMode: true,
      });
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.getAttribute('aria-checked')).toBe('true');
      }
    });
  });

  it('rolls back toggle state when save fails', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });
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

  it('keeps toggle enabled after settings-load failure', async () => {
    mockUseAgentWorkflows.mockReturnValue(emptyResult);
    mockLoadWorkflowSettings.mockRejectedValue(new Error('Storage read failed'));

    const { getByLabelText } = render(createElement(WorkflowSettings), {
      wrapper: createWrapper(store),
    });

    const toggle = getByLabelText('Allow workflows in safe mode');
    await waitFor(() => {
      if (toggle instanceof HTMLButtonElement) {
        expect(toggle.disabled).toBe(false);
      }
    });
    toggle instanceof HTMLButtonElement &&
      expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('calls deleteAgentWorkflow on delete click', async () => {
    mockUseAgentWorkflows.mockReturnValue({
      ...emptyResult,
      workflows: [approvedWorkflow],
    });
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });
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

    expect(mockDeleteAgentWorkflow).toHaveBeenCalledWith(expect.anything(), 'wf-1');
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
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: true });

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
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });
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
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: false });
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
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: true });
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
    mockLoadWorkflowSettings.mockResolvedValue({ allowWorkflowsInSafeMode: true });
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
