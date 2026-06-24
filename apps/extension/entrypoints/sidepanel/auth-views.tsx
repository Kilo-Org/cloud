import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { StoredAuth } from '@/src/shared/auth';
import { AgentChatPanel } from './agent-chat-panel';
import { Shell } from './auth-shell';
import { useOrganizationCreditAccount } from './organization-credit-account';

export const LoadingView = (): JSX.Element => (
  <Shell>
    <div className="flex flex-1 items-center justify-center px-4 py-6">
      <p className="text-sm text-zinc-400">Checking session...</p>
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
        <p className="text-base font-semibold text-zinc-50">Sign in to continue</p>
        <p className="text-sm leading-5 text-zinc-400">
          Use your Kilo account to unlock extension tools.
        </p>
      </div>

      {message === undefined ? null : (
        <p className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-sm leading-5 text-zinc-300">
          {message}
        </p>
      )}

      <button
        className="h-10 rounded-md bg-[#EDFF00] px-4 text-sm font-semibold text-zinc-950 transition hover:bg-[#d9ea00] focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
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
        <p className="text-base font-semibold text-zinc-50">Complete sign in</p>
        <p className="text-sm leading-5 text-zinc-400">Approve this code in the browser window.</p>
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-4 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">Code</p>
        <p className="mt-2 font-mono text-2xl font-semibold tracking-[0.18em] text-zinc-50">
          {code}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          className="h-9 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
          onClick={onOpen}
          type="button"
        >
          Open
        </button>
        <button
          className="h-9 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
          onClick={onCancel}
          type="button"
        >
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
        <p className="text-base font-semibold text-zinc-50">Session check failed</p>
        <p className="text-sm leading-5 text-zinc-400">
          Kilo could not validate your saved session.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          className="h-9 rounded-md bg-[#EDFF00] px-3 text-sm font-semibold text-zinc-950 transition hover:bg-[#d9ea00] focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
        <button
          className="h-9 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
          onClick={onSignInAgain}
          type="button"
        >
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
  const { organizationOptions, selectOrganization, selectedOrganizationId } =
    useOrganizationCreditAccount(auth.token);

  return (
    <Shell
      auth={auth}
      headerBeforeSettings={headerBeforeSettings}
      onOrganizationChange={selectOrganization}
      onSignOut={onSignOut}
      organizationOptions={organizationOptions}
      selectedOrganizationId={selectedOrganizationId}
    >
      <AgentChatPanel
        auth={auth}
        onHeaderBeforeSettingsChange={setHeaderBeforeSettings}
        organizationId={selectedOrganizationId === '' ? undefined : selectedOrganizationId}
      />
    </Shell>
  );
};
