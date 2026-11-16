import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { requireAppShellUser } from '@/lib/app-shell/session';
import { appShellRedirect } from '@/lib/app-shell/redirect';
import { APP_SHELL_EXPIRED_PATH, APP_SHELL_PREFIX } from '@/lib/app-shell/shell-paths';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  beginGitHubAppInstall,
  buildGitHubAppInstallUrl,
} from '@/lib/integrations/github/install-start';
import {
  APP_SHELL_FLOW_COOKIE,
  appShellFlowCookieOptions,
  createAppShellFlowToken,
} from '@/lib/integrations/oauth/app-shell-flow';

/** The shell page an install returns to, which renders the outcome. */
const SHELL_RETURN_PATH = `${APP_SHELL_PREFIX}/github-app`;

/**
 * Starts a GitHub App install inside the shell.
 *
 * The install state is a bearer token, so the callback may not accept it on its
 * own. This route mints it for the shell session's user and sets the flow cookie
 * the GitHub callback requires — an HMAC over that user and this exact state,
 * scoped to `/api/integrations`. A copy of the GitHub callback URL taken from
 * the address bar therefore cannot complete an install in another browser.
 */
export async function GET(request: NextRequest) {
  const user = await requireAppShellUser();
  if (!user) {
    return appShellRedirect(APP_SHELL_EXPIRED_PATH);
  }

  const organizationId = request.nextUrl.searchParams.get('organizationId') ?? undefined;
  const returnTo = organizationId
    ? `${SHELL_RETURN_PATH}?${new URLSearchParams({ organizationId }).toString()}`
    : SHELL_RETURN_PATH;

  let token: string;
  let appType: GitHubAppType;
  try {
    ({ token, appType } = await beginGitHubAppInstall({ user }, { organizationId, returnTo }));
  } catch (error) {
    if (
      error instanceof TRPCError &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
    ) {
      return appShellRedirect(
        `${SHELL_RETURN_PATH}?${new URLSearchParams({
          error: 'installation_start_refused',
          ...(organizationId ? { organizationId } : {}),
        }).toString()}`
      );
    }
    throw error;
  }

  const response = NextResponse.redirect(buildGitHubAppInstallUrl(token, appType));
  response.cookies.set(
    APP_SHELL_FLOW_COOKIE,
    createAppShellFlowToken({ userId: user.id, state: token }),
    appShellFlowCookieOptions()
  );
  return response;
}
