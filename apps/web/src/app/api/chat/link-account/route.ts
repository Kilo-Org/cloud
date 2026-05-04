import { bot } from '@/lib/bot';
import { APP_URL } from '@/lib/constants';
import { captureException } from '@sentry/nextjs';
import { after } from 'next/server';
import {
  linkKiloUser,
  verifyLinkToken,
  type LinkSourceMessage,
  type PlatformIdentity,
} from '@/lib/bot-identity';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { getUserFromAuth } from '@/lib/user.server';
import { getPlatformIdentity, getPlatformIntegration } from '@/lib/bot/platform-helpers';
import { processLinkedMessage } from '@/lib/bot/run';
import { withBotPlatformAuthContext } from '@/lib/bot/platform-auth-context';
import type { Adapter, Message } from 'chat';
import type { User } from '@kilocode/db';

const CHANNEL_MESSAGE_FALLBACK_LIMIT = 50;

function isMessageFetchCapable(adapter: Adapter): adapter is Adapter & {
  fetchMessage(threadId: string, messageId: string): Promise<Message | null>;
} {
  return typeof adapter.fetchMessage === 'function';
}

async function fetchMessage(threadId: string, messageId: string) {
  await bot.initialize();
  const thread = bot.thread(threadId);
  let fetchedMessage: Message | null = null;

  if (isMessageFetchCapable(thread.adapter)) {
    fetchedMessage = await thread.adapter.fetchMessage(threadId, messageId).catch(() => null);
  }

  if (!fetchedMessage) {
    let checkedMessages = 0;
    for await (const message of thread.channel.messages) {
      if (message.id === messageId) {
        fetchedMessage = message;
        break;
      }

      checkedMessages += 1;
      if (checkedMessages >= CHANNEL_MESSAGE_FALLBACK_LIMIT) {
        break;
      }
    }
  }

  return fetchedMessage ? { thread, message: fetchedMessage } : null;
}

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

  const linkPayload = verifyLinkToken(token);

  if (!linkPayload) {
    return errorPage(
      'Link Expired',
      'Invalid or expired link. Please go back to your chat and try again.',
      400
    );
  }

  const { identity, sourceMessage } = linkPayload;

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

  if (sourceMessage) {
    after(() => reprocessLinkedMessage(identity, sourceMessage, user));
  }

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Account Linked</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>Account linked</h1>
  <p>Your ${identity.platform} account has been linked to your Kilo account.<br>
     ${
       sourceMessage
         ? 'You can close this tab and return to your chat. Kilo is processing your message.'
         : 'You can close this tab and @mention Kilo again in your chat.'
     }</p>
</div>
</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

async function reprocessLinkedMessage(
  identity: PlatformIdentity,
  sourceMessage: LinkSourceMessage,
  user: User
): Promise<void> {
  try {
    const platformIntegration = await getPlatformIntegration(identity);
    if (!platformIntegration) return;

    await withBotPlatformAuthContext(platformIntegration, async () => {
      const fetched = await fetchMessage(sourceMessage.threadId, sourceMessage.messageId);
      if (!fetched) return;

      const messageIdentity = getPlatformIdentity(fetched.thread, fetched.message);
      if (
        messageIdentity.platform !== identity.platform ||
        messageIdentity.teamId !== identity.teamId ||
        messageIdentity.userId !== identity.userId
      ) {
        return;
      }

      await fetched.thread.startTyping('Thinking...');
      await processLinkedMessage({
        thread: fetched.thread,
        message: fetched.message,
        platformIntegration,
        user,
      });
    });
  } catch (error) {
    console.error('[Bot] Failed to reprocess linked message:', error);
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'link-account-reprocess-message' },
      extra: {
        threadId: sourceMessage.threadId,
        messageId: sourceMessage.messageId,
        userId: user.id,
      },
    });
  }
}
