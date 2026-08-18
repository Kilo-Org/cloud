import { storage } from '#imports';
import { Trash2 } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { deleteAgentMemory } from '@/src/shared/agent-memories-storage';
import { loadMemorySettings, saveMemorySettings } from '@/src/shared/agent-memory-settings';
import { deriveMemoriesSettingsView } from './memory-settings-state';
import { useAgentMemories } from './use-agent-memories';
import { SettingsToggle } from './workflow-settings';

const EMPTY_MESSAGE =
  'No memories yet. Highlight text on any page, right-click, and choose Add to memory.';
const LOAD_ERROR_MESSAGE = "Couldn't load memories. Try again.";
const SETTINGS_SAVE_ERROR_MESSAGE = "Couldn't save the setting. Try again.";
const AUTO_APPROVE_LABEL = 'Auto-approve memory saves';
const AUTO_APPROVE_DESCRIPTION = 'Let Kilo save a memory without the approval card.';

const secondaryButtonClass =
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

export const MemorySettings = (): JSX.Element => {
  const { isLoaded, loadError, memories, reload } = useAgentMemories();
  const view = deriveMemoriesSettingsView({ isLoaded, loadError, memories });

  /* Undefined until the setting is read: the toggle stays disabled, so a failed
     read never presents the default as the stored value. */
  const [autoApprove, setAutoApprove] = useState<boolean | undefined>();
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const settings = await loadMemorySettings(storage);
        setAutoApprove(settings.autoApproveMemorySaves);
      } catch {
        /* Leave the toggle disabled and unchecked. */
      }
    })();
  }, []);

  const onToggle = useCallback(() => {
    if (autoApprove === undefined) {
      return;
    }
    const next = !autoApprove;
    setSaveError(false);
    setAutoApprove(next);
    void (async () => {
      try {
        await saveMemorySettings(storage, { autoApproveMemorySaves: next });
      } catch {
        /* Keep the stored value visible; toggling again retries the save. */
        setAutoApprove(!next);
        setSaveError(true);
      }
    })();
  }, [autoApprove]);

  return (
    <section
      aria-label="Memories"
      className="min-w-0 rounded-xl border border-border bg-surface-raised p-3"
    >
      <h2 className="type-label text-foreground-muted">Memories</h2>

      <div className="mt-2 flex flex-col gap-2">
        <SettingsToggle
          checked={autoApprove === true}
          description={AUTO_APPROVE_DESCRIPTION}
          disabled={autoApprove === undefined}
          label={AUTO_APPROVE_LABEL}
          onToggle={onToggle}
        />
        {saveError ? (
          <p className="type-body text-status-red-400">{SETTINGS_SAVE_ERROR_MESSAGE}</p>
        ) : null}
      </div>

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
            <li
              className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-surface-background p-2"
              key={item.id}
            >
              <div className="min-w-0 flex-1">
                <p className="type-body truncate font-medium text-foreground" title={item.preview}>
                  {item.preview}
                </p>
                <p className="type-label mt-0.5 text-foreground-muted">
                  {item.domain === undefined
                    ? item.dateLabel
                    : `${item.domain} · ${item.dateLabel}`}
                </p>
              </div>
              <button
                aria-label={item.deleteAriaLabel}
                className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition hover:border-status-red-500/50 hover:bg-status-red-500/10 hover:text-status-red-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
                onClick={() => {
                  void deleteAgentMemory(storage, item.id);
                }}
                type="button"
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
