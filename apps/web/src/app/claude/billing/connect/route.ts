import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { getUserFromSession } from '@kilocode/web-shared/lib/user/server';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import {
  ClaudeBillingShareError,
  getClaudeBillingConnectionIncludingRemoved,
  shareClaudeBillingConnection,
  type ClaudeBillingOwner,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { ensureClaudeBillingProfile } from '@/lib/claude-billing/profile';
import { saveClaudeBillingPending } from '@/lib/claude-billing/pending';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import { pushClaudeAuthorizationRequest } from '@/lib/claude-billing/protocol';
import {
  CLAUDE_BILLING_CALLBACK_PATH,
  claudeBillingOutcomeParam,
} from '@/lib/claude-billing/constants';
import {
  canManageClaudeBillingOrganization,
  isClaudeBillingOrganizationMember,
} from '@/lib/claude-billing/access';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';

function outcomeRedirect(
  returnPath: string,
  owner: Pick<ClaudeBillingOwner, 'kind'>,
  outcome: string
) {
  const url = new URL(returnPath, APP_URL);
  url.searchParams.set(claudeBillingOutcomeParam(owner), outcome);
  return NextResponse.redirect(url);
}

/**
 * Resolves the connection the link will serve: `owner=personal` for the
 * person's account, `owner=<organizationId>` for their own requests in an
 * organization, and the same with `scope=shared_services` for the
 * organization's platform services, which only a manager may link.
 */
async function resolveOwner(
  request: NextRequest,
  userId: string
): Promise<ClaudeBillingOwner | null> {
  const ownerParam = request.nextUrl.searchParams.get('owner') ?? 'personal';
  if (ownerParam === 'personal') return { kind: 'personal', kiloUserId: userId };
  const organizationId = z.uuid().safeParse(ownerParam);
  if (!organizationId.success) return null;
  if (request.nextUrl.searchParams.get('scope') === 'shared_services') {
    if (!(await canManageClaudeBillingOrganization(userId, organizationId.data))) return null;
    return { kind: 'shared_services', organizationId: organizationId.data };
  }
  if (!(await isClaudeBillingOrganizationMember(userId, organizationId.data))) return null;
  return { kind: 'member', kiloUserId: userId, organizationId: organizationId.data };
}

export async function GET(request: NextRequest) {
  const returnPath =
    validateReturnPath(request.nextUrl.searchParams.get('return') ?? '/byok') ?? '/byok';
  const session = await getUserFromSession();
  if (!session) {
    return NextResponse.redirect(
      new URL(`/users/sign_in?callbackPath=${encodeURIComponent(returnPath)}`, APP_URL)
    );
  }
  const owner = await resolveOwner(request, session.id);
  if (!owner) {
    const requestedKind =
      request.nextUrl.searchParams.get('scope') === 'shared_services'
        ? 'shared_services'
        : 'member';
    return outcomeRedirect(returnPath, { kind: requestedKind }, 'forbidden');
  }
  const user = await findUserById(session.id);
  if (!(await isClaudePlatformOAuthEnabled(user?.google_user_email))) {
    return outcomeRedirect(returnPath, owner, 'forbidden');
  }

  try {
    if (request.nextUrl.searchParams.get('source') === 'personal') {
      if (owner.kind === 'personal') return outcomeRedirect(returnPath, owner, 'failed');
      try {
        await shareClaudeBillingConnection(
          { kind: 'personal', kiloUserId: session.id },
          owner,
          session.id
        );
        return outcomeRedirect(returnPath, owner, 'connected');
      } catch (error) {
        if (error instanceof ClaudeBillingShareError && error.reason === 'target_connected') {
          return outcomeRedirect(returnPath, owner, 'already_linked');
        }
        throw error;
      }
    }

    const userProfileId = await ensureClaudeBillingProfile(owner, session.id);
    const connection = await getClaudeBillingConnectionIncludingRemoved(owner);
    if (!connection) return outcomeRedirect(returnPath, owner, 'failed');
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(64).toString('base64url');
    const authorizeUrl = await pushClaudeAuthorizationRequest({
      userProfileId,
      redirectUri: `${APP_URL}${CLAUDE_BILLING_CALLBACK_PATH}`,
      state,
      codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    });
    await saveClaudeBillingPending({
      kiloUserId: session.id,
      owner,
      returnPath,
      state,
      codeVerifier,
      userProfileId,
      connectionVersion: connection.updated_at,
    });
    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    // Only the name and HTTP status: provider errors can carry request metadata.
    console.error('[claude-billing] connect failed', {
      error: error instanceof Error ? error.name : 'unknown',
      status:
        typeof error === 'object' && error !== null && 'status' in error
          ? String(error.status)
          : 'none',
    });
    return outcomeRedirect(returnPath, owner, 'failed');
  }
}
