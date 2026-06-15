import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  getActiveInstance,
  getActiveOrgInstance,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import {
  clearKiloClawAgentCardOAuthConnection,
  decryptRefreshToken,
  getKiloClawAgentCardOAuthConnection,
} from '@/lib/kiloclaw/agentcard-oauth-connections';
import { revokeAgentCardToken } from '@/lib/integrations/agentcard/agentcard-service';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';

const AGENTCARD_SECRET_KEY = 'AGENTCARD_API_KEY';
const OrganizationIdSchema = z.string().uuid();

function buildDisconnectPath(organizationId: string | undefined, queryParam: string): string {
  if (organizationId) {
    return `/organizations/${organizationId}/claw/settings?${queryParam}`;
  }
  return `/claw/settings?${queryParam}`;
}

function isSameOriginMutation(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(APP_URL).origin;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  let organizationId: string | undefined;

  try {
    if (!isSameOriginMutation(request)) {
      return NextResponse.redirect(new URL('/claw/settings?error=invalid_origin', APP_URL), 303);
    }

    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL), 303);
    }

    const organizationIdParam = request.nextUrl.searchParams.get('organizationId');
    if (organizationIdParam) {
      const parsedOrgId = OrganizationIdSchema.safeParse(organizationIdParam);
      if (!parsedOrgId.success) {
        return NextResponse.redirect(
          new URL('/claw/settings?error=invalid_organization', APP_URL),
          303
        );
      }
      organizationId = parsedOrgId.data;
      await ensureOrganizationAccess({ user }, organizationId);
    }

    const instance = organizationId
      ? await getActiveOrgInstance(user.id, organizationId)
      : await getActiveInstance(user.id);

    if (!instance) {
      captureMessage('AgentCard disconnect missing active KiloClaw instance', {
        level: 'warning',
        tags: { endpoint: 'agentcard/disconnect', source: 'agentcard_oauth' },
        extra: { userId: user.id, organizationId },
      });
      return NextResponse.redirect(
        new URL(buildDisconnectPath(organizationId, 'error=missing_instance'), APP_URL),
        303
      );
    }

    const existing = await getKiloClawAgentCardOAuthConnection(instance.id);

    // Clear the stored connection first so disconnect fails closed.
    await clearKiloClawAgentCardOAuthConnection(instance.id);

    // Remove the worker secret so the `agentcard` MCP server is dropped from
    // the gateway config on next sync.
    const kiloclawClient = new KiloClawInternalClient();
    await kiloclawClient.patchSecrets(
      user.id,
      { secrets: { [AGENTCARD_SECRET_KEY]: null } },
      workerInstanceId(instance)
    );

    // Best-effort revocation of the OAuth grant at AgentCard.
    if (existing) {
      const refreshToken = decryptRefreshToken(existing);
      if (refreshToken) {
        await revokeAgentCardToken(refreshToken);
      }
    }

    return NextResponse.redirect(
      new URL(buildDisconnectPath(organizationId, 'success=agentcard_disconnected'), APP_URL),
      303
    );
  } catch (error) {
    console.error('Error disconnecting AgentCard OAuth:', error);
    captureException(error, {
      tags: { endpoint: 'agentcard/disconnect', source: 'agentcard_oauth' },
      extra: { organizationId },
    });
    return NextResponse.redirect(
      new URL(buildDisconnectPath(organizationId, 'error=disconnect_failed'), APP_URL),
      303
    );
  }
}

export async function GET() {
  return NextResponse.redirect(new URL('/claw/settings?error=method_not_allowed', APP_URL));
}
