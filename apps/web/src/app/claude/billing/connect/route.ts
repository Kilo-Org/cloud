import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { getUserFromSession } from '@kilocode/web-shared/lib/user/server';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import {
  getClaudeBillingConnection,
  type ClaudeBillingOwner,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import { ensureClaudeBillingProfile } from '@/lib/claude-billing/profile';
import { saveClaudeBillingPending } from '@/lib/claude-billing/pending';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import { pushClaudeAuthorizationRequest } from '@/lib/claude-billing/protocol';
import { CLAUDE_BILLING_CALLBACK_PATH } from '@/lib/claude-billing/constants';
import { canManageClaudeBillingOrganization } from '@/lib/claude-billing/access';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';

function failureRedirect(returnPath: string, outcome: string) {
  const url = new URL(returnPath, APP_URL);
  url.searchParams.set('claude_billing', outcome);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const returnPath =
    validateReturnPath(request.nextUrl.searchParams.get('return') ?? '/byok') ?? '/byok';
  const ownerParam = request.nextUrl.searchParams.get('owner') ?? 'personal';
  const session = await getUserFromSession();
  if (!session) {
    return NextResponse.redirect(
      new URL(`/users/sign_in?callbackPath=${encodeURIComponent(returnPath)}`, APP_URL)
    );
  }
  const user = await findUserById(session.id);
  if (!(await isClaudePlatformOAuthEnabled(user?.google_user_email))) {
    return failureRedirect(returnPath, 'forbidden');
  }
  let owner: ClaudeBillingOwner;
  if (ownerParam === 'personal') {
    owner = { kind: 'personal', kiloUserId: session.id };
  } else {
    const organizationId = z.uuid().safeParse(ownerParam);
    if (
      !organizationId.success ||
      !(await canManageClaudeBillingOrganization(session.id, organizationId.data))
    ) {
      return failureRedirect(returnPath, 'forbidden');
    }
    owner = { kind: 'organization', organizationId: organizationId.data };
  }

  try {
    const userProfileId = await ensureClaudeBillingProfile(owner, session.id);
    const connection = await getClaudeBillingConnection(owner);
    if (!connection) return failureRedirect(returnPath, 'failed');
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
      owner: ownerParam,
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
    return failureRedirect(returnPath, 'failed');
  }
}
