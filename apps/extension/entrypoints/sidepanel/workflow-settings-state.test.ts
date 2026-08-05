/* eslint-disable sort-keys */
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { AgentWorkflow } from '@/src/shared/agent-workflows';
import {
  deriveWorkflowRunDisabledReason,
  deriveWorkflowSettingsView,
  formatWorkflowListDate,
  toWorkflowSettingsListItem,
  workflowRunRequestAtom,
} from './workflow-settings-state';

const workflow = (overrides: Partial<AgentWorkflow> = {}): AgentWorkflow => ({
  id: 'wf-1',
  name: 'Test Workflow',
  description: 'A test workflow',
  scopeOrigin: 'https://example.com',
  script: 'return 1;',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

describe('workflow list date formatting', () => {
  it('formats UTC YYYY-MM-DD', () => {
    expect(formatWorkflowListDate(Date.UTC(2024, 5, 10, 12, 0, 0))).toBe('2024-06-10');
  });
});

describe('workflow settings list item mapping', () => {
  it('builds scope and delete label from workflow fields', () => {
    const item = toWorkflowSettingsListItem(
      workflow({
        name: 'My Script',
        scopeOrigin: 'https://shop.example.com',
        pathPrefix: '/admin',
      })
    );
    expect(item.name).toBe('My Script');
    expect(item.scope).toBe('https://shop.example.com/admin');
    expect(item.deleteAriaLabel).toBe('Delete workflow "My Script"');
    expect(item.isApproved).toBe(false);
  });

  it('marks as approved when approvedScriptHash is set', () => {
    const item = toWorkflowSettingsListItem(workflow({ approvedScriptHash: 'abc123' }));
    expect(item.isApproved).toBe(true);
  });

  it('omits prefix when pathPrefix is absent', () => {
    const item = toWorkflowSettingsListItem(workflow({ scopeOrigin: 'https://example.com' }));
    expect(item.scope).toBe('https://example.com');
  });
});

describe('workflow settings view selection', () => {
  it('shows loading while not loaded', () => {
    expect(
      deriveWorkflowSettingsView({
        isLoaded: false,
        loadError: false,
        workflows: [workflow()],
      })
    ).toStrictEqual({ kind: 'loading' });
  });

  it('shows load error after load fails', () => {
    expect(
      deriveWorkflowSettingsView({
        isLoaded: true,
        loadError: true,
        workflows: [],
      })
    ).toStrictEqual({ kind: 'loadError' });
  });

  it('shows empty when loaded with zero workflows', () => {
    expect(
      deriveWorkflowSettingsView({
        isLoaded: true,
        loadError: false,
        workflows: [],
      })
    ).toStrictEqual({ kind: 'empty' });
  });

  it('does not flash empty during loadError when prior workflows exist', () => {
    expect(
      deriveWorkflowSettingsView({
        isLoaded: true,
        loadError: true,
        workflows: [workflow()],
      })
    ).toStrictEqual({ kind: 'loadError' });
  });

  it('lists workflows newest-first', () => {
    const older = workflow({ id: 'older', name: 'Older', updatedAt: 100 });
    const newer = workflow({ id: 'newer', name: 'Newer', updatedAt: 200 });
    const view = deriveWorkflowSettingsView({
      isLoaded: true,
      loadError: false,
      workflows: [older, newer],
    });

    expect(view).toStrictEqual({
      kind: 'list',
      items: [
        {
          dateLabel: formatWorkflowListDate(200),
          deleteAriaLabel: 'Delete workflow "Newer"',
          id: 'newer',
          isApproved: false,
          name: 'Newer',
          scope: 'https://example.com',
        },
        {
          dateLabel: formatWorkflowListDate(100),
          deleteAriaLabel: 'Delete workflow "Older"',
          id: 'older',
          isApproved: false,
          name: 'Older',
          scope: 'https://example.com',
        },
      ],
    });
  });
});

describe('workflow run disabled reason', () => {
  it('returns undefined when everything is allowed (dangerous mode)', () => {
    expect(
      deriveWorkflowRunDisabledReason({
        activeConversationRunning: false,
        allowWorkflowsInSafeMode: false,
        isApproved: true,
        isDangerousMode: true,
      })
    ).toBeUndefined();
  });

  it('returns undefined when everything is allowed (safe mode with toggle on)', () => {
    expect(
      deriveWorkflowRunDisabledReason({
        activeConversationRunning: false,
        allowWorkflowsInSafeMode: true,
        isApproved: true,
        isDangerousMode: false,
      })
    ).toBeUndefined();
  });

  it('disables for unapproved workflows', () => {
    const reason = deriveWorkflowRunDisabledReason({
      activeConversationRunning: false,
      allowWorkflowsInSafeMode: true,
      isApproved: false,
      isDangerousMode: true,
    });
    expect(reason).toStrictEqual({ reason: 'notApproved', label: 'Needs approval' });
  });

  it('disables when safe mode toggle is off in safe mode', () => {
    const reason = deriveWorkflowRunDisabledReason({
      activeConversationRunning: false,
      allowWorkflowsInSafeMode: false,
      isApproved: true,
      isDangerousMode: false,
    });
    expect(reason).toStrictEqual({
      reason: 'safeModeDisabled',
      label: 'Safe mode workflows disabled',
    });
  });

  it('allows Run in dangerous mode with safe toggle off', () => {
    expect(
      deriveWorkflowRunDisabledReason({
        activeConversationRunning: false,
        allowWorkflowsInSafeMode: false,
        isApproved: true,
        isDangerousMode: true,
      })
    ).toBeUndefined();
  });

  it('disables when the active conversation is running', () => {
    const reason = deriveWorkflowRunDisabledReason({
      activeConversationRunning: true,
      allowWorkflowsInSafeMode: true,
      isApproved: true,
      isDangerousMode: true,
    });
    expect(reason).toStrictEqual({
      reason: 'conversationRunning',
      label: 'Conversation is running',
    });
  });

  it('returns notApproved first regardless of other conditions', () => {
    const reason = deriveWorkflowRunDisabledReason({
      activeConversationRunning: true,
      allowWorkflowsInSafeMode: false,
      isApproved: false,
      isDangerousMode: false,
    });
    expect(reason?.reason).toBe('notApproved');
  });

  it('returns safeModeDisabled before conversationRunning in safe mode', () => {
    const reason = deriveWorkflowRunDisabledReason({
      activeConversationRunning: true,
      allowWorkflowsInSafeMode: false,
      isApproved: true,
      isDangerousMode: false,
    });
    expect(reason?.reason).toBe('safeModeDisabled');
  });

  it('does not apply safeModeDisabled in dangerous mode with other conditions', () => {
    const reason = deriveWorkflowRunDisabledReason({
      activeConversationRunning: true,
      allowWorkflowsInSafeMode: false,
      isApproved: true,
      isDangerousMode: true,
    });
    expect(reason?.reason).toBe('conversationRunning');
  });
});

describe('workflow run request atom', () => {
  it('defaults to undefined', () => {
    const store = createStore();
    expect(store.get(workflowRunRequestAtom)).toBeUndefined();
  });

  it('sets and reads a run request', () => {
    const store = createStore();
    store.set(workflowRunRequestAtom, { workflowId: 'wf-test' });
    expect(store.get(workflowRunRequestAtom)).toStrictEqual({ workflowId: 'wf-test' });
  });

  it('can be cleared back to undefined', () => {
    const store = createStore();
    store.set(workflowRunRequestAtom, { workflowId: 'wf-test' });
    store.set(workflowRunRequestAtom, undefined);
    expect(store.get(workflowRunRequestAtom)).toBeUndefined();
  });
});
