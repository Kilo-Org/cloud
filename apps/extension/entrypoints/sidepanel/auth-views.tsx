import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { StoredAuth } from '@/src/shared/auth';
import { KiloLogo } from '@/src/shared/kilo-logo';
import { AgentChatPanel } from './agent-chat-panel';

const NewConversationIcon = ({ className }: { className: string }): JSX.Element => (
  <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
    <path
      d="M8 3.25v9.5M3.25 8h9.5"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
  </svg>
);

const SettingsIcon = ({ className }: { className: string }): JSX.Element => (
  <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
    <path
      d="M6.9 2.15h2.2l.35 1.45c.36.13.7.32 1.01.57l1.42-.44 1.1 1.9-1.07 1.02a4 4 0 0 1 0 1.18l1.07 1.02-1.1 1.9-1.42-.44c-.31.25-.65.44-1.01.57l-.35 1.45H6.9l-.35-1.45a3.8 3.8 0 0 1-1.01-.57l-1.42.44-1.1-1.9 1.07-1.02a4 4 0 0 1 0-1.18L3.02 5.63l1.1-1.9 1.42.44c.31-.25.65-.44 1.01-.57l.35-1.45Z"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.2"
    />
    <path
      d="M8 6.1a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

const IconButton = ({
  ariaLabel,
  children,
  onClick,
}: {
  ariaLabel: string;
  children: ReactNode;
  onClick: () => void;
}): JSX.Element => (
  <button
    aria-label={ariaLabel}
    className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);

const HeaderActions = ({
  auth,
  onNewConversation,
  onSignOut,
}: {
  auth: StoredAuth;
  onNewConversation: () => void;
  onSignOut: () => void;
}): JSX.Element => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  return (
    <div className="relative flex shrink-0 items-center justify-end gap-2">
      <IconButton ariaLabel="New conversation" onClick={onNewConversation}>
        <NewConversationIcon className="size-4" />
      </IconButton>
      <IconButton
        ariaLabel="Settings"
        onClick={() => {
          setIsSettingsOpen(current => !current);
        }}
      >
        <SettingsIcon className="size-4" />
      </IconButton>

      {isSettingsOpen ? (
        <div className="absolute right-0 top-10 z-20 grid w-56 gap-3 rounded-md border border-zinc-800 bg-zinc-950 p-3 shadow-xl shadow-black/30">
          <div className="min-w-0">
            <p className="text-xs font-medium text-zinc-500">Signed in</p>
            <p className="mt-1 truncate text-sm text-zinc-200">{auth.userEmail ?? 'Kilo user'}</p>
          </div>
          <button
            className="h-8 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
            onClick={onSignOut}
            type="button"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
};

const Header = ({
  auth,
  onNewConversation,
  onSignOut,
}: {
  auth?: StoredAuth | undefined;
  onNewConversation?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
}): JSX.Element => (
  <div className="border-b border-zinc-800 px-4 py-3">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <KiloLogo className="size-8 shrink-0 text-[#EDFF00]" />
      <span className="sr-only">Kilo</span>
      {auth === undefined || onNewConversation === undefined || onSignOut === undefined ? null : (
        <HeaderActions auth={auth} onNewConversation={onNewConversation} onSignOut={onSignOut} />
      )}
    </div>
  </div>
);

const Shell = ({
  auth,
  children,
  onNewConversation,
  onSignOut,
}: {
  auth?: StoredAuth | undefined;
  children: ReactNode;
  onNewConversation?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
}): JSX.Element => (
  <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-50">
    <Header auth={auth} onNewConversation={onNewConversation} onSignOut={onSignOut} />
    {children}
  </main>
);

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
  const [conversationKey, setConversationKey] = useState(0);

  return (
    <Shell
      auth={auth}
      onNewConversation={() => {
        setConversationKey(current => current + 1);
      }}
      onSignOut={onSignOut}
    >
      <AgentChatPanel auth={auth} key={conversationKey} />
    </Shell>
  );
};
