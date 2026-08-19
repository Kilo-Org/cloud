import { storage } from '#imports';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { loadWebMcpSettings, saveWebMcpSettings } from '@/src/shared/web-mcp-settings';
import { SettingsToggle } from './workflow-settings';

const LOAD_ERROR_MESSAGE = "Couldn't load the setting. Try again.";
const SAVE_ERROR_MESSAGE = "Couldn't save the setting. Try again.";
const LABEL = 'Allow WebMCP in safe mode';
const DESCRIPTION = 'Dangerous mode enables page tools without this setting.';

const secondaryButtonClass =
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background';

export const WebMcpSettings = (): JSX.Element => {
  /* Undefined until the setting is read: the toggle stays disabled, so a failed
     read never presents the default as the stored value. */
  const [allowWebMcpInSafeMode, setAllowWebMcpInSafeMode] = useState<boolean | undefined>();
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErrorValue, setSaveErrorValue] = useState<boolean | undefined>();

  const loadSettings = useCallback(async () => {
    setLoadError(false);
    setSaveErrorValue(undefined);
    try {
      const settings = await loadWebMcpSettings(storage);
      setAllowWebMcpInSafeMode(settings.allowWebMcpInSafeMode);
    } catch {
      /* Keep the toggle disabled and surface the failure instead of silently
         presenting the default as the loaded setting. */
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const persistSettings = useCallback(async (next: boolean, prior: boolean) => {
    setSaveErrorValue(undefined);
    setSaving(true);
    setAllowWebMcpInSafeMode(next);

    try {
      await saveWebMcpSettings(storage, { allowWebMcpInSafeMode: next });
    } catch {
      /* Keep the prior value visible and surface the failure so the user can
         retry saving the intended value. */
      setAllowWebMcpInSafeMode(prior);
      setSaveErrorValue(next);
    } finally {
      setSaving(false);
    }
  }, []);

  const onToggle = useCallback(() => {
    if (allowWebMcpInSafeMode === undefined || saving) {
      return;
    }
    const prior = allowWebMcpInSafeMode;
    void persistSettings(!prior, prior);
  }, [allowWebMcpInSafeMode, persistSettings, saving]);

  const retrySave = useCallback(() => {
    if (saveErrorValue === undefined || saving || allowWebMcpInSafeMode === undefined) {
      return;
    }
    // The toggle still holds the value rolled back after the failed save.
    void persistSettings(saveErrorValue, allowWebMcpInSafeMode);
  }, [allowWebMcpInSafeMode, persistSettings, saveErrorValue, saving]);

  return (
    <section
      aria-label="WebMCP"
      className="min-w-0 rounded-xl border border-border bg-surface-raised p-3"
    >
      <div className="flex flex-col gap-3">
        <SettingsToggle
          checked={allowWebMcpInSafeMode === true}
          description={DESCRIPTION}
          disabled={allowWebMcpInSafeMode === undefined || saving}
          label={LABEL}
          onToggle={onToggle}
        />

        {loadError ? (
          <div className="flex flex-col gap-2">
            <p className="type-body text-status-red-400">{LOAD_ERROR_MESSAGE}</p>
            <div className="flex justify-end">
              <button
                aria-label="Retry loading WebMCP settings"
                className={secondaryButtonClass}
                onClick={() => {
                  void loadSettings();
                }}
                type="button"
              >
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {saveErrorValue === undefined ? null : (
          <div className="flex flex-col gap-2">
            <p className="type-body text-status-red-400">{SAVE_ERROR_MESSAGE}</p>
            <div className="flex justify-end">
              <button
                aria-label="Retry saving WebMCP settings"
                className={secondaryButtonClass}
                onClick={retrySave}
                type="button"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
