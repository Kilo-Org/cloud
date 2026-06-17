import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { captureException, captureMessage } from '@sentry/nextjs';
import { getUserFromAuth } from '@/lib/user/server';
import { APP_URL } from '@/lib/constants';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireKiloClawAccess } from '@/lib/kiloclaw/access-gate';
import { requireOrganizationKiloClawComputeEntitlement } from '@/lib/organizations/trial-middleware';
import { getActiveInstance, getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import {
  buildAgentCardOAuthUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
  getOrRegisterClientId,
} from '@/lib/integrations/agentcard/agentcard-service';
import {
  createAgentCardOAuthState,
  isSafeAgentCardOAuthReturnTo,
} from '@/lib/integrations/agentcard/oauth-state';
import type { Owner } from '@/lib/integrations/core/types';

const OrganizationIdSchema = z.string().uuid();

function buildConnectErrorPath(organizationId: string | undefined, errorCode: string): string {
  const query = `error=${encodeURIComponent(errorCode)}&provider=agentcard`;
  if (organizationId) {
    return `/organizations/${organizationId}/claw/settings?${query}`;
  }
  return `/claw/settings?${query}`;
}

/**
 * AgentCard OAuth Connect.
 *
 * Initiates the AgentCard authorization-code + PKCE flow. The PKCE verifier and
 * target instance are carried in a signed state bound to the initiating user.
 */
export async function GET(request: NextRequest) {
  let organizationId: string | undefined;

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    const organizationIdParam = request.nextUrl.searchParams.get('organizationId');
    if (organizationIdParam) {
      const parsedOrgId = OrganizationIdSchema.safeParse(organizationIdParam);
      if (!parsedOrgId.success) {
        return NextResponse.redirect(
          new URL(buildConnectErrorPath(undefined, 'invalid_organization'), APP_URL)
        );
      }
      organizationId = parsedOrgId.data;
      await ensureOrganizationAccess({ user }, organizationId);
      await requireOrganizationKiloClawComputeEntitlement(organizationId);
    } else {
      await requireKiloClawAccess(user.id);
    }

    const owner: Owner = organizationId
      ? { type: 'org', id: organizationId }
      : { type: 'user', id: user.id };

    const instance = organizationId
      ? await getActiveOrgInstance(user.id, organizationId)
      : await getActiveInstance(user.id);

    if (!instance) {
      captureMessage('AgentCard connect missing active KiloClaw instance', {
        level: 'warning',
        tags: { endpoint: 'agentcard/connect', source: 'agentcard_oauth' },
        extra: { userId: user.id, organizationId },
      });
      return NextResponse.redirect(
        new URL(buildConnectErrorPath(organizationId, 'missing_instance'), APP_URL)
      );
    }

    const returnToParam = request.nextUrl.searchParams.get('returnTo');
    const returnTo =
      returnToParam && isSafeAgentCardOAuthReturnTo(returnToParam) ? returnToParam : undefined;

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);
    const clientId = await getOrRegisterClientId();

    const state = createAgentCardOAuthState(
      {
        owner,
        instanceId: instance.id,
        clientId,
        codeVerifier,
        ...(returnTo ? { returnTo } : {}),
      },
      user.id
    );

    const oauthUrl = buildAgentCardOAuthUrl({ state, codeChallenge, clientId });
    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    console.error('Error initiating AgentCard OAuth flow:', error);
    captureException(error, {
      tags: { endpoint: 'agentcard/connect', source: 'agentcard_oauth' },
      extra: { organizationId },
    });
    return NextResponse.redirect(
      new URL(buildConnectErrorPath(organizationId, 'oauth_init_failed'), APP_URL)
    );
  }
}
