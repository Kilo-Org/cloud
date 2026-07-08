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
  decryptAccessToken,
  decryptRefreshToken,
  getKiloClawAgentCardOAuthConnection,
} from '@/lib/kiloclaw/agentcard-oauth-connections';
import { revokeAgentCardToken } from '@/lib/integrations/agentcard/agentcard-service';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';

// Null these out to drop the `agentcard` MCP server + its native-OAuth token
// cache from the worker on next config sync (see config-writer.ts). Must match
// the keys seeded by the connect callback.
const AGENTCARD_OAUTH_SECRET_KEYS = [
  'AGENTCARD_OAUTH_CLIENT_ID',
  'AGENTCARD_OAUTH_CLIENT_SECRET',
  'AGENTCARD_OAUTH_REFRESH_TOKEN',
  'AGENTCARD_OAUTH_ACCESS_TOKEN',
  'AGENTCARD_OAUTH_EXPIRES_IN',
  'AGENTCARD_OAUTH_SCOPE',
] as const;
const OrganizationIdSchema = z.string().uuid();

function buildDisconnectPath(organizationId: string | undefined, queryParam: string): string {
  const query = `${queryParam}&provider=agentcard`;
  if (organizationId) {
    return `/organizations/${organizationId}/claw/settings?${query}`;
  }
  return `/claw/settings?${query}`;
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
      return NextResponse.redirect(
        new URL(buildDisconnectPath(undefined, 'error=invalid_origin'), APP_URL),
        303
      );
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
          new URL(buildDisconnectPath(undefined, 'error=invalid_organization'), APP_URL),
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

    // Best-effort server-side revoke of the connect-time tokens. NOTE: with
    // native MCP OAuth the worker rotates the refresh token on every refresh,
    // and AgentCard's /revoke matches the exact presented token — so once the
    // worker has refreshed at least once, these connect-time tokens are already
    // dead rows and this revoke does NOT kill the live successor. The
    // authoritative cut-off is therefore the worker secret null-out + token
    // cache clear below (config-writer drops the `agentcard` server and deletes
    // tokens.json). Users can always hard-revoke the whole grant themselves via
    // AgentCard (`agent-cards connections revoke <clientId>`).
    if (existing) {
      const refreshToken = decryptRefreshToken(existing);
      if (refreshToken) {
        await revokeAgentCardToken({ token: refreshToken, clientId: existing.oauth_client_id });
      }
      await revokeAgentCardToken({
        token: decryptAccessToken(existing),
        clientId: existing.oauth_client_id,
      });
    }

    // Drop the stored connection so the refresh cron stops touching it.
    await clearKiloClawAgentCardOAuthConnection(instance.id);

    // Remove the worker secrets so the `agentcard` MCP server is dropped from
    // the gateway config and mcporter's token cache (with the live rotated
    // refresh token) is deleted on next sync. This is the real cut-off — see
    // the revocation note above. A failure here (e.g. worker unreachable) is
    // logged but must not fail the whole disconnect; the next config sync
    // converges.
    try {
      const kiloclawClient = new KiloClawInternalClient();
      const clearedSecrets: Record<string, null> = {};
      for (const key of AGENTCARD_OAUTH_SECRET_KEYS) {
        clearedSecrets[key] = null;
      }
      await kiloclawClient.patchSecrets(
        user.id,
        { secrets: clearedSecrets },
        workerInstanceId(instance)
      );
    } catch (secretError) {
      console.error('AgentCard worker secret removal failed (disconnect kept):', secretError);
      captureException(secretError, {
        tags: { endpoint: 'agentcard/disconnect', source: 'agentcard_oauth_secret_clear' },
        extra: { organizationId },
      });
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
  return NextResponse.redirect(
    new URL(buildDisconnectPath(undefined, 'error=method_not_allowed'), APP_URL)
  );
}
