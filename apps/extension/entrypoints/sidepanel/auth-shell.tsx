import { useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { Settings, X } from 'lucide-react';
import type { StoredAuth } from '@/src/shared/auth';
import type { KiloOrganizationOption } from '@/src/shared/kilo-api-client';
import { KiloLogo } from '@/src/shared/kilo-logo';
import { OrganizationCreditAccountSelect } from './organization-credit-account';
import { RemoteMcpSettings } from './remote-mcp-settings';

const emptyOrganizationOptions: KiloOrganizationOption[] = [];

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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

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
          className="fixed inset-0 z-30 flex flex-col bg-zinc-950"
          role="dialog"
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
            <p className="text-sm font-semibold text-zinc-100">Settings</p>
            <button
              aria-label="Close settings"
              className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
              onClick={() => {
                setIsSettingsOpen(false);
              }}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          <div className="agent-conversation-scrollbar grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 py-4">
            <div className="min-w-0 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
              <p className="text-xs font-medium text-zinc-500">Signed in</p>
              <p className="mt-1 truncate text-sm text-zinc-200">{auth.userEmail ?? 'Kilo user'}</p>
            </div>
            <OrganizationCreditAccountSelect
              onChange={onOrganizationChange}
              organizationOptions={organizationOptions}
              selectedOrganizationId={selectedOrganizationId}
            />
            <RemoteMcpSettings />
            <button
              className="h-9 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
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
  <div className="border-b border-zinc-800 px-4 py-3">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <KiloLogo className="size-8 shrink-0 text-[#EDFF00]" />
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
  <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-50">
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
