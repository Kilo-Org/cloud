import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireKiloClawAccess } from '@/lib/kiloclaw/access-gate';
import { requireOrganizationKiloClawComputeEntitlement } from '@/lib/organizations/trial-middleware';
import { getInstanceById, workerInstanceId } from '@/lib/kiloclaw/instance-registry';
import { exchangeAgentCardCode } from '@/lib/integrations/agentcard/agentcard-service';
import {
  type VerifiedAgentCardOAuthState,
  verifyAgentCardOAuthState,
} from '@/lib/integrations/agentcard/oauth-state';
import { upsertKiloClawAgentCardOAuthConnection } from '@/lib/kiloclaw/agentcard-oauth-connections';
import { encryptKiloClawSecret } from '@/lib/kiloclaw/encryption';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';

// The OpenClaw worker reads this env secret and configures the `agentcard` MCP
// server with `Authorization: Bearer <value>` (see config-writer.ts). The OAuth
// access token slots into the same place the legacy pasted token used.
const AGENTCARD_SECRET_KEY = 'AGENTCARD_API_KEY';

function buildRedirectPath(
  state: { owner: VerifiedAgentCardOAuthState['owner']; returnTo?: string } | null | undefined,
  preEncodedQueryFragment: string
): string {
  if (state?.returnTo) {
    const separator = state.returnTo.includes('?') ? '&' : '?';
    return `${state.returnTo}${separator}${preEncodedQueryFragment}`;
  }
  if (state?.owner?.type === 'org') {
    return `/organizations/${state.owner.id}/claw/settings?${preEncodedQueryFragment}`;
  }
  return `/claw/settings?${preEncodedQueryFragment}`;
}

function sanitizeOAuthProviderError(
  error: string | null,
  errorDescription: string | null
): string | null {
  const source = errorDescription ?? error;
  if (!source) return null;
  const normalized = source.trim();
  if (!normalized) return null;
  if (!/^[A-Za-z0-9 _.:/-]{1,200}$/.test(normalized)) return 'oauth_error';
  return encodeURIComponent(normalized);
}

function sanitizeOAuthCode(code: string | null): string | null {
  if (!code) return null;
  const normalized = code.trim();
  if (!normalized || normalized.length > 2048) return null;
  if (!/^[A-Za-z0-9._~+\-/]+$/.test(normalized)) return null;
  return normalized;
}

function oauthSentryContext(searchParams: URLSearchParams) {
  const state = searchParams.get('state');
  return {
    hasCode: !!searchParams.get('code'),
    hasState: !!state,
    stateHash: state ? createHash('sha256').update(state).digest('hex').slice(0, 8) : null,
    error: searchParams.get('error'),
    errorDescription: searchParams.get('error_description'),
  };
}

/**
 * AgentCard OAuth callback.
 *
 * Verifies the signed state, exchanges the authorization code (+ PKCE verifier)
 * for tokens, stores them encrypted, and pushes the access token to the
 * OpenClaw worker as the AGENTCARD_API_KEY secret so the `agentcard` MCP server
 * is configured for the user's agent.
 */
export async function GET(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');
    const code = searchParams.get('code');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    const verifiedState = verifyAgentCardOAuthState(state);
    if (!verifiedState) {
      captureMessage('AgentCard callback invalid or tampered state', {
        level: 'warning',
        tags: { endpoint: 'agentcard/callback', source: 'agentcard_oauth' },
        extra: oauthSentryContext(searchParams),
      });
      return NextResponse.redirect(new URL('/claw/settings?error=invalid_state', APP_URL));
    }

    if (verifiedState.userId !== user.id) {
      captureMessage('AgentCard callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'agentcard/callback', source: 'agentcard_oauth' },
        extra: { stateUserId: verifiedState.userId, sessionUserId: user.id },
      });
      return NextResponse.redirect(new URL('/claw/settings?error=unauthorized', APP_URL));
    }

    if (verifiedState.owner.type === 'org') {
      await ensureOrganizationAccess({ user }, verifiedState.owner.id);
    } else if (verifiedState.owner.id !== user.id) {
      return NextResponse.redirect(new URL('/claw/settings?error=unauthorized', APP_URL));
    }

    const oauthErrorCode = sanitizeOAuthProviderError(error, errorDescription);
    if (oauthErrorCode) {
      captureMessage('AgentCard OAuth error', {
        level: 'warning',
        tags: { endpoint: 'agentcard/callback', source: 'agentcard_oauth' },
        extra: oauthSentryContext(searchParams),
      });
      return NextResponse.redirect(
        new URL(buildRedirectPath(verifiedState, `error=${oauthErrorCode}`), APP_URL)
      );
    }

    const oauthCode = sanitizeOAuthCode(code);
    if (!oauthCode) {
      return NextResponse.redirect(
        new URL(buildRedirectPath(verifiedState, 'error=missing_code'), APP_URL)
      );
    }

    const instance = await getInstanceById(verifiedState.instanceId);
    if (!instance) {
      return NextResponse.redirect(
        new URL(buildRedirectPath(verifiedState, 'error=missing_instance'), APP_URL)
      );
    }

    const isUserOwnerMatch =
      verifiedState.owner.type === 'user' &&
      instance.userId === user.id &&
      instance.organizationId === null;
    const isOrgOwnerMatch =
      verifiedState.owner.type === 'org' && instance.organizationId === verifiedState.owner.id;
    if (!isUserOwnerMatch && !isOrgOwnerMatch) {
      captureMessage('AgentCard callback owner/instance mismatch', {
        level: 'warning',
        tags: { endpoint: 'agentcard/callback', source: 'agentcard_oauth' },
        extra: {
          owner: verifiedState.owner,
          instanceId: instance.id,
          instanceUserId: instance.userId,
          instanceOrgId: instance.organizationId,
          userId: user.id,
        },
      });
      return NextResponse.redirect(new URL('/claw/settings?error=unauthorized', APP_URL));
    }

    if (verifiedState.owner.type === 'org') {
      await requireOrganizationKiloClawComputeEntitlement(verifiedState.owner.id);
    } else {
      await requireKiloClawAccess(user.id);
    }

    const tokens = await exchangeAgentCardCode({
      code: oauthCode,
      codeVerifier: verifiedState.codeVerifier,
      clientId: verifiedState.clientId,
    });

    await upsertKiloClawAgentCardOAuthConnection({
      instanceId: verifiedState.instanceId,
      oauthClientId: verifiedState.clientId,
      tokens,
    });

    // Push the freshly-minted access token to the worker. config-writer turns
    // AGENTCARD_API_KEY into the `agentcard` MCP server's Bearer header.
    // Best-effort: the OAuth grant is already persisted above, so a transient
    // secret-push failure (e.g. worker unavailable) must not discard the
    // connection — the token-refresh job / next checkin re-pushes it.
    try {
      const kiloclawClient = new KiloClawInternalClient();
      await kiloclawClient.patchSecrets(
        user.id,
        { secrets: { [AGENTCARD_SECRET_KEY]: encryptKiloClawSecret(tokens.accessToken) } },
        workerInstanceId(instance)
      );
    } catch (pushError) {
      console.error('AgentCard secret push failed (connection kept):', pushError);
      captureException(pushError, {
        tags: { endpoint: 'agentcard/callback', source: 'agentcard_oauth_push' },
        extra: oauthSentryContext(searchParams),
      });
    }

    const successPath = buildRedirectPath(verifiedState, 'success=agentcard_connected');
    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling AgentCard OAuth callback:', error);
    const state = request.nextUrl.searchParams.get('state');
    captureException(error, {
      tags: { endpoint: 'agentcard/callback', source: 'agentcard_oauth' },
      extra: oauthSentryContext(request.nextUrl.searchParams),
    });
    return NextResponse.redirect(
      new URL(
        buildRedirectPath(verifyAgentCardOAuthState(state), 'error=connection_failed'),
        APP_URL
      )
    );
  }
}
