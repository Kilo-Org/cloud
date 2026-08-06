import { atom } from 'jotai';
import type { AgentWorkflow } from '@/src/shared/agent-workflows';

export type WorkflowSettingsView =
  | { kind: 'loading' }
  | { kind: 'loadError' }
  | { kind: 'empty' }
  | { kind: 'list'; items: readonly WorkflowSettingsListItem[] };

export interface WorkflowSettingsListItem {
  id: string;
  name: string;
  description: string;
  scope: string;
  dateLabel: string;
  isApproved: boolean;
  deleteAriaLabel: string;
}

export interface WorkflowRunDisabledReason {
  reason: 'notApproved' | 'safeModeDisabled' | 'conversationRunning';
  label: string;
}

export interface WorkflowRunRequest {
  workflowId: string;
  input?: Record<string, string> | undefined;
}

export const workflowRunRequestAtom = atom<WorkflowRunRequest | undefined>();

const sortByUpdatedAtDesc = <TItem extends { updatedAt: number }>(
  items: readonly TItem[]
): TItem[] => [...items].toSorted((left, right) => right.updatedAt - left.updatedAt);

export const formatWorkflowListDate = (updatedAt: number): string =>
  new Date(updatedAt).toISOString().slice(0, 10);

export const toWorkflowSettingsListItem = (workflow: AgentWorkflow): WorkflowSettingsListItem => ({
  dateLabel: formatWorkflowListDate(workflow.updatedAt),
  deleteAriaLabel: `Delete workflow "${workflow.name}"`,
  description: workflow.description,
  id: workflow.id,
  isApproved: workflow.approvedScriptHash !== undefined,
  name: workflow.name,
  scope: workflow.scopeOrigin + (workflow.pathPrefix ?? ''),
});

export const deriveWorkflowSettingsView = ({
  isLoaded,
  loadError,
  workflows,
}: {
  isLoaded: boolean;
  loadError: boolean;
  workflows: readonly AgentWorkflow[];
}): WorkflowSettingsView => {
  if (!isLoaded) {
    return { kind: 'loading' };
  }

  if (loadError) {
    return { kind: 'loadError' };
  }

  if (workflows.length === 0) {
    return { kind: 'empty' };
  }

  return {
    items: sortByUpdatedAtDesc(workflows).map(entry => toWorkflowSettingsListItem(entry)),
    kind: 'list',
  };
};

export const deriveWorkflowRunDisabledReason = ({
  activeConversationRunning,
  allowWorkflowsInSafeMode,
  isApproved,
  isDangerousMode,
}: {
  /** True when the active conversation is running. Only the active conversation blocks Run. */
  activeConversationRunning: boolean;
  allowWorkflowsInSafeMode: boolean;
  isApproved: boolean;
  /** True when the active conversation is in dangerous mode. Safe toggle only disables Run in safe mode. */
  isDangerousMode: boolean;
}): WorkflowRunDisabledReason | undefined => {
  if (!isApproved) {
    return { label: 'Needs approval', reason: 'notApproved' };
  }

  if (!isDangerousMode && !allowWorkflowsInSafeMode) {
    return { label: 'Safe mode workflows disabled', reason: 'safeModeDisabled' };
  }

  if (activeConversationRunning) {
    return { label: 'Conversation is running', reason: 'conversationRunning' };
  }

  return undefined;
};
