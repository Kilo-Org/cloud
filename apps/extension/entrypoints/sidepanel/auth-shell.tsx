import { useAtom } from 'jotai';
import type { JSX, ReactNode } from 'react';
import { Settings, X } from 'lucide-react';
import type { StoredAuth } from '@/src/shared/auth';
import type { KiloOrganizationOption } from '@/src/shared/kilo-api-client';
import { KiloLogo } from '@/src/shared/kilo-logo';
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
