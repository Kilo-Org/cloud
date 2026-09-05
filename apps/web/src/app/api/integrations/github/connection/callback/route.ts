import { NextResponse, type NextRequest } from 'next/server';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user/server';
import { consumeGitHubConnectionOAuthState } from '@/lib/integrations/github/connection-state';
import {
  completeGitHubConnectionAttempt,
  recordGitHubConnectionDiscovery,
} from '@/lib/integrations/github/connection-service';
import { exchangeGitHubOAuthCode } from '@/lib/integrations/platforms/github/adapter';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';
import {
  discoverAuthorizedGitHubInstallations,
  verifyGitHubInstallationAuthorization,
} from '@/lib/integrations/github/installation-authorization';
import { db } from '@/lib/drizzle';
import { github_connection_attempts } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import type { User } from '@kilocode/db/schema';
import { isGitHubConnectionManagementEnabled } from '@/lib/integrations/github/multiple-installations';

function redirect(path: string, error?: string) {
  const url = new URL(path, APP_URL);
  if (error) url.searchParams.set('github_connection_error', error);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
  if (!isGitHubConnectionManagementEnabled()) return redirect('/github-app', 'not_available');
  const state = await consumeGitHubConnectionOAuthState(
    request.nextUrl.searchParams.get('state'),
    user.id
  );
  if (!state || request.nextUrl.searchParams.get('error'))
    return redirect('/github-app', 'invalid_state');
  const code = request.nextUrl.searchParams.get('code');
  if (!code || !/^[A-Za-z0-9._~+/-]{1,2048}$/.test(code))
    return redirect('/github-app', 'missing_code');
  const [attempt] = await db
    .select()
    .from(github_connection_attempts)
    .where(eq(github_connection_attempts.id, state.attemptId))
    .limit(1);
  if (
    !attempt ||
    attempt.kilo_user_id !== user.id ||
    attempt.consumed_at ||
    new Date(attempt.expires_at) <= new Date()
  )
    return redirect('/github-app', 'invalid_attempt');
  try {
    if (attempt.owner_type === 'org') {
      await ensureOrganizationAccess(
        { user: user as User },
        attempt.owner_id,
        ORGANIZATION_MANAGE_ROLES
      );
    } else if (attempt.owner_id !== user.id) {
      return redirect('/github-app', 'authorization_revoked');
    }
  } catch {
    return redirect('/github-app', 'authorization_revoked');
  }
  try {
    const oauth = await exchangeGitHubOAuthCode(code, attempt.github_app_type, state.codeVerifier);
    const credentials = getGitHubAppCredentials(attempt.github_app_type);
    const path =
      attempt.owner_type === 'org'
        ? `/organizations/${attempt.owner_id}/integrations/github`
        : '/integrations/github';
    if (state.stage === 'discover') {
      const discovery = await discoverAuthorizedGitHubInstallations({
        accessToken: oauth.accessToken,
        githubAppType: attempt.github_app_type,
        expectedAppId: credentials.appId,
      });
      await recordGitHubConnectionDiscovery({
        attemptId: attempt.id,
        userId: user.id,
        githubUserId: discovery.identity.id,
        candidates: discovery.candidates,
      });
      const url = new URL(path, APP_URL);
      url.searchParams.set('github_connection_attempt', attempt.id);
      return NextResponse.redirect(url);
    }
    if (!attempt.selected_installation_id) return redirect(path, 'invalid_selection');
    const proof = await verifyGitHubInstallationAuthorization({
      accessToken: oauth.accessToken,
      githubAppType: attempt.github_app_type,
      expectedAppId: credentials.appId,
      installationId: attempt.selected_installation_id,
    });
    if (!proof || proof.identity.id !== attempt.github_user_id)
      return redirect(path, 'authorization_revoked');
    const completed = await completeGitHubConnectionAttempt({
      attemptId: attempt.id,
      userId: user.id,
      githubUserId: proof.identity.id,
      candidate: proof.candidate,
      authorizeOwner: async owner => {
        if (owner.type === 'org') {
          await ensureOrganizationAccess(
            { user: user as User },
            owner.id,
            ORGANIZATION_MANAGE_ROLES
          );
        } else if (owner.id !== user.id) {
          throw new Error('GitHub connection owner authorization changed');
        }
      },
    });
    if (!completed.ok) return redirect(path, completed.reason);
    return redirect(`${path}?github_connection=success`);
  } catch {
    return redirect('/github-app', 'connection_failed');
  }
}
