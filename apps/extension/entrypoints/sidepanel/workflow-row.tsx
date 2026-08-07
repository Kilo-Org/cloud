import { Play, Trash2 } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { WorkflowRunPrompt } from './workflow-run-prompt';
import { deriveWorkflowRunDisabledReason } from './workflow-settings-state';
import type { WorkflowSettingsListItem } from './workflow-settings-state';

const iconButtonClass =
  'flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

const runButtonClass = `${iconButtonClass} hover:border-brand-primary/50 hover:bg-brand-primary/10 hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface-overlay disabled:hover:text-foreground-on-secondary`;

const deleteButtonClass = `${iconButtonClass} hover:border-status-red-500/50 hover:bg-status-red-500/10 hover:text-status-red-300`;

const confirmDeleteButtonClass =
  'flex size-8 shrink-0 items-center justify-center rounded-md border border-status-red-500 bg-status-red-500/20 text-status-red-300 transition hover:bg-status-red-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

/**
 * One saved workflow: name, description, scope, and the run and delete
 * controls. The row owns its own delete confirmation and, when the workflow
 * declares params, the form that collects their values before a run. When
 * autoApproveChanges is set, the delete control acts on the first click.
 */
export const WorkflowRow = ({
  activeConversationRunning,
  allowWorkflowsInSafeMode,
  autoApproveChanges,
  isDangerousMode,
  item,
  onDelete,
  onRun,
}: {
  activeConversationRunning: boolean;
  allowWorkflowsInSafeMode: boolean;
  autoApproveChanges: boolean;
  isDangerousMode: boolean;
  item: WorkflowSettingsListItem;
  onDelete: (id: string) => void;
  onRun: (id: string, input?: Record<string, string>) => void;
}): JSX.Element => {
  const disabledReason = deriveWorkflowRunDisabledReason({
    activeConversationRunning,
    allowWorkflowsInSafeMode,
    isApproved: item.isApproved,
    isDangerousMode,
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [collectingInput, setCollectingInput] = useState(false);

  const startRun = (): void => {
    if (item.params.length > 0) {
      setCollectingInput(true);
      return;
    }
    onRun(item.id);
  };

  return (
    <li className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-surface-background p-2">
      <div className="min-w-0 flex-1">
        <p className="type-body truncate font-medium text-foreground" title={item.name}>
          {item.name}
        </p>
        {item.description !== '' && (
          <p className="type-label mt-0.5 line-clamp-2 text-foreground-muted">{item.description}</p>
        )}
        <p className="type-label mt-0.5 text-foreground-muted">
          {item.scope}
          {' · '}
          {item.dateLabel}
          {item.isApproved ? null : (
            <>
              {' · '}
              <span className="text-status-yellow-400">needs approval</span>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          aria-label={`Run workflow "${item.name}"`}
          className={runButtonClass}
          disabled={disabledReason !== undefined}
          onClick={startRun}
          title={disabledReason?.label}
          type="button"
        >
          <Play aria-hidden="true" className="size-3.5" />
        </button>
        <button
          aria-label={confirmingDelete ? `Confirm delete "${item.name}"` : item.deleteAriaLabel}
          className={confirmingDelete ? confirmDeleteButtonClass : deleteButtonClass}
          onBlur={() => {
            setConfirmingDelete(false);
          }}
          onClick={() => {
            if (autoApproveChanges || confirmingDelete) {
              onDelete(item.id);
              return;
            }
            setConfirmingDelete(true);
          }}
          title={confirmingDelete ? 'Click again to delete' : undefined}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>

      {collectingInput && (
        <WorkflowRunPrompt
          name={item.name}
          onCancel={() => {
            setCollectingInput(false);
          }}
          onRun={input => {
            setCollectingInput(false);
            onRun(item.id, input);
          }}
          params={item.params}
        />
      )}
    </li>
  );
};
