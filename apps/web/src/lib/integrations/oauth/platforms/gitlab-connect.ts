import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { captureException } from '@sentry/nextjs';
import { buildGitLabOAuthUrl } from '@/lib/integrations/platforms/gitlab/adapter';
import { createGitLabOAuthState } from '@/lib/integrations/platforms/gitlab/oauth-state';
import {
  isDefaultGitLabInstanceUrl,
  normalizeGitLabInstanceUrl,
} from '@/lib/integrations/platforms/gitlab/instance-url';
import { storeGitLabOAuthCredentials } from '@/lib/integrations/platforms/gitlab/oauth-credentials';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import {
  appendIntegrationOAuthRedirectQuery,
  buildIntegrationOAuthConnectErrorPath,
  organizationAccessDenialErrorCode,
  redirectToSignInForOAuthConnect,
} from '@/lib/integrations/oauth/common';
import {
  APP_SHELL_FLOW_COOKIE,
  appShellFlowCookieOptions,
  createAppShellFlowToken,
} from '@/lib/integrations/oauth/app-shell-flow';
import { APP_SHELL_PREFIX, buildAppShellIntegrationPath } from '@/lib/app-shell/shell-paths';
import { appShellRedirect } from '@/lib/app-shell/redirect';
import { getIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import type { Owner } from '@/lib/integrations/core/types';

type AuthenticatedOAuthUser = Parameters<typeof ensureOrganizationAccess>[0]['user'];

const GitLabOAuthConnectPostBodySchema = z.object({
  organizationId: z.string().max(128).optional(),
  instanceUrl: z.string().max(2048).optional(),
  clientId: z.string().max(512).optional(),
  clientSecret: z.string().max(512).optional(),
  returnTo: z.string().max(2048).optional(),
});

type GitLabOAuthConnectOptions = {
  organizationId: string | null;
  instanceUrl?: string;
  clientId?: string;
  clientSecret?: string;
  returnTo?: string | null;
  /** Set when the app shell started the flow; see `VerifiedOAuthState.appShell`. */
  appShell?: boolean;
};

type GitLabConnectCaller = {
  user: AuthenticatedOAuthUser;
  /** The app shell supplies its own session, and every redirect stays on its page. */
  appShell?: boolean;
};

/**
 * GitLab OAuth Connect
 *
 * Initiates the GitLab OAuth authorization flow.
 * Redirects the user to GitLab's authorization page.
 *
 * Query parameters:
 * - organizationId: (optional) Organization ID for org-owned integrations
 * - instanceUrl: (optional) Self-hosted GitLab instance URL
 * - returnTo: (optional) Relative path to return to after OAuth
 */
export async function handleGitLabOAuthConnect(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      const hasLegacyQueryCredentials =
        searchParams.has('clientId') || searchParams.has('clientSecret');

      return redirectToSignInForOAuthConnect(
        request,
        hasLegacyQueryCredentials
          ? buildGitLabDetailCallbackPath(searchParams.get('organizationId'))
          : undefined
      );
    }

    return await startGitLabOAuthConnect(request, { user });
  } catch (error) {
    return gitLabConnectFailure(request, error);
  }
}

/**
 * Starts the GitLab dance for an already-identified caller. The web entry point
 * supplies the web session's user; the app shell supplies its own session and
 * `appShell`, which pins the callback to the shell page.
 */
export async function startGitLabOAuthConnect(
  request: NextRequest,
  { user, appShell }: GitLabConnectCaller
): Promise<Response> {
  const searchParams = request.nextUrl.searchParams;
  const organizationId = searchParams.get('organizationId');
  const instanceUrl = searchParams.get('instanceUrl') || undefined;
  const returnToParam = searchParams.get('returnTo') || undefined;
  const returnTo = appShell
    ? buildAppShellIntegrationPath(PLATFORM.GITLAB, organizationId ?? undefined)
    : returnToParam
      ? validateReturnPath(returnToParam)
      : null;

  const { url, state } = await buildGitLabConnectOAuthUrl(user, {
    organizationId,
    instanceUrl,
    returnTo,
    appShell,
  });

  const response = NextResponse.redirect(url);
  if (appShell) {
    response.cookies.set(
      APP_SHELL_FLOW_COOKIE,
      createAppShellFlowToken({ userId: user.id, state }),
      appShellFlowCookieOptions()
    );
  }
  return response;
}

/** The redirect an aborted connect lands on: the shell page when the shell started it. */
function gitLabConnectFailure(request: NextRequest, error: unknown): Response {
  const organizationId = request.nextUrl.searchParams.get('organizationId');
  console.error('Error initiating GitLab OAuth:', error);

  const denialCode = organizationAccessDenialErrorCode(error);
  if (!denialCode) {
    captureException(error, {
      tags: {
        endpoint: 'gitlab/connect',
        source: 'gitlab_oauth',
      },
    });
  }

  const errorCode = denialCode ?? 'oauth_init_failed';
  if (request.nextUrl.pathname.startsWith(APP_SHELL_PREFIX)) {
    return appShellRedirect(
      appendIntegrationOAuthRedirectQuery(
        buildAppShellIntegrationPath(PLATFORM.GITLAB, organizationId ?? undefined),
        `error=${encodeURIComponent(errorCode)}`
      )
    );
  }

  return NextResponse.redirect(
    new URL(
      buildIntegrationOAuthConnectErrorPath(PLATFORM.GITLAB, organizationId, errorCode),
      request.url
    )
  );
}

export async function handleGitLabOAuthConnectPost(request: NextRequest): Promise<Response> {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await startGitLabOAuthConnectPost(request, { user });
  } catch (error) {
    return gitLabConnectPostFailure(request, error);
  }
}

/**
 * The self-hosted GitLab connect the shell can call: same body, but the caller
 * is the shell session and the state it mints stays inside the shell.
 */
export async function startGitLabOAuthConnectPost(
  request: NextRequest,
  { user, appShell }: GitLabConnectCaller
): Promise<Response> {
  let organizationId: string | null = null;
  let hasCustomCredentials = false;

  try {
    const rawBody = await request.json().catch(() => null);
    const parsedBody = GitLabOAuthConnectPostBodySchema.safeParse(rawBody);

    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid GitLab OAuth request' }, { status: 400 });
    }

    const { instanceUrl, clientId, clientSecret, returnTo: rawReturnTo } = parsedBody.data;
    organizationId = parsedBody.data.organizationId ?? null;
    hasCustomCredentials = Boolean(clientId && clientSecret);
    const returnTo = appShell
      ? buildAppShellIntegrationPath(PLATFORM.GITLAB, organizationId ?? undefined)
      : rawReturnTo
        ? validateReturnPath(rawReturnTo)
        : null;

    const { url, state } = await buildGitLabConnectOAuthUrl(user, {
      organizationId,
      instanceUrl,
      clientId,
      clientSecret,
      returnTo,
      appShell,
    });

    const response = NextResponse.json({ url });
    if (appShell) {
      response.cookies.set(
        APP_SHELL_FLOW_COOKIE,
        createAppShellFlowToken({ userId: user.id, state }),
        appShellFlowCookieOptions()
      );
    }
    return response;
  } catch (error) {
    return gitLabConnectPostFailure(request, error, {
      organizationId: organizationId,
      hasCustomCredentials,
    });
  }
}

function gitLabConnectPostFailure(
  request: NextRequest,
  error: unknown,
  context: { organizationId: string | null; hasCustomCredentials: boolean } = {
    organizationId: request.nextUrl.searchParams.get('organizationId'),
    hasCustomCredentials: false,
  }
): Response {
  console.error('Error initiating GitLab OAuth:', error);

  const denialCode = organizationAccessDenialErrorCode(error);
  if (!denialCode) {
    captureException(error, {
      tags: {
        endpoint: 'gitlab/connect',
        source: 'gitlab_oauth',
      },
      extra: context,
    });
  }

  if (denialCode) {
    return NextResponse.json({ error: denialCode }, { status: 403 });
  }

  return NextResponse.json({ error: 'oauth_init_failed' }, { status: 500 });
}

function buildGitLabDetailCallbackPath(organizationId: string | null): string {
  if (organizationId) {
    return `/organizations/${organizationId}/integrations/gitlab`;
  }

  return '/integrations/gitlab';
}

async function buildGitLabConnectOAuthUrl(
  user: AuthenticatedOAuthUser,
  {
    organizationId,
    instanceUrl,
    clientId,
    clientSecret,
    returnTo,
    appShell,
  }: GitLabOAuthConnectOptions
): Promise<{ url: string; state: string }> {
  const owner = await resolveGitLabOAuthOwner(user, organizationId);
  const customCredentials = clientId && clientSecret ? { clientId, clientSecret } : undefined;
  const normalizedInstanceUrl = instanceUrl ? normalizeGitLabInstanceUrl(instanceUrl) : undefined;
  const usesCustomInstance =
    !!normalizedInstanceUrl && !isDefaultGitLabInstanceUrl(normalizedInstanceUrl);

  if (usesCustomInstance && !customCredentials) {
    throw new Error('Custom GitLab OAuth credentials are required for self-hosted instances');
  }

  const customCredentialsRef = customCredentials
    ? await storeGitLabOAuthCredentials(customCredentials)
    : undefined;

  if (customCredentials && !customCredentialsRef) {
    throw new Error('GitLab OAuth credentials cache is unavailable');
  }

  const statePayload = {
    owner,
    ...(usesCustomInstance ? { instanceUrl: normalizedInstanceUrl } : {}),
    ...(customCredentialsRef ? { customCredentialsRef } : {}),
    ...(returnTo ? { returnTo } : {}),
  };
  // The web entry point has no shell to pin; passing the option only for a shell
  // start keeps the signed payload of a plain web connect identical.
  const state = appShell
    ? createGitLabOAuthState(statePayload, user.id, { appShell: true })
    : createGitLabOAuthState(statePayload, user.id);

  return {
    url: buildGitLabOAuthUrl(state, normalizedInstanceUrl, customCredentials),
    state,
  };
}

async function resolveGitLabOAuthOwner(
  user: AuthenticatedOAuthUser,
  organizationId: string | null
): Promise<Owner> {
  if (!organizationId) {
    return { type: 'user', id: user.id };
  }

  // The stored credential is the organization's shared GitLab authorisation, so
  // binding it is a billing-scoped action whether or not a connection already
  // exists. Asking for the same role set on every start keeps the decision
  // independent of the current row state.
  await ensureOrganizationAccess({ user }, organizationId, ORGANIZATION_BILLING_ROLES);
  return { type: 'org', id: organizationId };
}
