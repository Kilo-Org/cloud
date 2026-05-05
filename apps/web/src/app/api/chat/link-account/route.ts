import { bot } from '@/lib/bot';
import { APP_URL } from '@/lib/constants';
import { captureException } from '@sentry/nextjs';
import { after } from 'next/server';
import {
  consumeLinkAccountContext,
  linkKiloUser,
  verifyLinkToken,
  type PlatformIdentity,
} from '@/lib/bot-identity';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { getUserFromAuth } from '@/lib/user.server';
import { getPlatformIntegration } from '@/lib/bot/platform-helpers';
import { processLinkedMessage } from '@/lib/bot/run';
import { withBotPlatformAuthContext } from '@/lib/bot/platform-auth-context';
import { Message, ThreadImpl, type Thread } from 'chat';
import type { User } from '@kilocode/db';
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
 *  5. Re-process the original chat message when the link token has one.
 *  6. Show a success page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return errorPage('Bad Request', 'Missing token parameter.', 400);
  }

  await bot.initialize();
  const linkPayload = await verifyLinkToken(bot.getState(), token);

  if (!linkPayload) {
    return errorPage(
      'Link Expired',
      'Invalid or expired link. Please go back to your chat and try again.',
      400
    );
  }

  const { contextKey, identity, thread, message } = linkPayload;

  if (identity.platform === PLATFORM.GITHUB) {
    return errorPage(
      'Link Not Supported',
      'GitHub account links must be created from the GitHub link page.',
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

  await linkKiloUser(bot.getState(), identity, user.id);

  if (await consumeLinkAccountContext(bot.getState(), contextKey)) {
    after(() =>
      reprocessLinkedMessage(identity, ThreadImpl.fromJSON(thread), Message.fromJSON(message), user)
    );
  }

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Account Linked</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>Account linked</h1>
  <p>Your ${identity.platform} account has been linked to your Kilo account.<br>
     You can close this tab and return to your chat. Kilo is processing your message.</p>
</div>
</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

async function reprocessLinkedMessage(
  identity: PlatformIdentity,
  thread: Thread,
  message: Message,
  user: User
): Promise<void> {
  try {
    const platformIntegration = await getPlatformIntegration(identity);
    if (!platformIntegration) return;

    await withBotPlatformAuthContext(platformIntegration, async () => {
      await processLinkedMessage({
        thread,
        message,
        platformIntegration,
        user,
      });
    });
  } catch (error) {
    console.error('[Bot] Failed to reprocess linked message:', error);
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'link-account-reprocess-message' },
      extra: {
        threadId: thread.id,
        messageId: message.id,
        userId: user.id,
      },
    });
  }
}
