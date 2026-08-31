/* eslint-disable max-lines, import/max-dependencies, typescript/consistent-type-definitions -- Consent, settings, and modal supervision share the existing provider, not another runtime. */
import { browser } from '#imports';
import { useQuery } from '@tanstack/react-query';
import type { BrowserJobSnapshot } from '@kilocode/cloud-agent-sdk/schemas';
import { BrowserProviderError } from '@kilocode/cloud-agent-sdk/user-web-connection';
import { Square } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { ExecutionStoppedError } from '@/src/shared/agent-tool-results';
import type { StoredAuth } from '@/src/shared/auth';
import type { BrowserProviderSettings } from '@/src/shared/browser-provider-settings';
import { AgentFooterControls } from './agent-footer-controls';
import { useBrowserExecutionSnapshot } from './browser-execution-lock';
import type { BrowserRecoveryReadiness } from './browser-execution-lock';
import { useBrowserTask } from './browser-task-provider';
import type { BrowserTaskProviderSnapshot } from './browser-task-provider';
import { getBrowserTaskTabs } from './browser-task-runner';
import { BrowserTaskSupervisionContext } from './browser-task-supervision-slot';
import { useGatewayModels } from './use-gateway-models';
import { useTabDebugger } from './use-tab-debugger';
import { SettingsToggle } from './workflow-settings';

const actionClass =
  'type-label min-h-9 max-w-full shrink-0 rounded-md border border-border bg-surface-overlay px-3 py-1 text-foreground-on-secondary outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:cursor-not-allowed disabled:text-foreground-subtle';
const emptyThinkingOptions: string[] = [];
const modeLabels = { dangerous: 'Dangerous', safe: 'Safe' };
const phaseLabels = {
  awaiting_approval: 'Tab approval required',
  connecting: 'Connecting',
  disabled: 'Disabled',
  idle: 'Enabled — idle',
  interrupted: 'Interrupted',
  owned_elsewhere: 'Ownership not acquired',
  recovery: 'Recovery required',
  running: 'Running',
  unavailable: 'Unavailable',
  unsupported: 'Unsupported',
  waiting: 'Waiting for browser control',
} satisfies Record<BrowserTaskProviderSnapshot['phase'], string>;

const Owner = ({ label }: { label: string | undefined }): JSX.Element => (
  <p className="break-words [overflow-wrap:anywhere]">
    Owner session: {label ?? 'Unknown'}
    {label === undefined ? null : (
      <span className="ml-2 font-mono text-foreground-muted" title={label}>
        (ID {label.slice(-8)})
      </span>
    )}
  </p>
);

const Deadline = ({ job }: { job: BrowserJobSnapshot }): JSX.Element => {
  let deadline = job.deadlines.approval;
  let label = 'Approval';
  if (job.status === 'queued') {
    deadline = job.deadlines.queue;
    label = 'Queue';
  } else if (job.status === 'running' || job.approvedTab !== undefined) {
    deadline = job.deadlines.execution;
    label = 'Execution';
  }
  return (
    <p className="text-foreground-muted">
      {label} deadline:{' '}
      {deadline === undefined ? (
        'Unknown'
      ) : (
        <time dateTime={deadline}>{new Date(deadline).toLocaleString()}</time>
      )}
    </p>
  );
};

const TabConsent = ({
  active,
}: {
  active: NonNullable<BrowserTaskProviderSnapshot['active']>;
}): JSX.Element => {
  const task = useBrowserTask();
  const [tabId, setTabId] = useState<number>();
  const [approving, setApproving] = useState(false);
  const tabs = useQuery({
    queryFn: getBrowserTaskTabs,
    queryKey: ['browser-task-consent-tabs'],
    refetchInterval: 2000,
  });
  // A candidate is local to this invocation. The Browser target selector never grants consent.
  const candidate = tabs.isError ? undefined : tabs.data?.find(tab => tab.id === tabId);
  let tabMessage = 'Choose an inspectable tab. If none are listed, open a page and refresh tabs.';
  if (tabs.isPending) {
    tabMessage = 'Loading inspectable tabs...';
  } else if (tabs.isError) {
    tabMessage = 'Could not retrieve tabs. Refresh tabs before approval.';
  } else if (tabId !== undefined) {
    tabMessage =
      'That candidate tab is no longer available. The goal is retained. Choose another tab before the deadline.';
  }
  const handleApprove = async (): Promise<void> => {
    if (candidate === undefined || approving) {
      return;
    }
    setApproving(true);
    try {
      await task.approve(active.job.jobId, candidate.id);
    } finally {
      setApproving(false);
    }
  };
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <p>
        The Browser target selector does not approve CLI access. Approve a tab for this invocation
        only.
      </p>
      <label className="grid min-w-0 grid-cols-1 gap-1">
        Tab to approve
        <select
          className="type-label min-h-9 w-full min-w-0 rounded-md border border-border-strong bg-input-bg px-2 text-foreground focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
          disabled={approving || tabs.isPending || tabs.isError}
          onChange={event => {
            setTabId(
              event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value)
            );
          }}
          value={tabId ?? ''}
        >
          <option value="">Choose a tab</option>
          {tabId !== undefined && candidate === undefined ? (
            <option value={tabId}>Candidate tab unavailable</option>
          ) : null}
          {tabs.data?.map(tab => (
            <option key={tab.id} value={tab.id}>
              {tab.title}
            </option>
          ))}
        </select>
      </label>
      {candidate === undefined ? (
        <p role="status">{tabMessage}</p>
      ) : (
        <div className="max-h-28 overflow-y-auto break-words [overflow-wrap:anywhere]">
          <p>Tab: {candidate.title}</p>
          <p>Address: {candidate.url}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className={actionClass}
          disabled={
            candidate === undefined ||
            approving ||
            task.state.settings === undefined ||
            task.state.settings.model === ''
          }
          onClick={() => {
            void handleApprove();
          }}
          type="button"
        >
          {approving ? 'Approving tab...' : 'Approve tab'}
        </button>
        <button
          className={actionClass}
          onClick={() => {
            task.reject(active.job.jobId);
          }}
          type="button"
        >
          Reject
        </button>
        <button
          className={actionClass}
          disabled={tabs.isFetching}
          onClick={() => {
            void tabs.refetch();
          }}
          type="button"
        >
          Refresh tabs
        </button>
      </div>
    </div>
  );
};

export const BrowserTaskControls = (): JSX.Element => {
  const task = useBrowserTask();
  const { state } = task;
  const execution = useBrowserExecutionSnapshot();
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [readiness, setReadiness] = useState<{
    snapshot: BrowserTaskProviderSnapshot;
    value: BrowserRecoveryReadiness;
  }>();
  const { active } = state;
  const ownershipRejected = state.phase === 'owned_elsewhere';
  const initializationFailed =
    state.phase === 'unavailable' &&
    state.retryable &&
    state.profile === undefined &&
    state.settings === undefined;
  const reloadBlocked =
    active !== undefined || execution.delegated !== 'idle' || execution.localRuns > 0;
  const settings = active?.approval?.settings ?? state.settings;
  const boundTab = active?.approval?.tab ?? active?.job.approvedTab;
  const modelLabel =
    settings === undefined || settings.model === '' ? 'Not selected' : settings.model;
  const queued = state.jobs
    .filter(job => job.status === 'queued' && job.result === undefined)
    .toSorted(
      (left, right) => (left.queuePosition ?? Infinity) - (right.queuePosition ?? Infinity)
    );
  const recoverable =
    state.phase === 'recovery' ||
    state.phase === 'interrupted' ||
    state.phase === 'unavailable' ||
    state.unresolvedFence !== undefined ||
    (execution.delegated === 'idle' && execution.blockedReason !== undefined);
  const affectedTabIds = [
    ...new Set([
      ...execution.quarantinedTabIds,
      ...(state.unresolvedFence?.tabId === undefined ? [] : [state.unresolvedFence.tabId]),
    ]),
  ];
  const affectedTabs = useQuery({
    enabled: affectedTabIds.length > 0,
    // Recovery includes tabs that navigated to an uninspectable address.
    queryFn: () => browser.tabs.query({}),
    queryKey: ['browser-task-affected-tabs'],
    refetchInterval: 2000,
  });
  useEffect(() => {
    setNotice(undefined);
  }, [active?.job.jobId]);
  const perform = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (pending !== undefined) {
      return;
    }
    setPending(label);
    setNotice(undefined);
    setReadiness(undefined);
    try {
      await action();
    } catch (error) {
      if (error instanceof BrowserProviderError) {
        setNotice(
          error.retryable
            ? `Status unavailable: ${error.code}. Reconnect and retrieve status again. No work was resubmitted.`
            : `Status denied: ${error.code}. Restore provider access before retrieving status. No work was resubmitted.`
        );
      } else if (error instanceof ExecutionStoppedError) {
        setNotice(
          `Status interrupted: ${error.reason}. Use the owning signed-in panel to retrieve status. No work was resubmitted.`
        );
      } else {
        setNotice(
          'The request failed. Restore the relay connection and retrieve status. No work was resubmitted.'
        );
      }
    } finally {
      setPending(undefined);
    }
  };

  return (
    <section
      aria-label="CLI task supervision"
      className="sticky top-0 z-10 flex max-h-[45dvh] min-h-0 min-w-0 shrink-0 flex-col border-b border-border bg-surface-raised text-foreground"
      data-browser-task-supervision=""
    >
      <div className="flex shrink-0 items-start justify-between gap-2 px-3 py-2">
        <p aria-live="polite" className="type-label min-w-0 break-words" role="status">
          CLI tasks: {phaseLabels[state.phase]}
        </p>
        {active !== undefined && active.job.result === undefined ? (
          <button
            aria-label="Stop CLI task"
            className={`${actionClass} flex items-center gap-1`}
            onClick={() => {
              task.cancel(active.job.jobId);
              setNotice(
                'Stop requested. Issued actions are not undone. Retrieve status to confirm the outcome.'
              );
            }}
            type="button"
          >
            <Square aria-hidden="true" className="size-3 shrink-0" />
            Stop
          </button>
        ) : null}
      </div>
      <div className="agent-conversation-scrollbar type-label grid min-h-0 min-w-0 grid-cols-1 gap-2 overflow-y-auto px-3 pb-3 [overflow-wrap:anywhere]">
        <p aria-live="polite">
          {ownershipRejected ? 'This panel could not acquire browser ownership.' : state.message}
        </p>
        {state.profile === undefined ? null : (
          <p>
            Profile: {state.profile.label} ·{' '}
            <span className="font-mono">{state.profile.providerId}</span>
          </p>
        )}
        {active === undefined ? null : (
          <>
            <Owner label={active.ownerLabel} />
            <p className="font-mono text-foreground-muted">Task ID: {active.job.jobId.slice(-8)}</p>
            <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
              Goal: {active.goal}
            </div>
            <p>
              Mode: {settings === undefined ? 'Unknown' : modeLabels[settings.mode]} · Model:{' '}
              {modelLabel}
            </p>
            {boundTab === undefined ? (
              <p>Bound tab: Not approved</p>
            ) : (
              <div className="max-h-24 overflow-y-auto">
                <p>
                  Bound tab: {boundTab.title} (ID {boundTab.tabId})
                </p>
                <p>Address: {boundTab.url}</p>
              </div>
            )}
            <Deadline job={active.job} />
            {state.phase === 'awaiting_approval' &&
            active.approval === undefined &&
            active.job.result === undefined ? (
              <TabConsent active={active} key={active.job.jobId} />
            ) : null}
          </>
        )}
        {execution.blockedReason === undefined ? null : (
          <p role="status">{execution.blockedReason}</p>
        )}
        {execution.delegationUnavailableReason === undefined ? null : (
          <p>Recovery requires Web Locks. Restore browser Web Locks support before recovering.</p>
        )}
        {affectedTabIds.length === 0 ? null : (
          <div className="grid min-w-0 gap-2">
            <p>Affected tabs</p>
            <ul aria-label="Affected tabs" className="grid gap-2">
              {affectedTabIds.map(tabId => {
                const tab = affectedTabs.isSuccess
                  ? affectedTabs.data.find(candidate => candidate.id === tabId)
                  : undefined;
                let closure = 'Closure unknown';
                if (affectedTabs.isSuccess) {
                  closure = tab === undefined ? 'Closed' : 'Open — close this tab before recovery.';
                }
                return (
                  <li className="rounded-md border border-border p-2" key={tabId}>
                    <p>
                      Tab ID {tabId}: {closure}
                    </p>
                    {tab?.title !== undefined && tab.title !== '' ? (
                      <p>Title: {tab.title}</p>
                    ) : null}
                    {tab?.url !== undefined && tab.url !== '' ? <p>Address: {tab.url}</p> : null}
                  </li>
                );
              })}
            </ul>
            {affectedTabs.isError ? (
              <p role="status">Could not retrieve affected tabs. Restore tab access and refresh.</p>
            ) : null}
            <button
              className={actionClass}
              disabled={affectedTabs.isFetching}
              onClick={() => {
                void affectedTabs.refetch();
              }}
              type="button"
            >
              Refresh affected tabs
            </button>
          </div>
        )}
        {queued.length === 0 ? (
          <p className="text-foreground-muted">Queue empty.</p>
        ) : (
          <div>
            <p aria-live="polite">Queued tasks: {queued.length}</p>
            <ul aria-label="Queued CLI tasks" className="grid gap-2">
              {queued.map(job => (
                <li className="rounded-md border border-border p-2" key={job.jobId}>
                  <p>Queue position: {job.queuePosition ?? 'Unknown'}</p>
                  <Owner label={job.ownerLabel} />
                  <p className="font-mono">Task ID: {job.jobId.slice(-8)}</p>
                  <Deadline job={job} />
                  <button
                    aria-label={`Cancel queued task ${job.jobId.slice(-8)}`}
                    className={`${actionClass} mt-2`}
                    onClick={() => {
                      task.cancel(job.jobId);
                      setNotice(
                        'Cancellation requested. Retrieve status to confirm the queued task outcome.'
                      );
                    }}
                    type="button"
                  >
                    Cancel queued task
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.result === undefined ? null : (
          <div>
            <p>
              Last outcome: {state.result.status} · {state.result.reason}
            </p>
            <p>{state.result.summary}</p>
            <p>
              {state.result.effectsUncertain
                ? 'Effects are uncertain. Close affected tabs before explicit recovery.'
                : 'No uncertain effects reported.'}
            </p>
            {state.result.evidence.length === 0 ? (
              <p>No observed evidence.</p>
            ) : (
              <div>
                <p>Observed evidence:</p>
                <p className="whitespace-pre-wrap">
                  {state.result.evidence
                    .map(item => [item.title, item.url, item.text].filter(Boolean).join('\n'))
                    .join('\n\n')}
                </p>
              </div>
            )}
          </div>
        )}
        {initializationFailed || ownershipRejected ? (
          <div className="grid gap-2">
            <p role="status">
              {ownershipRejected
                ? 'Close the panel that held ownership, if it is still open. Then reload this panel to retry ownership.'
                : 'Restore storage access, then reload this panel to retry initialization.'}{' '}
              Reload preserves your account, saved settings, and safety records. It does not enable
              CLI tasks, clear quarantine, approve execution, or resubmit work.
            </p>
            {reloadBlocked ? (
              <p role="status">Stop browser work and wait for cleanup before reloading.</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                className={actionClass}
                disabled={reloadBlocked}
                onClick={() => {
                  globalThis.location.reload();
                }}
                type="button"
              >
                Reload panel
              </button>
            </div>
          </div>
        ) : null}
        {state.profile === undefined ? null : (
          <div className="flex flex-wrap gap-2">
            <button
              className={actionClass}
              disabled={pending !== undefined}
              onClick={() => {
                void perform('Retrieving status...', async () => {
                  await task.refreshStatus();
                  setNotice('Status retrieved. This does not approve execution or resubmit work.');
                });
              }}
              type="button"
            >
              Refresh status
            </button>
            {state.retryable &&
            state.phase !== 'idle' &&
            state.phase !== 'running' &&
            state.phase !== 'awaiting_approval' ? (
              <button
                className={actionClass}
                onClick={() => {
                  task.retryConnection();
                }}
                type="button"
              >
                Reconnect
              </button>
            ) : null}
            {recoverable ? (
              <button
                className={actionClass}
                disabled={pending !== undefined}
                onClick={() => {
                  void perform('Checking recovery readiness...', async () => {
                    const value = await task.prepareRecovery();
                    setReadiness({ snapshot: task.getSnapshot(), value });
                  });
                }}
                type="button"
              >
                Check recovery readiness
              </button>
            ) : null}
            {recoverable && readiness?.value.ready === true && readiness.snapshot === state ? (
              <button
                className={actionClass}
                disabled={pending !== undefined}
                onClick={() => {
                  void perform('Recovering browser control...', task.recover);
                }}
                type="button"
              >
                Recover browser control
              </button>
            ) : null}
          </div>
        )}
        {readiness === undefined ? null : (
          <p role="status">
            {readiness.value.ready && readiness.snapshot !== state
              ? 'Provider state changed. Check recovery readiness again.'
              : readiness.value.reason}
          </p>
        )}
        {recoverable && !initializationFailed && !ownershipRejected ? (
          <p>
            Retrieve status first. Close affected tabs and drain execution locks before recovery.
            Recovery never resumes old work. A new invocation requires fresh tab consent.
            {state.settings?.enabled === false ? ' Local recovery keeps CLI tasks disabled.' : null}
          </p>
        ) : null}
        <p
          className={pending === undefined && notice === undefined ? 'sr-only' : undefined}
          role="status"
        >
          {pending ?? notice}
        </p>
      </div>
    </section>
  );
};

const BrowserTaskSettingsContext = createContext<
  | {
      saving: boolean;
      update: (change: Partial<BrowserProviderSettings>) => void;
    }
  | undefined
>(undefined);

export const BrowserTaskSettings = ({
  auth,
  organizationId,
}: {
  auth: StoredAuth;
  organizationId: string | undefined;
}): JSX.Element => {
  const task = useBrowserTask();
  const { settings, profile } = task.state;
  const models = useGatewayModels({ auth, organizationId });
  const tabs = useTabDebugger();
  const mutation = useContext(BrowserTaskSettingsContext);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const thinkingOptions =
    models.modelOptions.find(option => option.id === settings?.model)?.variants ??
    emptyThinkingOptions;
  if (mutation === undefined) {
    throw new Error('BrowserTaskSurface is required.');
  }
  const { saving, update } = mutation;
  return (
    <section
      aria-label="CLI task settings"
      className="type-label grid min-w-0 gap-3 rounded-xl border border-border bg-surface-raised p-3 [overflow-wrap:anywhere] [&>div>div]:flex-wrap"
    >
      <SettingsToggle
        checked={settings?.enabled === true}
        description="Off by default. CLI tasks are available only while this signed-in panel stays open."
        disabled={settings === undefined || saving || (!settings.enabled && settings.model === '')}
        label="CLI tasks"
        onToggle={() => {
          if (settings?.enabled === true) {
            setConfirmDisable(true);
          } else {
            update({ enabled: true });
          }
        }}
      />
      <p>Profile: {profile?.label ?? 'Unknown'}</p>
      <p>
        Provider ID: <span className="font-mono">{profile?.providerId ?? 'Unknown'}</span>
      </p>
      <p>
        Select the delegated model and mode explicitly. These defaults apply at the next tab
        approval; approved settings remain frozen.
      </p>
      {settings?.model === '' ? <p>Select a model before enabling CLI tasks.</p> : null}
      <AgentFooterControls
        auth={auth}
        inspectableTabs={tabs.inspectableTabs}
        isConversationStoreLoaded={settings !== undefined}
        isLoadingTabs={tabs.isLoadingTabs}
        isModelSelectDisabled={saving || models.modelOptions.length === 0}
        isRunning={saving}
        isThinkingSelectDisabled={saving || thinkingOptions.length === 0}
        mode={settings?.mode ?? 'safe'}
        model={settings?.model ?? ''}
        modelLoadError={models.modelLoadError}
        modelOptions={models.modelOptions}
        onModeChange={mode => {
          update({ mode });
        }}
        onModelChange={model => {
          update({ model, thinkingEffort: '' });
        }}
        onRetryModels={async () => {
          await models.refetchModels();
        }}
        onSelectedTabChange={tabId => {
          tabs.selectTab(tabId);
        }}
        onThinkingEffortChange={thinkingEffort => {
          update({ thinkingEffort });
        }}
        organizationId={organizationId}
        selectedTabId={tabs.selectedTabId}
        tabDebuggerError={tabs.tabDebuggerError}
        thinkingEffort={settings?.thinkingEffort ?? ''}
        thinkingOptions={thinkingOptions}
      />
      <p>
        The Target tab selector does not grant consent. Each CLI invocation needs its own Approve
        tab action.
      </p>
      {saving ? <p role="status">Saving CLI task settings...</p> : null}
      {confirmDisable ? (
        <div aria-label="Confirm CLI task disablement" className="grid gap-2" role="group">
          <p>
            Disabling CLI tasks terminates active and queued jobs. Issued actions are not undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={actionClass}
              disabled={saving}
              onClick={() => {
                setConfirmDisable(false);
                update({ enabled: false });
              }}
              type="button"
            >
              Disable CLI tasks
            </button>
            <button
              className={actionClass}
              disabled={saving}
              onClick={() => {
                setConfirmDisable(false);
              }}
              type="button"
            >
              Keep enabled
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
};

const supervision = <BrowserTaskControls />;
const focusableSelector =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Existing cards use role=dialog. Keep their controls inside the same focus boundary as supervision. */
export const BrowserTaskSurface = ({ children }: { children: ReactNode }): JSX.Element => {
  const { getSnapshot, setSettings } = useBrowserTask();
  const pendingSettings = useRef<{ write: typeof setSettings } | null>(null);
  const [settingsSave, setSettingsSave] = useState(pendingSettings.current);
  // The setter identifies its runtime; closing an overlay must not release its pending write.
  const settingsMutation = useMemo(
    () => ({
      saving: settingsSave?.write === setSettings,
      update: (change: Partial<BrowserProviderSettings>): void => {
        const { settings } = getSnapshot();
        if (settings === undefined || pendingSettings.current?.write === setSettings) {
          return;
        }
        const request = { write: setSettings };
        pendingSettings.current = request;
        setSettingsSave(request);
        void (async () => {
          try {
            await setSettings({ ...settings, ...change });
          } finally {
            if (pendingSettings.current === request) {
              pendingSettings.current = null;
              setSettingsSave(null);
            }
          }
        })();
      },
    }),
    [getSnapshot, setSettings, settingsSave]
  );
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const { current: root } = rootRef;
    if (root === null) {
      return;
    }
    const returnFocus = new Map<HTMLElement, HTMLElement | null>();
    let active: HTMLElement | null = null;
    let lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = (dialog: HTMLElement): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        element => !element.closest('[hidden], [inert]')
      );
    const synchronize = (): void => {
      const dialogs = [...root.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
      // Settings can cover an older card; a nested model/workflow overlay wins equal layers.
      const next =
        dialogs
          .toSorted(
            (left, right) =>
              (Number(getComputedStyle(left).zIndex) || 0) -
              (Number(getComputedStyle(right).zIndex) || 0)
          )
          .at(-1) ?? null;
      const previous = active === null ? undefined : returnFocus.get(active);
      if (next !== active) {
        if (next !== null && !returnFocus.has(next)) {
          const currentFocus =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          returnFocus.set(next, next.contains(currentFocus) ? lastFocused : currentFocus);
        }
        for (const dialog of returnFocus.keys()) {
          if (!root.contains(dialog)) {
            returnFocus.delete(dialog);
          }
        }
        active = next;
        if (
          previous !== document.body &&
          previous?.isConnected === true &&
          (next === null || next.contains(previous))
        ) {
          previous.focus();
        } else if (next === null) {
          // Async cards can outlive their approval trigger. Restore a stable supervision control.
          const fallback =
            root.querySelector<HTMLElement>('button[aria-label="Stop CLI task"]') ??
            root.querySelector<HTMLElement>('button[role="tab"][aria-selected="true"]') ??
            root.querySelector<HTMLElement>(focusableSelector);
          fallback?.focus();
        }
      }
      if (next !== null && !next.contains(document.activeElement)) {
        focusable(next)[0]?.focus();
      }
      lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || active === null) {
        return;
      }
      const elements = focusable(active);
      const index =
        document.activeElement instanceof HTMLElement
          ? elements.indexOf(document.activeElement)
          : -1;
      const next =
        elements[(index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length];
      event.preventDefault();
      next?.focus();
    };
    const observer = new MutationObserver(synchronize);
    observer.observe(root, { attributeFilter: ['disabled'], childList: true, subtree: true });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', synchronize);
    synchronize();
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', synchronize);
      const previous = active === null ? undefined : returnFocus.get(active);
      if (previous?.isConnected === true) {
        previous.focus();
      }
    };
  }, []);
  return (
    <BrowserTaskSettingsContext value={settingsMutation}>
      <BrowserTaskSupervisionContext.Provider value={supervision}>
        <div
          className="contents [&_[role=dialog]>div:has(>[data-browser-task-supervision])]:max-h-full [&_[role=dialog]>div:has(>[data-browser-task-supervision])]:overflow-y-auto"
          ref={rootRef}
        >
          {children}
        </div>
      </BrowserTaskSupervisionContext.Provider>
    </BrowserTaskSettingsContext>
  );
};
