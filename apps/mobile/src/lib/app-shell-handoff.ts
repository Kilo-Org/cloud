import { WEB_BASE_URL } from '@/lib/config';
import { openProducedUrl } from '@/lib/external-link';
import { trpcClient } from '@/lib/trpc';

/**
 * The pages the app hands off to the web app shell. Each one either needs a
 * provider's OAuth browser round trip or edits data the app does not own, and
 * none of them may land the reviewer in the purchase surfaces of the full web
 * app, so they all open under `/app-shell`.
 */
export type AppShellTarget =
  | { page: 'github-app'; organizationId?: string }
  | {
      page: 'integration';
      platform: 'github' | 'gitlab' | 'slack' | 'linear' | 'discord';
      organizationId?: string;
    }
  | { page: 'connected-accounts' }
  | { page: 'organization-sso'; organizationId: string }
  | { page: 'organization-data-collection'; organizationId: string };

function appShellBase(): string {
  return WEB_BASE_URL.endsWith('/') ? WEB_BASE_URL.slice(0, -1) : WEB_BASE_URL;
}

/**
 * The full shell URL for a target: mints a one-time hand-off token for the
 * signed-in account and returns the URL to open. The server decides the shell
 * path, and the token is single use and short lived, so a URL that leaks after
 * the browser opened it is worthless.
 */
export async function appShellHandoffUrl(target: AppShellTarget): Promise<string> {
  const { path } = await trpcClient.appShell.mintHandoff.mutate(target);
  return `${appShellBase()}${path}`;
}

/**
 * Mints the hand-off and opens it in the in-app browser. A failed mint reports
 * the same copy as a failed open, and its "Try again" mints a fresh token
 * instead of replaying the spent one.
 */
export async function openAppShellHandoff(
  target: AppShellTarget,
  options: { label?: string; retryOnError?: boolean } = {}
): Promise<void> {
  await openProducedUrl(() => appShellHandoffUrl(target), options);
}

/** The in-shell sign-in page for the device-auth flow, which runs signed out. */
export function appShellSignInUrl(options: { email?: string; callbackPath: string }): string {
  const params = new URLSearchParams({ callbackPath: options.callbackPath });
  if (options.email) {
    params.set('email', options.email);
  }
  return `${appShellBase()}/app-shell/sign-in?${params.toString()}`;
}
