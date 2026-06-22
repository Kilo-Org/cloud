import type { ChangeEvent, JSX, ReactNode } from 'react';
import type { StoredAuth } from '@/src/shared/auth';
import { KiloLogo } from '@/src/shared/kilo-logo';
import type { InspectableTab } from '@/src/shared/tab-debugger';

const HeaderAccountControls = ({
  auth,
  onSignOut,
}: {
  auth: StoredAuth;
  onSignOut: () => void;
}): JSX.Element => (
  <div className="flex min-w-0 items-center justify-end gap-2">
    {auth.userEmail === undefined ? null : (
      <p className="min-w-0 truncate text-xs text-zinc-400">{auth.userEmail}</p>
    )}
    <button
      className="h-8 shrink-0 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
      onClick={onSignOut}
      type="button"
    >
      Sign out
    </button>
  </div>
);

const Header = ({
  auth,
  onSignOut,
}: {
  auth?: StoredAuth | undefined;
  onSignOut?: (() => void) | undefined;
}): JSX.Element => (
  <div className="border-b border-zinc-800 px-4 py-3">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <KiloLogo className="size-8 shrink-0 text-[#EDFF00]" />
      <span className="sr-only">Kilo</span>
      {auth === undefined || onSignOut === undefined ? null : (
        <HeaderAccountControls auth={auth} onSignOut={onSignOut} />
      )}
    </div>
  </div>
);

const Shell = ({
  auth,
  children,
  onSignOut,
}: {
  auth?: StoredAuth | undefined;
  children: ReactNode;
  onSignOut?: (() => void) | undefined;
}): JSX.Element => (
  <main className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-50">
    <Header auth={auth} onSignOut={onSignOut} />
    {children}
  </main>
);

const getMeasureButtonLabel = ({
  htmlLength,
  isMeasuringHtml,
}: {
  htmlLength: number | undefined;
  isMeasuringHtml: boolean;
}): string => {
  if (isMeasuringHtml) {
    return 'Measuring...';
  }

  if (htmlLength === undefined) {
    return 'Measure HTML';
  }

  return `HTML length: ${htmlLength.toLocaleString()}`;
};

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
  htmlLength,
  inspectableTabs,
  isLoadingTabs,
  isMeasuringHtml,
  onMeasureHtml,
  onRefreshTabs,
  onSelectTab,
  onSignOut,
  selectedTabId,
  tabDebuggerError,
}: {
  auth: StoredAuth;
  htmlLength: number | undefined;
  inspectableTabs: InspectableTab[];
  isLoadingTabs: boolean;
  isMeasuringHtml: boolean;
  onMeasureHtml: () => void;
  onRefreshTabs: () => void;
  onSelectTab: (tabId: number) => void;
  onSignOut: () => void;
  selectedTabId: number | undefined;
  tabDebuggerError: string | undefined;
}): JSX.Element => (
  <Shell auth={auth} onSignOut={onSignOut}>
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-1 flex-col gap-3 px-4 py-5">
        <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-zinc-100" htmlFor="inspectable-tab">
              Tab
            </label>
            <button
              className="h-8 rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
              disabled={isLoadingTabs}
              onClick={onRefreshTabs}
              type="button"
            >
              {isLoadingTabs ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          <select
            className="mt-3 h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
            disabled={isLoadingTabs || inspectableTabs.length === 0}
            id="inspectable-tab"
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              onSelectTab(Number(event.currentTarget.value));
            }}
            value={selectedTabId?.toString() ?? ''}
          >
            {inspectableTabs.length === 0 ? (
              <option value="">No inspectable tabs</option>
            ) : (
              inspectableTabs.map(tab => (
                <option key={tab.id} value={tab.id}>
                  {tab.title} - {tab.url}
                </option>
              ))
            )}
          </select>

          <button
            className="mt-3 h-10 w-full rounded-md bg-[#EDFF00] px-4 text-sm font-semibold text-zinc-950 transition hover:bg-[#d9ea00] focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            disabled={isMeasuringHtml || selectedTabId === undefined}
            onClick={onMeasureHtml}
            type="button"
          >
            {getMeasureButtonLabel({ htmlLength, isMeasuringHtml })}
          </button>

          {tabDebuggerError === undefined ? null : (
            <p className="mt-3 text-sm leading-5 text-red-300">{tabDebuggerError}</p>
          )}
        </div>
      </div>
    </div>
  </Shell>
);
