import type { PendingAgentWorkflowDraft } from '@/src/shared/agent-workflows';

export type WorkflowSaveCardView =
  | { kind: 'hidden' }
  | { kind: 'draft' }
  | { kind: 'saving' }
  | { kind: 'saveError'; message: string }
  | { kind: 'loadError'; message: string };

export const deriveWorkflowSaveCardState = ({
  pendingDraft,
  isSaving,
  saveError,
  loadError,
}: {
  pendingDraft: PendingAgentWorkflowDraft | undefined;
  isSaving: boolean;
  saveError: string | undefined;
  loadError: string | undefined;
}): WorkflowSaveCardView => {
  // A load failure is visible even when no draft was read (reload-path rejection).
  if (loadError !== undefined) {
    return { kind: 'loadError', message: loadError };
  }

  if (pendingDraft === undefined) {
    return { kind: 'hidden' };
  }

  if (isSaving) {
    return { kind: 'saving' };
  }

  if (saveError !== undefined) {
    return { kind: 'saveError', message: saveError };
  }

  return { kind: 'draft' };
};
