import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
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
  buildIntegrationOAuthConnectErrorPath,
  redirectToSignInForOAuthConnect,
} from '@/lib/integrations/oauth/common';
import type { Owner } from '@/lib/integrations/core/types';

type AuthenticatedOAuthUser = Parameters<typeof ensureOrganizationAccess>[0]['user'];

const GitLabOAuthConnectPostBodySchema = z.object({
  organizationId: z.string().optional(),
  instanceUrl: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  returnTo: z.string().optional(),
});

type GitLabOAuthConnectOptions = {
  organizationId: string | null;
  instanceUrl?: string;
  clientId?: string;
  clientSecret?: string;
  returnTo?: string | null;
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
 * - clientId/clientSecret: (temporary, authenticated GET compatibility) Self-hosted OAuth credentials
 * - returnTo: (optional) Relative path to return to after OAuth
 */
export async function handleGitLabOAuthConnect(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const organizationId = searchParams.get('organizationId');

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      const hasLegacyQueryCredentials =
        searchParams.has('clientId') || searchParams.has('clientSecret');

      return redirectToSignInForOAuthConnect(
        request,
        hasLegacyQueryCredentials ? buildGitLabDetailCallbackPath(organizationId) : undefined
      );
    }

    const instanceUrl = searchParams.get('instanceUrl') || undefined;
    const clientId = searchParams.get('clientId') || undefined;
    const clientSecret = searchParams.get('clientSecret') || undefined;
    const returnToParam = searchParams.get('returnTo') || undefined;
    const returnTo = returnToParam ? validateReturnPath(returnToParam) : null;
    const legacyQueryCredentials =
      clientId && clientSecret ? { clientId, clientSecret } : undefined;

    const oauthUrl = await buildGitLabConnectOAuthUrl(user, {
      organizationId,
      instanceUrl,
      // Temporary rollout compatibility for old client bundles that sent
      // self-hosted GitLab credentials through an authenticated GET.
      ...legacyQueryCredentials,
      returnTo,
    });

    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    console.error('Error initiating GitLab OAuth:', error);

    captureException(error, {
      tags: {
        endpoint: 'gitlab/connect',
        source: 'gitlab_oauth',
      },
    });

    return NextResponse.redirect(
      new URL(
        buildIntegrationOAuthConnectErrorPath(PLATFORM.GITLAB, organizationId, 'oauth_init_failed'),
        request.url
      )
    );
  }
}

export async function handleGitLabOAuthConnectPost(request: NextRequest): Promise<Response> {
  const rawBody = await request.json().catch(() => null);
  const parsedBody = GitLabOAuthConnectPostBodySchema.safeParse(rawBody);

  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid GitLab OAuth request' }, { status: 400 });
  }

  const {
    organizationId,
    instanceUrl,
    clientId,
    clientSecret,
    returnTo: rawReturnTo,
  } = parsedBody.data;
  const returnTo = rawReturnTo ? validateReturnPath(rawReturnTo) : null;

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const oauthUrl = await buildGitLabConnectOAuthUrl(user, {
      organizationId: organizationId ?? null,
      instanceUrl,
      clientId,
      clientSecret,
      returnTo,
    });

    return NextResponse.json({ url: oauthUrl });
  } catch (error) {
    console.error('Error initiating GitLab OAuth:', error);

    captureException(error, {
      tags: {
        endpoint: 'gitlab/connect',
        source: 'gitlab_oauth',
      },
      extra: {
        organizationId,
        hasCustomCredentials: Boolean(clientId && clientSecret),
      },
    });

    return NextResponse.json({ error: 'oauth_init_failed' }, { status: 500 });
  }
}

function buildGitLabDetailCallbackPath(organizationId: string | null): string {
  if (organizationId) {
    return `/organizations/${organizationId}/integrations/gitlab`;
  }

  return '/integrations/gitlab';
}

async function buildGitLabConnectOAuthUrl(
  user: AuthenticatedOAuthUser,
  { organizationId, instanceUrl, clientId, clientSecret, returnTo }: GitLabOAuthConnectOptions
): Promise<string> {
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

  const state = createGitLabOAuthState(
    {
      owner,
      ...(usesCustomInstance ? { instanceUrl: normalizedInstanceUrl } : {}),
      ...(customCredentialsRef ? { customCredentialsRef } : {}),
      ...(returnTo ? { returnTo } : {}),
    },
    user.id
  );

  return buildGitLabOAuthUrl(state, normalizedInstanceUrl, customCredentials);
}

async function resolveGitLabOAuthOwner(
  user: AuthenticatedOAuthUser,
  organizationId: string | null
): Promise<Owner> {
  if (!organizationId) {
    return { type: 'user', id: user.id };
  }

  await ensureOrganizationAccess({ user }, organizationId);
  return { type: 'org', id: organizationId };
}
