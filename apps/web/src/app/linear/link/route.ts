import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { APP_URL } from '@/lib/constants';
import { createLinearBotLinkState } from '@/lib/bot/linear-link-state';
import { verifyLinearLinkToken } from '@/lib/bot/linear-link-token';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegrationById,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { getLinearUserOAuthUrl } from '@/lib/integrations/linear-service';
import { PLATFORM } from '@/lib/integrations/core/constants';

function errorPage(title: string, message: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

/**
 * Entry point for the Linear bot account-link flow.
 *
 * The Linear comment that posted us here was visible to every member of
 * the workspace, so we cannot trust the URL alone. We require:
 *  - a valid signed `token` that names the platform integration,
 *  - an authenticated Kilo session,
 *  - the Kilo user being a member of the integration's owner.
 *
 * On success we redirect into Linear OAuth (`actor=user`, `scope=read`,
 * `prompt=consent`) with a signed state. The Linear callback then proves
 * the clicker's Linear identity via `viewer { id }` before linking it.
 *
 * Re-running this flow as a different Linear user in the same workspace
 * is permitted — `linkKiloUser` overwrites unconditionally, mirroring
 * GitHub's behaviour.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const verifiedToken = verifyLinearLinkToken(token);

  if (!verifiedToken) {
    return errorPage(
      'Link Expired',
      'Invalid or expired Linear link. Please return to Linear and mention Kilo again to get a fresh link.',
      400
    );
  }

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set('callbackPath', `/linear/link?token=${token}`);
    return NextResponse.redirect(signInUrl);
  }

  const integration = await getPlatformIntegrationById(verifiedToken.platformIntegrationId).catch(
    () => null
  );

  if (!integration) {
    return errorPage('Link Failed', 'No matching Linear integration was found.', 404);
  }

  if (integration.platform !== PLATFORM.LINEAR) {
    return errorPage('Link Failed', 'No matching Linear integration was found.', 404);
  }

  if (integration.platform_installation_id !== verifiedToken.organizationId) {
    return errorPage('Link Failed', 'No matching Linear integration was found.', 404);
  }

  if (!botPlatforms.require(PLATFORM.LINEAR).isEnabledForBot(integration)) {
    return errorPage(
      'Link Unavailable',
      'Linear linking is not enabled for this integration.',
      404
    );
  }

  if (!(await canKiloUserAccessPlatformIntegration(integration, user.id))) {
    return errorPage('Access Denied', 'You do not have access to this Linear integration.', 403);
  }

  const state = createLinearBotLinkState({
    userId: user.id,
    platformIntegrationId: integration.id,
    organizationId: verifiedToken.organizationId,
  });

  return NextResponse.redirect(getLinearUserOAuthUrl(state));
}
