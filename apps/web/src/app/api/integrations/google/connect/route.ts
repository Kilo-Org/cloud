import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromAuth } from '@/lib/user.server';
import { APP_URL } from '@/lib/constants';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { getActiveInstance, getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import { buildGoogleOAuthUrl } from '@/lib/integrations/google-service';
import { createGoogleOAuthState } from '@/lib/integrations/google/oauth-state';
import { DEFAULT_GOOGLE_CAPABILITIES } from '@/lib/integrations/google/capabilities';
import { captureException, captureMessage } from '@sentry/nextjs';
import type { Owner } from '@/lib/integrations/core/types';

const OrganizationIdSchema = z.string().uuid();

function buildConnectErrorPath(organizationId: string | undefined, errorCode: string): string {
  if (organizationId) {
    return `/organizations/${organizationId}/claw/settings?error=${encodeURIComponent(errorCode)}`;
  }

  return `/claw/settings?error=${encodeURIComponent(errorCode)}`;
}

/**
 * Google OAuth Connect
 *
 * Initiates the Google OAuth authorization flow with a signed state payload
 * that binds the flow to user, owner context, instance, and capability set.
 *
 * Query params:
 * - organizationId: optional organization UUID
 */
export async function GET(request: NextRequest) {
  let organizationId: string | undefined;

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    const capabilities = [...DEFAULT_GOOGLE_CAPABILITIES];

    const organizationIdParam = request.nextUrl.searchParams.get('organizationId');
    if (organizationIdParam) {
      const parsedOrgId = OrganizationIdSchema.safeParse(organizationIdParam);
      if (!parsedOrgId.success) {
        return NextResponse.redirect(new URL('/claw/settings?error=invalid_organization', APP_URL));
      }
      organizationId = parsedOrgId.data;
      await ensureOrganizationAccess({ user }, organizationId);
    }

    const owner: Owner = organizationId
      ? { type: 'org', id: organizationId }
      : { type: 'user', id: user.id };

    const instance = organizationId
      ? await getActiveOrgInstance(user.id, organizationId)
      : await getActiveInstance(user.id);

    if (!instance) {
      captureMessage('Google connect missing active KiloClaw instance', {
        level: 'warning',
        tags: { endpoint: 'google/connect', source: 'google_oauth' },
        extra: {
          userId: user.id,
          organizationId,
          capabilities,
        },
      });

      const redirectPath = buildConnectErrorPath(organizationId, 'missing_instance');
      return NextResponse.redirect(new URL(redirectPath, APP_URL));
    }

    const state = createGoogleOAuthState(
      {
        owner,
        instanceId: instance.id,
        capabilities,
      },
      user.id
    );

    const oauthUrl = buildGoogleOAuthUrl(state, capabilities);
    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    console.error('Error initiating Google OAuth flow:', error);

    captureException(error, {
      tags: {
        endpoint: 'google/connect',
        source: 'google_oauth',
      },
      extra: {
        organizationId,
      },
    });

    const redirectPath = buildConnectErrorPath(organizationId, 'oauth_init_failed');
    return NextResponse.redirect(new URL(redirectPath, APP_URL));
  }
}
