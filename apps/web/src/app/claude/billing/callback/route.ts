import 'server-only';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { and, eq } from 'drizzle-orm';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { getUserFromSession } from '@kilocode/web-shared/lib/user/server';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { claude_billing_connections } from '@kilocode/db/schema';
import type { ClaudeBillingOwner } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { consumeClaudeBillingPending } from '@/lib/claude-billing/pending';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import {
  ClaudeBillingExchangeError,
  exchangeClaudeBillingCode,
} from '@/lib/claude-billing/protocol';
import { CLAUDE_BILLING_CALLBACK_PATH } from '@/lib/claude-billing/constants';
import { canManageClaudeBillingOrganization } from '@/lib/claude-billing/access';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';

/**
 * Completes a Claude billing connection. The pending cookie must belong to the
 * signed-in person and the `state` must match, so a callback cannot be replayed
 * into another session.
 */

function outcomeRedirect(returnPath: string, outcome: string): NextResponse {
  const url = new URL(returnPath, APP_URL);
  url.searchParams.set('claude_billing', outcome);
  return NextResponse.redirect(url);
}

/** The URL `auth.claude.com` reported an error on, before any cookie is read. */
function errorOutcome(error: string): string {
  if (error === 'access_denied') return 'declined';
  if (error === 'user_profile_already_linked') return 'already_linked';
  return 'failed';
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const pending = await consumeClaudeBillingPending();
  const session = await getUserFromSession();

  if (!pending || !session || pending.kiloUserId !== session.id) {
    return outcomeRedirect('/byok', 'failed');
  }
  const returnPath = validateReturnPath(pending.returnPath) ?? '/byok';

  // auth.claude.com returns the state with every outcome, including a refusal.
  if (params.get('state') !== pending.state) return outcomeRedirect(returnPath, 'failed');
  const user = await findUserById(session.id);
  if (!(await isClaudePlatformOAuthEnabled(user?.google_user_email))) {
    return outcomeRedirect(returnPath, 'forbidden');
  }
  // Membership can change while the person is on Claude's approval page.
  if (
    pending.owner !== 'personal' &&
    !(await canManageClaudeBillingOrganization(session.id, pending.owner))
  ) {
    return outcomeRedirect(returnPath, 'forbidden');
  }
  const error = params.get('error');
  if (error) return outcomeRedirect(returnPath, errorOutcome(error));

  const code = params.get('code');
  if (!code) return outcomeRedirect(returnPath, 'failed');

  let connectionId: string;
  try {
    connectionId = await exchangeClaudeBillingCode({
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: `${APP_URL}${CLAUDE_BILLING_CALLBACK_PATH}`,
    });
  } catch (exchangeError) {
    const oauthError =
      exchangeError instanceof ClaudeBillingExchangeError ? exchangeError.oauthError : null;
    return outcomeRedirect(returnPath, oauthError ? errorOutcome(oauthError) : 'failed');
  }

  const owner: ClaudeBillingOwner =
    pending.owner === 'personal'
      ? { kind: 'personal', kiloUserId: session.id }
      : { kind: 'organization', organizationId: pending.owner };

  try {
    await db.transaction(async tx => {
      const saved = await tx
        .update(claude_billing_connections)
        .set({
          connection_id: connectionId,
          status: ClaudeBillingConnectionStatus.Connected,
          connected_at: new Date().toISOString(),
          last_refusal_code: null,
          last_refusal_at: null,
        })
        .where(
          and(
            eq(claude_billing_connections.user_profile_id, pending.userProfileId),
            eq(claude_billing_connections.updated_at, pending.connectionVersion),
            owner.kind === 'personal'
              ? eq(claude_billing_connections.kilo_user_id, owner.kiloUserId)
              : eq(claude_billing_connections.organization_id, owner.organizationId)
          )
        )
        .returning({ id: claude_billing_connections.id });
      if (saved.length !== 1) throw new Error('Claude connection disappeared during approval');
      // The connection replaces a stored Anthropic API key: the customer no
      // longer shares one, and Kilo never uses a dormant key it did not need.
      await tx
        .delete(byok_api_keys)
        .where(
          and(
            eq(byok_api_keys.provider_id, 'anthropic'),
            owner.kind === 'organization'
              ? eq(byok_api_keys.organization_id, owner.organizationId)
              : eq(byok_api_keys.kilo_user_id, owner.kiloUserId)
          )
        );
    });
  } catch {
    return outcomeRedirect(returnPath, 'failed');
  }

  return outcomeRedirect(returnPath, 'connected');
}
