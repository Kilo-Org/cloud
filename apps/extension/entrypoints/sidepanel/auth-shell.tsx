import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { StoredAuth } from '@/src/shared/auth';
import type { KiloOrganizationOption } from '@/src/shared/kilo-api-client';
import { KiloLogo } from '@/src/shared/kilo-logo';
import { OrganizationCreditAccountSelect } from './organization-credit-account';

const emptyOrganizationOptions: KiloOrganizationOption[] = [];

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
  onOrganizationChange,
  onSignOut,
  organizationOptions,
  selectedOrganizationId,
}: {
  auth: StoredAuth;
  onNewConversation: () => void;
  onOrganizationChange: (organizationId: string) => void;
  onSignOut: () => void;
  organizationOptions: KiloOrganizationOption[];
  selectedOrganizationId: string;
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
          <OrganizationCreditAccountSelect
            onChange={onOrganizationChange}
            organizationOptions={organizationOptions}
            selectedOrganizationId={selectedOrganizationId}
          />
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
  onOrganizationChange,
  onSignOut,
  organizationOptions = emptyOrganizationOptions,
  selectedOrganizationId = '',
}: {
  auth?: StoredAuth | undefined;
  onNewConversation?: (() => void) | undefined;
  onOrganizationChange?: ((organizationId: string) => void) | undefined;
  onSignOut?: (() => void) | undefined;
  organizationOptions?: KiloOrganizationOption[] | undefined;
  selectedOrganizationId?: string | undefined;
}): JSX.Element => (
  <div className="border-b border-zinc-800 px-4 py-3">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <KiloLogo className="size-8 shrink-0 text-[#EDFF00]" />
      <span className="sr-only">Kilo</span>
      {auth === undefined ||
      onNewConversation === undefined ||
      onOrganizationChange === undefined ||
      onSignOut === undefined ? null : (
        <HeaderActions
          auth={auth}
          onNewConversation={onNewConversation}
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
  onNewConversation,
  onOrganizationChange,
  onSignOut,
  organizationOptions = emptyOrganizationOptions,
  selectedOrganizationId = '',
}: {
  auth?: StoredAuth | undefined;
  children: ReactNode;
  onNewConversation?: (() => void) | undefined;
  onOrganizationChange?: ((organizationId: string) => void) | undefined;
  onSignOut?: (() => void) | undefined;
  organizationOptions?: KiloOrganizationOption[] | undefined;
  selectedOrganizationId?: string | undefined;
}): JSX.Element => (
  <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-50">
    <Header
      auth={auth}
      onNewConversation={onNewConversation}
      onOrganizationChange={onOrganizationChange}
      onSignOut={onSignOut}
      organizationOptions={organizationOptions}
      selectedOrganizationId={selectedOrganizationId}
    />
    {children}
  </main>
);
