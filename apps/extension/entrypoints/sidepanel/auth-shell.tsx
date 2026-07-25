/* eslint-disable import/max-dependencies */
import { storage } from '#imports';
import { useAtom } from 'jotai';
import { useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Settings, X } from 'lucide-react';
import {
  getFirefoxUsageDataGranted,
  loadAnalyticsOptOut,
  setAnalyticsOptOut,
} from '@/src/shared/analytics';
import type { StoredAuth } from '@/src/shared/auth';
import type { KiloOrganizationOption } from '@/src/shared/kilo-api-client';
import { KiloLogo } from '@/src/shared/kilo-logo';
import type { AnalyticsSettingsState } from './analytics-settings-logic';
import {
  FIREFOX_USAGE_DATA_BLOCKED_HINT,
  applyAnalyticsSettingsLoaded,
  beginAnalyticsSettingsFlip,
  completeAnalyticsSettingsFlip,
  createInitialAnalyticsSettingsState,
  failAnalyticsSettingsFlip,
  isAnalyticsSettingsInteractive,
  resolveAnalyticsOptOutIdentity,
  shouldShowFirefoxUsageDataHint,
} from './analytics-settings-logic';
import { MemorySettings } from './memory-settings';
import { OrganizationCreditAccountSelect } from './organization-credit-account';
import { RemoteMcpSettings } from './remote-mcp-settings';
import { settingsDialogOpenAtom } from './settings-dialog-state';

const emptyOrganizationOptions: KiloOrganizationOption[] = [];

const iconButtonClassName =
  'flex size-8 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background';

const IconButton = ({
  ariaLabel,
  children,
  onClick,
}: {
  ariaLabel: string;
  children: ReactNode;
  onClick: () => void;
}): JSX.Element => (
  <button aria-label={ariaLabel} className={iconButtonClassName} onClick={onClick} type="button">
    {children}
  </button>
);

const AnalyticsSettingsRow = ({ userEmail }: { userEmail: string | undefined }): JSX.Element => {
  const [state, setState] = useState<AnalyticsSettingsState>(createInitialAnalyticsSettingsState);
  const interactive = isAnalyticsSettingsInteractive(state);
  const showFirefoxHint = shouldShowFirefoxUsageDataHint(state.firefoxUsageDataGranted);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [optedOut, firefoxUsageDataGranted] = await Promise.all([
        loadAnalyticsOptOut(storage),
        getFirefoxUsageDataGranted(),
      ]);

      if (cancelled) {
        return;
      }

      setState(
        applyAnalyticsSettingsLoaded({
          firefoxUsageDataGranted,
          optedOut,
        })
      );
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = (): void => {
    const started = beginAnalyticsSettingsFlip(state);
    if (started === null) {
      return;
    }

    setState(started.state);

    void (async () => {
      try {
        await setAnalyticsOptOut(
          storage,
          started.optedOut,
          resolveAnalyticsOptOutIdentity(started.optedOut, userEmail)
        );
        setState(current => completeAnalyticsSettingsFlip(current));
      } catch {
        setState(current => failAnalyticsSettingsFlip(current, started.priorChecked));
      }
    })();
  };

  return (
    <div className="min-w-0 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-200">Share usage analytics</p>
          <p className="mt-0.5 text-xs leading-4 text-zinc-500">
            Helps improve Kilo. No page content is collected.
          </p>
          {showFirefoxHint ? (
            <p className="mt-1 text-xs leading-4 text-zinc-500">
              {FIREFOX_USAGE_DATA_BLOCKED_HINT}
            </p>
          ) : null}
          {state.errorMessage === null ? null : (
            <p className="mt-1 text-xs leading-4 text-red-400">{state.errorMessage}</p>
          )}
        </div>
        <button
          aria-checked={state.checked}
          aria-label="Share usage analytics"
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 ${
            state.checked ? 'border-[#EDFF00]/40 bg-[#EDFF00]/20' : 'border-zinc-700 bg-zinc-800'
          }`}
          disabled={!interactive}
          onClick={onToggle}
          role="switch"
          type="button"
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 size-3.5 rounded-full transition ${
              state.checked ? 'left-4 bg-[#EDFF00]' : 'left-0.5 bg-zinc-400'
            }`}
          />
        </button>
      </div>
    </div>
  );
};

const HeaderActions = ({
  auth,
  beforeSettings,
  onOrganizationChange,
  onSignOut,
  organizationOptions,
  selectedOrganizationId,
}: {
  auth: StoredAuth;
  beforeSettings?: ReactNode;
  onOrganizationChange: (organizationId: string) => void;
  onSignOut: () => void;
  organizationOptions: KiloOrganizationOption[];
  selectedOrganizationId: string;
}): JSX.Element => {
  const [isSettingsOpen, setIsSettingsOpen] = useAtom(settingsDialogOpenAtom);

  return (
    <div className="relative flex shrink-0 items-center justify-end gap-2">
      {beforeSettings}
      <IconButton
        ariaLabel="Settings"
        onClick={() => {
          setIsSettingsOpen(current => !current);
        }}
      >
        <Settings aria-hidden="true" className="size-4" />
      </IconButton>

      {isSettingsOpen ? (
        <div
          aria-label="Settings panel"
          aria-modal="true"
          className="fixed inset-0 z-30 flex flex-col bg-surface-background"
          role="dialog"
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-4">
            <p className="text-sm font-semibold text-foreground">Settings</p>
            <button
              aria-label="Close settings"
              className={iconButtonClassName}
              onClick={() => {
                setIsSettingsOpen(false);
              }}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          <div className="agent-conversation-scrollbar grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 py-4">
            <div className="min-w-0 rounded-xl border border-border bg-surface-raised p-3">
              <p className="type-label text-foreground-muted">Signed in</p>
              <p className="type-body mt-1 truncate text-foreground">
                {auth.userEmail ?? 'Kilo user'}
              </p>
            </div>
            <MemorySettings />
            <OrganizationCreditAccountSelect
              onChange={onOrganizationChange}
              organizationOptions={organizationOptions}
              selectedOrganizationId={selectedOrganizationId}
            />
            <RemoteMcpSettings />
            <AnalyticsSettingsRow userEmail={auth.userEmail} />
            <button
              className="type-label h-9 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background"
              onClick={() => {
                setIsSettingsOpen(false);
                onSignOut();
              }}
              type="button"
            >
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const Header = ({
  auth,
  headerBeforeSettings,
  onOrganizationChange,
  onSignOut,
  organizationOptions = emptyOrganizationOptions,
  selectedOrganizationId = '',
}: {
  auth?: StoredAuth | undefined;
  headerBeforeSettings?: ReactNode;
  onOrganizationChange?: ((organizationId: string) => void) | undefined;
  onSignOut?: (() => void) | undefined;
  organizationOptions?: KiloOrganizationOption[] | undefined;
  selectedOrganizationId?: string | undefined;
}): JSX.Element => (
  <div className="border-b border-border bg-surface-background px-4 py-3">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <KiloLogo className="size-8 shrink-0 text-brand-primary" />
      <span className="sr-only">Kilo</span>
      {auth === undefined ||
      onOrganizationChange === undefined ||
      onSignOut === undefined ? null : (
        <HeaderActions
          auth={auth}
          beforeSettings={headerBeforeSettings}
          onOrganizationChange={onOrganizationChange}
          onSignOut={onSignOut}
          organizationOptions={organizationOptions}
          selectedOrganizationId={selectedOrganizationId}
        />
      )}
    </div>
  </div>
);

export const Shell = ({
  auth,
  children,
  headerBeforeSettings,
  onOrganizationChange,
  onSignOut,
  organizationOptions = emptyOrganizationOptions,
  selectedOrganizationId = '',
}: {
  auth?: StoredAuth | undefined;
  children: ReactNode;
  headerBeforeSettings?: ReactNode;
  onOrganizationChange?: ((organizationId: string) => void) | undefined;
  onSignOut?: (() => void) | undefined;
  organizationOptions?: KiloOrganizationOption[] | undefined;
  selectedOrganizationId?: string | undefined;
}): JSX.Element => (
  <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-surface-background text-foreground">
    <Header
      auth={auth}
      headerBeforeSettings={headerBeforeSettings}
      onOrganizationChange={onOrganizationChange}
      onSignOut={onSignOut}
      organizationOptions={organizationOptions}
      selectedOrganizationId={selectedOrganizationId}
    />
    {children}
  </main>
);
