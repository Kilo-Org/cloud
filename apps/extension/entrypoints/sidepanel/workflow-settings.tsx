import { storage } from '#imports';
import { useAtomValue, useSetAtom } from 'jotai';
import { Play, Trash2 } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { runningConversationIdsAtom } from './agent-chat-atoms';
import {
  deleteAgentWorkflow,
  loadWorkflowSettings,
  saveWorkflowSettings,
} from '@/src/shared/agent-workflows-storage';
import { useAgentWorkflows } from './use-agent-workflows';
import { WorkflowRunPrompt } from './workflow-run-prompt';
import {
  deriveWorkflowRunDisabledReason,
  deriveWorkflowSettingsView,
  workflowRunRequestAtom,
} from './workflow-settings-state';
import type { WorkflowSettingsListItem } from './workflow-settings-state';
import {
  activeConversationIdAtom,
  conversationModeAtom,
  settingsDialogOpenAtom,
} from './settings-dialog-state';

type AgentWorkflowSettings = Awaited<ReturnType<typeof loadWorkflowSettings>>;
type StoredWorkflow = Parameters<typeof WorkflowRunPrompt>[0]['workflow'];

const EMPTY_MESSAGE =
  'No workflows yet. Ask Kilo to save one — for example "Create a workflow that checks the price of this item" — or repeat steps on a site and Kilo offers to save them.';
const LOAD_ERROR_MESSAGE = "Couldn't load workflows. Try again.";

const secondaryButtonClass =
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

const WorkflowRow = ({
  activeConversationRunning,
  allowWorkflowsInSafeMode,
  isDangerousMode,
  item,
  onDelete,
  onRun,
}: {
  activeConversationRunning: boolean;
  allowWorkflowsInSafeMode: boolean;
  isDangerousMode: boolean;
  item: WorkflowSettingsListItem;
  onDelete: (id: string) => void;
  onRun: (id: string) => void;
}): JSX.Element => {
  const disabledReason = deriveWorkflowRunDisabledReason({
    activeConversationRunning,
    allowWorkflowsInSafeMode,
    isApproved: item.isApproved,
    isDangerousMode,
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <li
      className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-surface-background p-2"
      key={item.id}
    >
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
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition hover:border-brand-primary/50 hover:bg-brand-primary/10 hover:text-brand-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface-overlay disabled:hover:text-foreground-on-secondary"
          disabled={disabledReason !== undefined}
          onClick={() => {
            onRun(item.id);
          }}
          title={disabledReason?.label}
          type="button"
        >
          <Play aria-hidden="true" className="size-3.5" />
        </button>
        <button
          aria-label={confirmingDelete ? `Confirm delete "${item.name}"` : item.deleteAriaLabel}
          className={
            confirmingDelete
              ? 'flex size-8 shrink-0 items-center justify-center rounded-md border border-status-red-500 bg-status-red-500/20 text-status-red-300 transition hover:bg-status-red-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background'
              : 'flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition hover:border-status-red-500/50 hover:bg-status-red-500/10 hover:text-status-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background'
          }
          onBlur={() => {
            setConfirmingDelete(false);
          }}
          onClick={() => {
            if (confirmingDelete) {
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
    </li>
  );
};

export const WorkflowSettings = (): JSX.Element => {
  const { isLoaded, loadError, reload, workflows } = useAgentWorkflows();
  const view = deriveWorkflowSettingsView({ isLoaded, loadError, workflows });
  const runningConversationIds = useAtomValue(runningConversationIdsAtom);
  const mode = useAtomValue(conversationModeAtom);
  const activeConversationId = useAtomValue(activeConversationIdAtom);

  /* Mode atom not wired → safe toggle blocks Run; wired dangerous mode bypasses it. */
  const isDangerousMode = mode === 'dangerous';

  /* Fall back to old behavior when the activeConversationId atom is not yet
     wired: any running conversation blocks Run. Once wired, only the active
     conversation blocks Run. */
  const activeConversationRunning =
    activeConversationId === undefined
      ? runningConversationIds.length > 0
      : runningConversationIds.includes(activeConversationId);

  const [settings, setSettings] = useState<AgentWorkflowSettings>({
    allowWorkflowsInSafeMode: false,
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const setRunRequest = useSetAtom(workflowRunRequestAtom);
  const setIsSettingsOpen = useSetAtom(settingsDialogOpenAtom);

  useEffect(() => {
    void (async () => {
      let loaded: AgentWorkflowSettings = { allowWorkflowsInSafeMode: false };
      try {
        loaded = await loadWorkflowSettings(storage);
      } catch {
        // Use the default; toggle will be off which is the safe choice.
      }
      setSettings(loaded);
      setSettingsLoaded(true);
    })();
  }, []);

  const onToggle = useCallback(() => {
    if (settingsSaving) {
      return;
    }

    const prior = settings;
    setSettingsSaving(true);
    const next: AgentWorkflowSettings = {
      allowWorkflowsInSafeMode: !prior.allowWorkflowsInSafeMode,
    };
    setSettings(next);

    void (async () => {
      try {
        await saveWorkflowSettings(storage, next);
      } catch {
        // Roll back to the prior value on failure so UI and storage stay consistent.
        setSettings(prior);
      } finally {
        setSettingsSaving(false);
      }
    })();
  }, [settings, settingsSaving]);

  const handleDelete = useCallback((id: string) => {
    void deleteAgentWorkflow(storage, id);
  }, []);

  const [runPromptWorkflow, setRunPromptWorkflow] = useState<StoredWorkflow | undefined>();

  const handleRun = useCallback(
    (id: string) => {
      const workflow = workflows.find(candidate => candidate.id === id);
      if (workflow !== undefined && (workflow.params ?? []).length > 0) {
        setRunPromptWorkflow(workflow);
        return;
      }
      setRunRequest({ workflowId: id });
      setIsSettingsOpen(false);
    },
    [workflows, setRunRequest, setIsSettingsOpen]
  );

  const handlePromptRun = useCallback(
    (input: Record<string, string>) => {
      if (runPromptWorkflow === undefined) {
        return;
      }
      setRunRequest({ input, workflowId: runPromptWorkflow.id });
      setRunPromptWorkflow(undefined);
      setIsSettingsOpen(false);
    },
    [runPromptWorkflow, setRunRequest, setIsSettingsOpen]
  );

  return (
    <section
      aria-label="Workflows"
      className="min-w-0 rounded-xl border border-border bg-surface-raised p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="type-body font-medium text-foreground">Allow workflows in safe mode</p>
        </div>
        <button
          aria-checked={settings.allowWorkflowsInSafeMode}
          aria-label="Allow workflows in safe mode"
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected ${
            settings.allowWorkflowsInSafeMode
              ? 'border-brand-primary bg-brand-primary'
              : 'border-border bg-surface-overlay'
          }`}
          disabled={!settingsLoaded || settingsSaving}
          onClick={onToggle}
          role="switch"
          type="button"
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 size-3.5 rounded-full transition ${
              settings.allowWorkflowsInSafeMode
                ? 'left-4 bg-brand-primary-foreground'
                : 'left-0.5 bg-foreground-muted'
            }`}
          />
        </button>
      </div>

      <h2 className="type-label mt-3 text-foreground-muted">Saved workflows</h2>

      {view.kind === 'loading' ? (
        <p className="type-body mt-2 text-foreground-muted">Loading…</p>
      ) : null}

      {view.kind === 'loadError' ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="type-body text-status-red-400">{LOAD_ERROR_MESSAGE}</p>
          <div className="flex justify-end">
            <button className={secondaryButtonClass} onClick={reload} type="button">
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {view.kind === 'empty' ? (
        <p className="type-body mt-2 text-foreground-muted">{EMPTY_MESSAGE}</p>
      ) : null}

      {view.kind === 'list' ? (
        <ul className="mt-2 flex flex-col gap-2">
          {view.items.map(item => (
            <WorkflowRow
              activeConversationRunning={activeConversationRunning}
              allowWorkflowsInSafeMode={settings.allowWorkflowsInSafeMode}
              isDangerousMode={isDangerousMode}
              item={item}
              key={item.id}
              onDelete={handleDelete}
              onRun={handleRun}
            />
          ))}
        </ul>
      ) : null}

      {runPromptWorkflow !== undefined && (
        <WorkflowRunPrompt
          onCancel={() => {
            setRunPromptWorkflow(undefined);
          }}
          onRun={handlePromptRun}
          workflow={runPromptWorkflow}
        />
      )}
    </section>
  );
};
