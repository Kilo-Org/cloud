import { storage } from '#imports';
import { useAtom } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AgentWorkflow, PendingAgentWorkflowDraft } from '@/src/shared/agent-workflows';
import { loadAgentWorkflows, loadPendingWorkflowDraft } from '@/src/shared/agent-workflows-storage';
import { applyApprovalDecision, pendingApprovalAtom } from './pending-approval';
import { CollapsibleCodeBlock } from './collapsible-code-block.tsx';
import { deriveWorkflowSaveCardState } from './pending-workflow-save-card-state';

const secondaryButtonClass =
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle';

const primaryButtonClass =
  'type-label h-8 rounded-md bg-brand-primary px-3 text-brand-primary-foreground transition hover:bg-brand-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle';

export const PendingWorkflowSaveCard = (): JSX.Element | null => {
  const [approvalEntry, setApprovalEntry] = useAtom(pendingApprovalAtom);
  const [pendingDraft, setPendingDraft] = useState<PendingAgentWorkflowDraft | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);
  const [storedWorkflow, setStoredWorkflow] = useState<AgentWorkflow | undefined>();
  const settledRef = useRef(false);

  // Load draft and atom on mount.
  useEffect(() => {
    void (async () => {
      // If atom has an entry for workflow kind, use it.
      if (approvalEntry !== undefined && approvalEntry.kind === 'workflow') {
        const { draft } = approvalEntry;
        setPendingDraft(draft);

        // For updates, also load the stored workflow for old-script comparison.
        if (draft.workflowId !== undefined) {
          const workflows = await loadAgentWorkflows(storage);
          const existing = workflows.find(wf => wf.id === draft.workflowId);
          if (existing === undefined) {
            setLoadError('The original workflow was deleted. This update cannot be saved.');
          } else {
            setStoredWorkflow(existing);
          }
        }

        setLoaded(true);
        return;
      }

      // Reload path: check stored draft.
      const storedDraft = await loadPendingWorkflowDraft(storage);
      if (storedDraft !== undefined) {
        setPendingDraft(storedDraft);

        // If it's an update, load the stored workflow for comparison.
        if (storedDraft.workflowId !== undefined) {
          const workflows = await loadAgentWorkflows(storage);
          const existing = workflows.find(wf => wf.id === storedDraft.workflowId);
          if (existing === undefined) {
            setLoadError('The original workflow was deleted. This update cannot be saved.');
          } else {
            setStoredWorkflow(existing);
          }
        }
      }

      setLoaded(true);
    })();
  }, [approvalEntry]);

  const handleCancel = async (): Promise<void> => {
    if (approvalEntry !== undefined && approvalEntry.kind === 'workflow' && !settledRef.current) {
      settledRef.current = true;
      approvalEntry.settle({ status: 'rejected' });
      setApprovalEntry(undefined);
    }
    // ApplyApprovalDecision for reject clears the draft + storage.
    if (pendingDraft !== undefined) {
      await applyApprovalDecision(storage, 'workflow', pendingDraft, false);
      setPendingDraft(undefined);
    }
    setSaveError(undefined);
  };

  const handleApprove = async (): Promise<void> => {
    if (pendingDraft === undefined || isSaving) {
      return;
    }

    setIsSaving(true);

    try {
      const outcome = await applyApprovalDecision(storage, 'workflow', pendingDraft, true);

      if (outcome.status === 'approved') {
        if (
          approvalEntry !== undefined &&
          approvalEntry.kind === 'workflow' &&
          !settledRef.current
        ) {
          settledRef.current = true;
          approvalEntry.settle(outcome);
          setApprovalEntry(undefined);
        }
        setPendingDraft(undefined);
        setSaveError(undefined);
        return;
      }

      if (outcome.status === 'failed') {
        if (
          approvalEntry !== undefined &&
          approvalEntry.kind === 'workflow' &&
          !settledRef.current
        ) {
          settledRef.current = true;
          approvalEntry.settle(outcome);
          setApprovalEntry(undefined);
        }
        setSaveError(outcome.reason);
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Couldn't save workflow.");
    } finally {
      setIsSaving(false);
    }
  };

  const view = deriveWorkflowSaveCardState({
    isSaving,
    loadError: loadError === null ? undefined : loadError,
    pendingDraft,
    saveError,
  });

  if (!loaded || view.kind === 'hidden') {
    return null;
  }

  const isUpdate = pendingDraft?.workflowId !== undefined;

  return (
    <div
      aria-label="Save workflow"
      aria-modal="true"
      className="fixed inset-0 z-[25] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface-raised p-3 shadow-lg shadow-black/50">
        {view.kind === 'loadError' ? (
          <div className="flex flex-col gap-3">
            <p className="type-body text-status-red-400">{view.message}</p>
            <div className="flex justify-end">
              <button
                className={secondaryButtonClass}
                onClick={() => {
                  void handleCancel();
                }}
                type="button"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {view.kind === 'saveError' ? (
          <div className="flex flex-col gap-3">
            <p className="type-body text-status-red-400">{view.message}</p>
          </div>
        ) : null}

        {pendingDraft && (
          <div className="flex flex-col gap-3">
            <div className="space-y-1">
              <p className="type-label text-foreground-muted">Name</p>
              <p className="type-body text-foreground">{pendingDraft.name}</p>
            </div>

            <div className="space-y-1">
              <p className="type-label text-foreground-muted">Scope</p>
              <p className="type-body text-foreground">
                {pendingDraft.scopeOrigin}
                {pendingDraft.pathPrefix !== undefined && pendingDraft.pathPrefix !== ''
                  ? pendingDraft.pathPrefix
                  : ''}
              </p>
            </div>

            {pendingDraft.startUrl !== undefined && pendingDraft.startUrl !== '' && (
              <div className="space-y-1">
                <p className="type-label text-foreground-muted">Start URL</p>
                <p className="type-body break-all text-foreground">{pendingDraft.startUrl}</p>
              </div>
            )}

            {isUpdate && storedWorkflow !== undefined ? (
              <>
                <div className="space-y-1">
                  <p className="type-label text-foreground-muted">Stored script</p>
                  <CollapsibleCodeBlock code={storedWorkflow.script} forceExpanded={false} />
                </div>
                <div className="space-y-1">
                  <p className="type-label text-foreground-muted">New script</p>
                  <CollapsibleCodeBlock code={pendingDraft.script} forceExpanded={false} />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <p className="type-label text-foreground-muted">Script</p>
                <CollapsibleCodeBlock code={pendingDraft.script} forceExpanded={false} />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                className={secondaryButtonClass}
                disabled={isSaving}
                onClick={() => {
                  void handleCancel();
                }}
                type="button"
              >
                Reject
              </button>
              <button
                className={primaryButtonClass}
                disabled={isSaving}
                onClick={() => {
                  void handleApprove();
                }}
                type="button"
              >
                {isSaving ? 'Saving...' : 'Approve and save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
