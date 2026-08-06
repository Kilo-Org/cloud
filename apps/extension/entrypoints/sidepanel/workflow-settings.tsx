import { storage } from '#imports';
import { useAtomValue, useSetAtom } from 'jotai';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { runningConversationIdsAtom } from './agent-chat-atoms';
import {
  deleteAgentWorkflow,
  loadWorkflowSettings,
  saveWorkflowSettings,
} from '@/src/shared/agent-workflows-storage';
import { DEFAULT_WORKFLOW_SETTINGS } from '@/src/shared/agent-workflows';
import type { AgentWorkflowSettings } from '@/src/shared/agent-workflows';
import { useAgentWorkflows } from './use-agent-workflows';
import { WorkflowRow } from './workflow-row';
import { deriveWorkflowSettingsView, workflowRunRequestAtom } from './workflow-settings-state';
import {
  activeConversationIdAtom,
  conversationModeAtom,
  settingsDialogOpenAtom,
} from './settings-dialog-state';

const EMPTY_MESSAGE =
  'No workflows yet. Ask Kilo to save one — for example "Create a workflow that checks the price of this item" — or repeat steps on a site and Kilo offers to save them.';
const LOAD_ERROR_MESSAGE = "Couldn't load workflows. Try again.";
const DELETE_ERROR_MESSAGE = "Couldn't delete the workflow. Try again.";

const SETTINGS_TOGGLE_ROWS = [
  { key: 'allowWorkflowsInSafeMode', label: 'Allow workflows in safe mode' },
  { key: 'autoApproveWorkflowChanges', label: 'Auto-approve workflow changes' },
  { key: 'autoApproveWorkflowRuns', label: 'Auto-approve workflow runs' },
] as const satisfies readonly { key: keyof AgentWorkflowSettings; label: string }[];

const secondaryButtonClass =
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

const SettingsToggle = ({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}): JSX.Element => (
  <div className="flex items-start justify-between gap-3">
    <div className="min-w-0 flex-1">
      <p className="type-body font-medium text-foreground">{label}</p>
    </div>
    <button
      aria-checked={checked}
      aria-label={label}
      className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected ${
        checked ? 'border-brand-primary bg-brand-primary' : 'border-border bg-surface-overlay'
      }`}
      disabled={disabled}
      onClick={onToggle}
      role="switch"
      type="button"
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 size-3.5 rounded-full transition ${
          checked ? 'left-4 bg-brand-primary-foreground' : 'left-0.5 bg-foreground-muted'
        }`}
      />
    </button>
  </div>
);

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
    ...DEFAULT_WORKFLOW_SETTINGS,
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  const setRunRequest = useSetAtom(workflowRunRequestAtom);
  const setIsSettingsOpen = useSetAtom(settingsDialogOpenAtom);

  useEffect(() => {
    void (async () => {
      let loaded: AgentWorkflowSettings = { ...DEFAULT_WORKFLOW_SETTINGS };
      try {
        loaded = await loadWorkflowSettings(storage);
      } catch {
        // Use the default; toggle will be off which is the safe choice.
      }
      setSettings(loaded);
      setSettingsLoaded(true);
    })();
  }, []);

  const onToggle = useCallback(
    (key: keyof AgentWorkflowSettings) => {
      if (settingsSaving) {
        return;
      }

      const prior = settings;
      setSettingsSaving(true);
      const next: AgentWorkflowSettings = {
        ...prior,
        [key]: !prior[key],
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
    },
    [settings, settingsSaving]
  );

  const handleDelete = useCallback((id: string) => {
    setDeleteError(false);
    void (async () => {
      try {
        await deleteAgentWorkflow(storage, id);
      } catch {
        setDeleteError(true);
      }
    })();
  }, []);

  const handleRun = useCallback(
    (id: string, input?: Record<string, string>) => {
      setRunRequest({ workflowId: id, ...(input === undefined ? {} : { input }) });
      setIsSettingsOpen(false);
    },
    [setRunRequest, setIsSettingsOpen]
  );

  return (
    <section
      aria-label="Workflows"
      className="min-w-0 rounded-xl border border-border bg-surface-raised p-3"
    >
      <div className="flex flex-col gap-3">
        {SETTINGS_TOGGLE_ROWS.map(row => (
          <SettingsToggle
            checked={settings[row.key]}
            disabled={!settingsLoaded || settingsSaving}
            key={row.key}
            label={row.label}
            onToggle={() => {
              onToggle(row.key);
            }}
          />
        ))}
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
        <>
          {deleteError ? (
            <p className="type-body mt-2 text-status-red-400">{DELETE_ERROR_MESSAGE}</p>
          ) : null}
          <ul className="mt-2 flex flex-col gap-2">
            {view.items.map(item => (
              <WorkflowRow
                activeConversationRunning={activeConversationRunning}
                allowWorkflowsInSafeMode={settings.allowWorkflowsInSafeMode}
                autoApproveChanges={settings.autoApproveWorkflowChanges}
                isDangerousMode={isDangerousMode}
                item={item}
                key={item.id}
                onDelete={handleDelete}
                onRun={handleRun}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
};
