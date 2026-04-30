import { bot } from '@/lib/bot';
import { APP_URL } from '@/lib/constants';
import { linkKiloUser, verifyLinkToken, type PlatformIdentity } from '@/lib/bot-identity';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { getUserFromAuth } from '@/lib/user.server';
import { getPlatformIntegration } from '@/lib/bot/platform-helpers';

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
 * Verify that the authenticated user is allowed to link to this
 * platform installation. For org-owned integrations the user must be
 * an org member; for user-owned integrations only the owner may link.
 */
async function verifyIntegrationAccess(
  identity: PlatformIdentity,
  kiloUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const integration = await getPlatformIntegration(identity);

  if (!integration) {
    return { ok: false, error: 'No matching integration found for this platform.' };
  }

  if (integration.owned_by_organization_id) {
    const isMember = await isOrganizationMember(integration.owned_by_organization_id, kiloUserId);
    if (!isMember) {
      return {
        ok: false,
        error: 'You are not a member of the organization that owns this integration.',
      };
    }
  } else if (integration.owned_by_user_id) {
    if (integration.owned_by_user_id !== kiloUserId) {
      return { ok: false, error: 'You are not the owner of this integration.' };
    }
  } else {
    return { ok: false, error: 'This integration has invalid ownership data.' };
  }

  return { ok: true };
}

/**
 * GET /api/chat/link-account?token=<signed-token>
 *
 * Opened in the browser when a chat user clicks "Link Account".
 * The token is HMAC-signed and time-limited so that a third party
 * cannot forge a link for an arbitrary platform identity.
 *
 * Flow:
 *  1. Verify the signed token (reject expired / tampered tokens).
 *  2. Authenticate the user via NextAuth session (redirect to sign-in if needed).
 *  3. Verify the user belongs to the org that owns the integration.
 *  4. Write the platform identity → Kilo user mapping into Redis.
 *  5. Show a success page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return errorPage('Bad Request', 'Missing token parameter.', 400);
  }

  const identity = verifyLinkToken(token);

  if (!identity) {
    return errorPage(
      'Link Expired',
      'Invalid or expired link. Please go back to your chat and try again.',
      400
    );
  }

  // Authenticate — redirect to sign-in if no session, then back here
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set('callbackPath', url.pathname + url.search);
    return Response.redirect(signInUrl.toString());
  }

  // Verify the user is allowed to link to this integration
  const access = await verifyIntegrationAccess(identity, user.id);
  if (!access.ok) {
    return errorPage('Access Denied', access.error, 403);
  }

  await bot.initialize();

  await linkKiloUser(bot.getState(), identity, user.id);

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Account Linked</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>Account linked</h1>
  <p>Your ${identity.platform} account has been linked to your Kilo account.<br>
     You can close this tab and @mention Kilo again in your chat.</p>
</div>
</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}
