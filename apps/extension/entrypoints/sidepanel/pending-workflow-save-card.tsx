import { storage } from '#imports';
import { useAtom } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AgentWorkflow, PendingAgentWorkflowDraft } from '@/src/shared/agent-workflows';
import { loadAgentWorkflows, loadPendingWorkflowDraft } from '@/src/shared/agent-workflows-storage';
import { applyApprovalDecision, pendingApprovalAtom } from './pending-approval';
import { deriveWorkflowSaveCardState } from './pending-workflow-save-card-state';
import { WorkflowScriptDiff } from './workflow-script-diff.tsx';

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
  const lastDraftKeyRef = useRef<string | null>(null);
  const loadFailedRef = useRef(false);

  // Load draft and atom on mount. Ignore results and errors from superseded runs.
  useEffect(() => {
    let cancelled = false;

    const loadStoredWorkflow = async (workflowId: string): Promise<void> => {
      const workflows = await loadAgentWorkflows(storage);
      if (cancelled) {
        return;
      }
      const existing = workflows.find(wf => wf.id === workflowId);
      if (existing === undefined) {
        setLoadError('The original workflow was deleted. This update cannot be saved.');
      } else {
        setStoredWorkflow(existing);
      }
    };

    void (async () => {
      try {
        if (approvalEntry !== undefined && approvalEntry.kind === 'workflow') {
          const { draft } = approvalEntry;
          const draftKey = `${draft.createdAt}:${draft.script}`;
          if (lastDraftKeyRef.current !== draftKey || loadFailedRef.current) {
            // New draft or a recovery from a reload-path failure: reset stale state.
            settledRef.current = false;
            loadFailedRef.current = false;
            setSaveError(undefined);
            setLoadError(undefined);
            setStoredWorkflow(undefined);
          }
          lastDraftKeyRef.current = draftKey;
          setPendingDraft(draft);

          if (draft.workflowId !== undefined) {
            await loadStoredWorkflow(draft.workflowId);
          }

          return;
        }

        // Reload path: check stored draft.
        const storedDraft = await loadPendingWorkflowDraft(storage);
        if (cancelled) {
          return;
        }
        if (storedDraft !== undefined) {
          lastDraftKeyRef.current = `${storedDraft.createdAt}:${storedDraft.script}`;
          setPendingDraft(storedDraft);
          if (storedDraft.workflowId !== undefined) {
            await loadStoredWorkflow(storedDraft.workflowId);
          }
        }
      } catch {
        if (!cancelled) {
          loadFailedRef.current = true;
          setLoadError(
            "Couldn't read the approved script. Dismiss and ask Kilo to save the workflow again."
          );
        }
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
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
    setLoadError(undefined);
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
      <div className="flex max-h-full w-full max-w-sm flex-col rounded-xl border border-border bg-surface-raised p-3 shadow-lg shadow-black/50">
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

        {pendingDraft && view.kind !== 'loadError' && (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex flex-col gap-3">
                <div className="space-y-1">
                  <p className="type-body font-semibold text-foreground">
                    {isUpdate ? 'Update this workflow?' : 'Save this workflow?'}
                  </p>
                  <p className="type-label text-foreground-muted">
                    Kilo can only run the version you approve.
                  </p>
                </div>

                <div className="space-y-1">
                  <p className="type-body font-medium text-foreground">{pendingDraft.name}</p>
                  {pendingDraft.description !== '' && (
                    <p className="type-label text-foreground-muted">{pendingDraft.description}</p>
                  )}
                </div>

                <div className="space-y-1">
                  <p className="type-label text-foreground-muted">Runs on</p>
                  <p className="type-body break-all text-foreground">
                    {pendingDraft.scopeOrigin}
                    {pendingDraft.pathPrefix !== undefined && pendingDraft.pathPrefix !== ''
                      ? pendingDraft.pathPrefix
                      : ''}
                  </p>
                </div>

                {pendingDraft.startUrl !== undefined && pendingDraft.startUrl !== '' && (
                  <div className="space-y-1">
                    <p className="type-label text-foreground-muted">Starts at</p>
                    <p className="type-body break-all text-foreground">{pendingDraft.startUrl}</p>
                  </div>
                )}

                {pendingDraft.params !== undefined && pendingDraft.params.length > 0 && (
                  <div className="space-y-1">
                    <p className="type-label text-foreground-muted">Inputs</p>
                    <ul className="flex flex-col gap-1">
                      {pendingDraft.params.map(param => (
                        <li className="type-label text-foreground" key={param.name}>
                          <span className="font-mono">{param.name}</span>
                          {param.required === true ? (
                            <span className="text-foreground-muted"> (required)</span>
                          ) : null}
                          <span className="text-foreground-muted"> — {param.description}</span>
                          {param.example !== undefined && param.example !== '' ? (
                            <span className="text-foreground-subtle"> e.g. {param.example}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="space-y-1">
                  <div className="rounded bg-surface-inset p-2 font-mono text-xs leading-4 text-foreground-muted">
                    <WorkflowScriptDiff
                      newScript={pendingDraft.script}
                      oldScript={storedWorkflow?.script}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-3 flex shrink-0 justify-end gap-2">
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
          </>
        )}
      </div>
    </div>
  );
};
