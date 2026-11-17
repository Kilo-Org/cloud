import { browser, storage } from '#imports';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LOCAL_AGENTS_COMMAND_MESSAGE } from '@/src/shared/local-agents/commands';
import {
  LOCAL_AGENT_CONTROLLERS_STORAGE_KEY,
  loadLocalAgentConnectedAgents,
} from '@/src/shared/local-agents/registry';
import type { LocalAgentConnectedAgent } from '@/src/shared/local-agents/registry';
import {
  LOCAL_AGENT_SETTINGS_STORAGE_KEY,
  loadLocalAgentSettings,
  saveLocalAgentSettings,
} from '@/src/shared/local-agents/settings';
import {
  LOCAL_AGENT_STATUS_STORAGE_KEY,
  loadLocalAgentStatus,
} from '@/src/shared/local-agents/status';
import type { LocalAgentEndpointStatus } from '@/src/shared/local-agents/status';
import { deriveLocalAgentsSettingsView } from './local-agents-settings-state';
import { createSerialAsyncChain } from './model-preferences-state';
import { SettingsToggle } from './workflow-settings';

const SWITCH_LABEL = 'Allow local agents';
const SWITCH_DESCRIPTION =
  'Let Kilo CLI agents control this browser. Everything stays on this machine.';
const HOST_MISSING_HINT = 'Kilo CLI not found. Run any Kilo CLI command once.';
const WAITING_HINT = 'Waiting for a Kilo CLI…';
const IDLE_HINT = 'No agents connected.';
const LOAD_ERROR_MESSAGE = "Couldn't load local agents. Try again.";
const SAVE_ERROR_MESSAGE = "Couldn't save the setting. Try again.";
const STOP_ALL_LABEL = 'Stop all';
const DISCONNECT_LABEL = 'Disconnect';

const secondaryButtonClass =
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

/**
 * Requests the optional nativeMessaging permission from the toggle's own user
 * gesture. A refusal is not an error: the native endpoint reports
 * `host_missing` and the loopback endpoint still works.
 */
const requestNativeMessagingPermission = async (): Promise<void> => {
  try {
    await browser.permissions.request({ permissions: ['nativeMessaging'] });
  } catch {
    // Denied or unsupported; the transport reports the state.
  }
};

const sendLocalAgentCommand = async (
  command: { kind: 'stop_all' } | { controllerId: string; kind: 'disconnect' }
): Promise<void> => {
  await browser.runtime.sendMessage({ ...command, type: LOCAL_AGENTS_COMMAND_MESSAGE });
};

export const LocalAgentsSettings = (): JSX.Element => {
  const [enabled, setEnabled] = useState<boolean | undefined>();
  const [agents, setAgents] = useState<LocalAgentConnectedAgent[]>([]);
  const [status, setStatus] = useState<LocalAgentEndpointStatus[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const saveChainRef = useRef(createSerialAsyncChain());

  const refresh = useCallback(async () => {
    try {
      const [settings, nextAgents, nextStatus] = await Promise.all([
        loadLocalAgentSettings(storage),
        loadLocalAgentConnectedAgents(storage),
        loadLocalAgentStatus(storage),
      ]);

      setEnabled(settings.enabled);
      setAgents(nextAgents);
      setStatus(nextStatus);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();

    const unwatchSettings = storage.watch(LOCAL_AGENT_SETTINGS_STORAGE_KEY, () => {
      void refresh();
    });
    const unwatchControllers = storage.watch(LOCAL_AGENT_CONTROLLERS_STORAGE_KEY, () => {
      void refresh();
    });
    const unwatchStatus = storage.watch(LOCAL_AGENT_STATUS_STORAGE_KEY, () => {
      void refresh();
    });

    return () => {
      unwatchSettings();
      unwatchControllers();
      unwatchStatus();
    };
  }, [refresh]);

  const onToggle = useCallback(() => {
    if (enabled === undefined) {
      return;
    }

    const next = !enabled;
    setEnabled(next);
    setSaveError(false);

    if (next) {
      void requestNativeMessagingPermission();
    }

    // Rapid toggles each write the whole record; one chain keeps the last click authoritative.
    void saveChainRef.current.enqueue(async () => {
      try {
        await saveLocalAgentSettings(storage, { enabled: next });
      } catch {
        setEnabled(!next);
        setSaveError(true);
      }
    });
  }, [enabled]);

  const onCommand = useCallback(
    (command: { kind: 'stop_all' } | { controllerId: string; kind: 'disconnect' }) => {
      setSaveError(false);
      void (async (): Promise<void> => {
        try {
          await sendLocalAgentCommand(command);
        } catch {
          setSaveError(true);
        }
      })();
    },
    []
  );

  const view = deriveLocalAgentsSettingsView({ agents, enabled, status });

  return (
    <section
      aria-label="Local agents"
      className="min-w-0 rounded-xl border border-border bg-surface-raised p-3"
    >
      <h2 className="type-label text-foreground-muted">Local agents</h2>

      <div className="mt-2 flex flex-col gap-2">
        <SettingsToggle
          checked={enabled === true}
          description={SWITCH_DESCRIPTION}
          disabled={enabled === undefined}
          label={SWITCH_LABEL}
          onToggle={onToggle}
        />
        {saveError ? <p className="type-body text-status-red-400">{SAVE_ERROR_MESSAGE}</p> : null}
      </div>

      {loadError ? (
        <p className="type-body mt-2 text-status-red-400">{LOAD_ERROR_MESSAGE}</p>
      ) : null}

      {view.emptyState === 'host_missing' ? (
        <p className="type-body mt-2 text-foreground-muted">{HOST_MISSING_HINT}</p>
      ) : null}

      {view.emptyState === 'waiting' ? (
        <p className="type-body mt-2 text-foreground-muted">{WAITING_HINT}</p>
      ) : null}

      {view.emptyState === 'idle' ? (
        <p className="type-body mt-2 text-foreground-muted">{IDLE_HINT}</p>
      ) : null}

      {view.controllerGroups.length > 0 ? (
        <>
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="type-label text-foreground-muted">Connected agents</p>
            <button
              className={secondaryButtonClass}
              onClick={() => {
                onCommand({ kind: 'stop_all' });
              }}
              type="button"
            >
              {STOP_ALL_LABEL}
            </button>
          </div>
          <ul className="mt-2 flex flex-col gap-2">
            {view.controllerGroups.map(group => (
              <li
                className="min-w-0 rounded-md border border-border bg-surface-background p-2"
                key={group.controllerId}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="type-label truncate text-foreground" title={group.controllerId}>
                      {group.controllerId.slice(0, 8)}
                    </p>
                    <p className="type-body text-foreground-muted">{group.transport}</p>
                  </div>
                  <button
                    aria-label={`${DISCONNECT_LABEL} ${group.controllerId.slice(0, 8)}`}
                    className={secondaryButtonClass}
                    onClick={() => {
                      onCommand({ controllerId: group.controllerId, kind: 'disconnect' });
                    }}
                    type="button"
                  >
                    {DISCONNECT_LABEL}
                  </button>
                </div>
                <ul className="mt-2 flex flex-col gap-1">
                  {group.agents.map(agent => (
                    <li className="min-w-0" key={agent.sessionHandle}>
                      <p className="type-body truncate text-foreground">
                        {agent.title === '' ? agent.sessionId : agent.title}
                      </p>
                      <p className="type-label truncate text-foreground-muted" title={agent.cwd}>
                        {agent.cwd}
                      </p>
                      <p className="type-label text-foreground-muted">CLI {agent.cliVersion}</p>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
};
