import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { captureException } from '@sentry/nextjs';
import { buildGiteaOAuthUrl } from '@/lib/integrations/platforms/gitea/adapter';
import { createGiteaOAuthState } from '@/lib/integrations/platforms/gitea/oauth-state';
import {
  isDefaultGiteaInstanceUrl,
  normalizeGiteaInstanceUrl,
} from '@/lib/integrations/platforms/gitea/instance-url';
import { storeGiteaOAuthCredentials } from '@/lib/integrations/platforms/gitea/oauth-credentials';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import {
  buildIntegrationOAuthConnectErrorPath,
  organizationAccessDenialErrorCode,
  redirectToSignInForOAuthConnect,
} from '@/lib/integrations/oauth/common';
import { getIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import type { Owner } from '@/lib/integrations/core/types';

type AuthenticatedOAuthUser = Parameters<typeof ensureOrganizationAccess>[0]['user'];

const GiteaOAuthConnectPostBodySchema = z.object({
  organizationId: z.string().optional(),
  instanceUrl: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  returnTo: z.string().optional(),
});

type GiteaOAuthConnectOptions = {
  organizationId: string | null;
  instanceUrl?: string;
  clientId?: string;
  clientSecret?: string;
  returnTo?: string | null;
};

/**
 * Gitea OAuth Connect
 *
 * Initiates the Gitea OAuth authorization flow.
 * Redirects the user to Gitea's authorization page.
 *
 * Query parameters:
 * - organizationId: (optional) Organization ID for org-owned integrations
 * - instanceUrl: (optional) Self-hosted Gitea instance URL
 * - returnTo: (optional) Relative path to return to after OAuth
 */
export async function handleGiteaOAuthConnect(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const organizationId = searchParams.get('organizationId');

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      const hasLegacyQueryCredentials =
        searchParams.has('clientId') || searchParams.has('clientSecret');

      return redirectToSignInForOAuthConnect(
        request,
        hasLegacyQueryCredentials ? buildGiteaDetailCallbackPath(organizationId) : undefined
      );
    }

    const instanceUrl = searchParams.get('instanceUrl') || undefined;
    const returnToParam = searchParams.get('returnTo') || undefined;
    const returnTo = returnToParam ? validateReturnPath(returnToParam) : null;

    const oauthUrl = await buildGiteaConnectOAuthUrl(user, {
      organizationId,
      instanceUrl,
      returnTo,
    });

    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    console.error('Error initiating Gitea OAuth:', error);

    const denialCode = organizationAccessDenialErrorCode(error);
    if (!denialCode) {
      captureException(error, {
        tags: {
          endpoint: 'gitea/connect',
          source: 'gitea_oauth',
        },
      });
    }

    return NextResponse.redirect(
      new URL(
        buildIntegrationOAuthConnectErrorPath(
          PLATFORM.GITEA,
          organizationId,
          denialCode ?? 'oauth_init_failed'
        ),
        request.url
      )
    );
  }
}

export async function handleGiteaOAuthConnectPost(request: NextRequest): Promise<Response> {
  const rawBody = await request.json().catch(() => null);
  const parsedBody = GiteaOAuthConnectPostBodySchema.safeParse(rawBody);

  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid Gitea OAuth request' }, { status: 400 });
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

    const oauthUrl = await buildGiteaConnectOAuthUrl(user, {
      organizationId: organizationId ?? null,
      instanceUrl,
      clientId,
      clientSecret,
      returnTo,
    });

    return NextResponse.json({ url: oauthUrl });
  } catch (error) {
    console.error('Error initiating Gitea OAuth:', error);

    const denialCode = organizationAccessDenialErrorCode(error);
    if (!denialCode) {
      captureException(error, {
        tags: {
          endpoint: 'gitea/connect',
          source: 'gitea_oauth',
        },
        extra: {
          organizationId,
          hasCustomCredentials: Boolean(clientId && clientSecret),
        },
      });
    }

    if (denialCode) {
      return NextResponse.json({ error: denialCode }, { status: 403 });
    }

    return NextResponse.json({ error: 'oauth_init_failed' }, { status: 500 });
  }
}

function buildGiteaDetailCallbackPath(organizationId: string | null): string {
  if (organizationId) {
    return `/organizations/${organizationId}/integrations/gitea`;
  }

  return '/integrations/gitea';
}

async function buildGiteaConnectOAuthUrl(
  user: AuthenticatedOAuthUser,
  { organizationId, instanceUrl, clientId, clientSecret, returnTo }: GiteaOAuthConnectOptions
): Promise<string> {
  const owner = await resolveGiteaOAuthOwner(user, organizationId);
  const customCredentials = clientId && clientSecret ? { clientId, clientSecret } : undefined;
  const normalizedInstanceUrl = instanceUrl ? normalizeGiteaInstanceUrl(instanceUrl) : undefined;
  const usesCustomInstance =
    !!normalizedInstanceUrl && !isDefaultGiteaInstanceUrl(normalizedInstanceUrl);

  if (usesCustomInstance && !customCredentials) {
    throw new Error('Custom Gitea OAuth credentials are required for self-hosted instances');
  }

  const customCredentialsRef = customCredentials
    ? await storeGiteaOAuthCredentials(customCredentials)
    : undefined;

  if (customCredentials && !customCredentialsRef) {
    throw new Error('Gitea OAuth credentials cache is unavailable');
  }

  const state = createGiteaOAuthState(
    {
      owner,
      ...(usesCustomInstance ? { instanceUrl: normalizedInstanceUrl } : {}),
      ...(customCredentialsRef ? { customCredentialsRef } : {}),
      ...(returnTo ? { returnTo } : {}),
    },
    user.id
  );

  return buildGiteaOAuthUrl(state, normalizedInstanceUrl, customCredentials);
}

async function resolveGiteaOAuthOwner(
  user: AuthenticatedOAuthUser,
  organizationId: string | null
): Promise<Owner> {
  if (!organizationId) {
    return { type: 'user', id: user.id };
  }

  // Replacing an existing org Gitea integration is a billing-scoped action;
  // a first-time connect keeps member-level access.
  const existingIntegration = await getIntegrationForOrganization(organizationId, PLATFORM.GITEA);
  await ensureOrganizationAccess(
    { user },
    organizationId,
    existingIntegration ? ORGANIZATION_BILLING_ROLES : undefined
  );
  return { type: 'org', id: organizationId };
}
