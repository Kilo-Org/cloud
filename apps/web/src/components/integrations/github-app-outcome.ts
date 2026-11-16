import { APP_SHELL_PREFIX } from '@/lib/app-shell/shell-paths';

/**
 * Where an app-initiated GitHub install goes when the component has no
 * `appReturnPath`: the Cloud sessions page inside the full web app.
 */
export const APP_RETURN_PATH = '/cloud/sessions';

/**
 * The app path an outcome button returns to. A shell start keeps every link on
 * its own shell page; every other flow keeps the Cloud sessions page the mobile
 * app's universal link handles, whatever return path the caller names.
 */
export function appReturnBasePath(appReturnPath: string | undefined): string {
  return appReturnPath && appReturnPath.startsWith(APP_SHELL_PREFIX)
    ? appReturnPath
    : APP_RETURN_PATH;
}

export function buildAppReturnHref(
  query: string,
  organizationId?: string,
  appBasePath: string = APP_RETURN_PATH
): string {
  const orgParam = organizationId ? `&organizationId=${encodeURIComponent(organizationId)}` : '';
  const separator = appBasePath.includes('?') ? '&' : '?';
  return `${appBasePath}${separator}${query}${orgParam}`;
}

/**
 * A canonical installation GitHub reports as suspended or deleted refuses the
 * completion, so the card must name that state instead of the
 * claimed-by-another-account reason.
 */
export const INSTALLATION_UNAVAILABLE_MESSAGE =
  'This GitHub App installation is suspended or no longer available. Restore or reinstall it in GitHub, then start again.';

export type AppReturnOutcomeView = {
  kind: 'installed' | 'pending' | 'blocked' | 'retryable';
  title: string;
  description: string;
  cta: string;
  href: string;
};

/**
 * Where a spent or unusable pre-minted install state sends the browser: the
 * app's fallback page, which mints a fresh one, or the shell page for a shell
 * start.
 */
export function buildInstallStateRecoveryHref(input: {
  fromApp?: boolean;
  appBasePath: string;
  organizationId?: string;
}): string {
  if (input.appBasePath === APP_RETURN_PATH) {
    return `/github-app?error=install_state_invalid${input.fromApp ? '&fromApp=1' : ''}`;
  }
  return buildAppReturnHref('error=install_state_invalid', input.organizationId, input.appBasePath);
}

/**
 * View model for the fromApp outcome card. `blocked` (non-retryable) shows
 * `Back` and never offers retry; `retryable` shows `Try again` (a real action
 * wired by the component) plus `Return to Kilo App`, both via `href`.
 */
export function buildAppReturnOutcomeView(input: {
  success?: boolean;
  pendingApproval?: boolean;
  error?: string;
  organizationId?: string;
  /** The app path the outcome leads to; the shell's page for a shell install. */
  appBasePath?: string;
}): AppReturnOutcomeView {
  const isSuccess = Boolean(input.success);
  const isPending = !isSuccess && Boolean(input.pendingApproval);
  const isNonRetryable =
    input.error === 'install_state_user_mismatch' ||
    input.error === 'not_installation_admin' ||
    input.error === 'installation_already_claimed' ||
    input.error === 'shared_installation_disabled' ||
    input.error === 'incompatible_workflow' ||
    input.error === 'installation_unavailable' ||
    input.error === 'multiple_installations_disabled';
  const returnQuery = isSuccess
    ? 'github_install=success'
    : isPending
      ? 'github_pending_approval=true'
      : `error=${encodeURIComponent(input.error ?? 'installation_failed')}`;
  const title = isSuccess
    ? 'GitHub App installed'
    : isPending
      ? 'Awaiting admin approval'
      : isNonRetryable
        ? 'Cannot complete installation'
        : 'Installation failed';
  const description = isSuccess
    ? 'Your repositories are now connected.'
    : isPending
      ? 'An organization admin must approve the installation request.'
      : input.error === 'not_installation_admin'
        ? 'Only a GitHub admin of that account can connect it. Ask an organization admin to install Kilo.'
        : input.error === 'installation_already_claimed'
          ? 'That GitHub installation is already connected to another Kilo account. Disconnect it there first.'
          : input.error === 'shared_installation_disabled'
            ? 'That GitHub installation is connected elsewhere, and shared access is not approved for this organization.'
            : input.error === 'incompatible_workflow'
              ? 'That GitHub installation has an existing workflow that is not yet compatible with shared access.'
              : input.error === 'multiple_installations_disabled'
                ? 'This Kilo organization can currently connect only one GitHub organization.'
                : input.error === 'installation_unavailable'
                  ? INSTALLATION_UNAVAILABLE_MESSAGE
                  : input.error === 'install_state_user_mismatch'
                    ? 'This connection was started from the Kilo App signed in as a different account. Sign in to the web with that account, or start again from the app.'
                    : 'The installation did not complete. Try again or return to the Kilo App.';
  const cta = isSuccess ? 'Continue' : isPending ? 'Done' : isNonRetryable ? 'Back' : 'Try again';

  return {
    kind: isSuccess
      ? 'installed'
      : isPending
        ? 'pending'
        : isNonRetryable
          ? 'blocked'
          : 'retryable',
    title,
    description,
    cta,
    href: buildAppReturnHref(returnQuery, input.organizationId, input.appBasePath),
  };
}

