/* eslint-disable import/max-dependencies */
import { storage } from '#imports';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { StoredAuth } from '@/src/shared/auth';
import { normalizeOrganizationId } from '@/src/shared/organization-normalization';
import { loadSidePanelMode, saveSidePanelMode } from '@/src/shared/side-panel-mode';
import type { SidePanelMode } from '@/src/shared/side-panel-mode';
import { AgentChatPanel } from './agent-chat-panel';
import { AgentsMode } from './agents-mode';
import { AgentsModeSwitch } from './agents-mode-switch';
import { ExtensionAgentsProvider } from './agents-provider';
import { Shell } from './auth-shell';
import { useOrganizationCreditAccount } from './organization-credit-account';
import { PendingMemorySaveCard } from './pending-memory-save-card';

const primaryAuthButtonClassName =
  'rounded-md bg-brand-primary type-label text-brand-primary-foreground transition hover:bg-brand-primary-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle';

const secondaryAuthButtonClassName =
  'h-9 rounded-md border border-border bg-surface-overlay px-3 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background';

export const LoadingView = (): JSX.Element => (
  <Shell>
    <div className="flex flex-1 items-center justify-center px-4 py-6">
      <p className="type-body text-foreground-muted">Checking session...</p>
    </div>
  </Shell>
);

export const SignedOutView = ({
  isStarting,
  message,
  onSignIn,
}: {
  isStarting: boolean;
  message: string | undefined;
  onSignIn: () => void;
}): JSX.Element => (
  <Shell>
    <div className="flex flex-1 flex-col justify-center gap-4 px-4 py-6">
      <div className="space-y-1">
        <p className="type-heading text-foreground">Sign in to continue</p>
        <p className="type-body text-foreground-muted">
          Use your Kilo account to unlock extension tools.
        </p>
      </div>

      {message === undefined ? null : (
        <p className="type-body rounded-xl border border-border bg-surface-raised p-3 text-foreground">
          {message}
        </p>
      )}

      <button
        className={`h-10 px-4 ${primaryAuthButtonClassName}`}
        disabled={isStarting}
        onClick={onSignIn}
        type="button"
      >
        {isStarting ? 'Starting sign in...' : 'Sign in'}
      </button>
    </div>
  </Shell>
);

export const PendingView = ({
  code,
  onCancel,
  onOpen,
}: {
  code: string;
  onCancel: () => void;
  onOpen: () => void;
}): JSX.Element => (
  <Shell>
    <div className="flex flex-1 flex-col justify-center gap-4 px-4 py-6">
      <div className="space-y-1">
        <p className="type-heading text-foreground">Complete sign in</p>
        <p className="type-body text-foreground-muted">Approve this code in the browser window.</p>
      </div>

      <div className="rounded-md border border-border bg-surface-inset p-4 text-center">
        <p className="type-eyebrow text-foreground-muted">Code</p>
        <p className="mt-2 font-mono text-2xl font-semibold tracking-[0.18em] text-foreground">
          {code}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button className={secondaryAuthButtonClassName} onClick={onOpen} type="button">
          Open
        </button>
        <button className={secondaryAuthButtonClassName} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </div>
  </Shell>
);

export const ValidationErrorView = ({
  onRetry,
  onSignInAgain,
}: {
  onRetry: () => void;
  onSignInAgain: () => void;
}): JSX.Element => (
  <Shell>
    <div className="flex flex-1 flex-col justify-center gap-4 px-4 py-6">
      <div className="space-y-1">
        <p className="type-heading text-foreground">Session check failed</p>
        <p className="type-body text-foreground-muted">
          Kilo could not validate your saved session.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          className={`h-9 px-3 ${primaryAuthButtonClassName}`}
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
        <button className={secondaryAuthButtonClassName} onClick={onSignInAgain} type="button">
          Sign in
        </button>
      </div>
    </div>
  </Shell>
);

export const SignedInView = ({
  auth,
  onSignOut,
}: {
  auth: StoredAuth;
  onSignOut: () => void;
}): JSX.Element => {
  const [headerBeforeSettings, setHeaderBeforeSettings] = useState<ReactNode>();
  const [mode, setMode] = useState<SidePanelMode>('browser');
  const userSelectedMode = useRef(false);
  const { organizationOptions, selectOrganization, selectedOrganizationId } =
    useOrganizationCreditAccount(auth.token);

  // Hydrate persisted panel mode on mount (async WXT storage).
  useEffect(() => {
    void (async () => {
      const persisted = await loadSidePanelMode(storage);
      if (!userSelectedMode.current) {
        setMode(persisted);
      }
    })();
  }, []);

  const handleModeChange = useCallback((nextMode: SidePanelMode) => {
    userSelectedMode.current = true;
    setMode(nextMode);
    void (async () => {
      try {
        await saveSidePanelMode(storage, nextMode);
      } catch {
        // Persistence is best-effort; mode is already applied locally.
      }
    })();
  }, []);

  const agentsOrgId = normalizeOrganizationId(selectedOrganizationId);

  return (
    <Shell
      auth={auth}
      headerBeforeSettings={headerBeforeSettings}
      onOrganizationChange={selectOrganization}
      onSignOut={onSignOut}
      organizationOptions={organizationOptions}
      selectedOrganizationId={selectedOrganizationId}
    >
      <AgentsModeSwitch mode={mode} onModeChange={handleModeChange} />
      {mode === 'browser' ? (
        <>
          <PendingMemorySaveCard />
          <AgentChatPanel
            auth={auth}
            onHeaderBeforeSettingsChange={setHeaderBeforeSettings}
            organizationId={selectedOrganizationId === '' ? undefined : selectedOrganizationId}
          />
        </>
      ) : (
        <ExtensionAgentsProvider
          auth={auth}
          key={`${auth.token}:${selectedOrganizationId}`}
          organizationId={agentsOrgId}
        >
          <AgentsMode />
        </ExtensionAgentsProvider>
      )}
    </Shell>
  );
};
