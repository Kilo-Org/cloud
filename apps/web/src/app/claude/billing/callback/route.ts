import 'server-only';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { and, eq, isNull } from 'drizzle-orm';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { claude_billing_connections } from '@kilocode/db/schema';
import {
  activateClaudeBillingGrant,
  type ClaudeBillingOwner,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { consumeClaudeBillingPending } from '@/lib/claude-billing/pending';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import {
  ClaudeBillingExchangeError,
  exchangeClaudeBillingCode,
} from '@/lib/claude-billing/protocol';
import {
  CLAUDE_BILLING_CALLBACK_PATH,
  claudeBillingOutcomeParam,
} from '@/lib/claude-billing/constants';
import {
  canManageClaudeBillingOrganization,
  isClaudeBillingOrganizationMember,
} from '@/lib/claude-billing/access';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';

/**
 * Completes a Claude billing connection. The pending cookie must belong to the
 * signed-in person and the `state` must match, so a callback cannot be replayed
 * into another session.
 */

function outcomeRedirect(
  returnPath: string,
  owner: Pick<ClaudeBillingOwner, 'kind'>,
  outcome: string
): NextResponse {
  const url = new URL(returnPath, APP_URL);
  url.searchParams.set(claudeBillingOutcomeParam(owner), outcome);
  return NextResponse.redirect(url);
}

/** The URL `auth.claude.com` reported an error on, before any cookie is read. */
function errorOutcome(error: string): string {
  if (error === 'access_denied') return 'declined';
  if (error === 'user_profile_already_linked') return 'already_linked';
  return 'failed';
}

/** The person may still complete the connection they started. */
async function mayComplete(owner: ClaudeBillingOwner, userId: string): Promise<boolean> {
  if (owner.kind === 'personal') return owner.kiloUserId === userId;
  if (owner.kind === 'shared_services') {
    return await canManageClaudeBillingOrganization(userId, owner.organizationId);
  }
  return (
    owner.kiloUserId === userId &&
    (await isClaudeBillingOrganizationMember(userId, owner.organizationId))
  );
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const pending = await consumeClaudeBillingPending();
  // The standard authorized session, so a blocked account or a revoked web
  // session cannot complete a link: the person is reported before the code is
  // exchanged and before the connection row, the grant, or the stored key change.
  const { user, authorizationRefused } = await getUserFromAuth({ adminOnly: false });
  if (authorizationRefused) {
    return outcomeRedirect(
      validateReturnPath(pending?.returnPath ?? '/byok') ?? '/byok',
      pending?.owner ?? { kind: 'personal' },
      'forbidden'
    );
  }
  if (!pending || !user || pending.kiloUserId !== user.id) {
    return outcomeRedirect('/byok', { kind: 'personal' }, 'failed');
  }
  const { owner } = pending;
  const returnPath = validateReturnPath(pending.returnPath) ?? '/byok';

  // auth.claude.com returns the state with every outcome, including a refusal.
  if (params.get('state') !== pending.state) {
    return outcomeRedirect(returnPath, owner, 'failed');
  }
  if (!(await isClaudePlatformOAuthEnabled(user.google_user_email))) {
    return outcomeRedirect(returnPath, owner, 'forbidden');
  }
  // Membership and role can change while the person is on Claude's approval page.
  if (!(await mayComplete(owner, user.id))) {
    return outcomeRedirect(returnPath, owner, 'forbidden');
  }
  const error = params.get('error');
  if (error) return outcomeRedirect(returnPath, owner, errorOutcome(error));

  const code = params.get('code');
  if (!code) return outcomeRedirect(returnPath, owner, 'failed');

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
    return outcomeRedirect(returnPath, owner, oauthError ? errorOutcome(oauthError) : 'failed');
  }

  try {
    await db.transaction(async tx => {
      const [saved] = await tx
        .update(claude_billing_connections)
        .set({
          connection_id: connectionId,
          status: ClaudeBillingConnectionStatus.Connected,
          connected_at: new Date().toISOString(),
          last_refusal_code: null,
          last_refusal_at: null,
          // The person who linked it last; a shared-services link is gated on them.
          created_by: user.id,
        })
        .where(
          and(
            eq(claude_billing_connections.user_profile_id, pending.userProfileId),
            eq(claude_billing_connections.updated_at, pending.connectionVersion)
          )
        )
        .returning({ id: claude_billing_connections.id });
      if (!saved) throw new Error('Claude connection disappeared during approval');
      await activateClaudeBillingGrant(owner, saved.id, user.id, tx);
      // A personal link replaces the person's stored Anthropic API key: they no
      // longer share one, and Kilo never uses a dormant key it did not need. An
      // organization key stays, because it still serves that organization's
      // other requests.
      if (owner.kind === 'personal') {
        await tx
          .delete(byok_api_keys)
          .where(
            and(
              eq(byok_api_keys.provider_id, 'anthropic'),
              eq(byok_api_keys.kilo_user_id, owner.kiloUserId),
              isNull(byok_api_keys.organization_id)
            )
          );
      }
    });
  } catch {
    return outcomeRedirect(returnPath, owner, 'failed');
  }

  return outcomeRedirect(returnPath, owner, 'connected');
}
