import { bot } from '@/lib/bot';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { captureException } from '@sentry/nextjs';
import { after } from 'next/server';
import {
  consumeLinkAccountContext,
  linkKiloUser,
  verifyLinkToken,
  type PlatformIdentity,
} from '@/lib/bot-identity';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { processLinkedMessage } from '@/lib/bot/run';
import { Message, ThreadImpl, type Thread } from 'chat';
import type { User } from '@kilocode/db';

const LINK_ACCOUNT_PATH = '/api/chat/link-account';

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // The page's only action is a form posted back to this route, and the link
  // token travels in the page URL, so the page declares a same-origin form
  // action and asks intermediaries not to store, embed, sniff, or forward it.
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>${escapeHtml(title)}</h1>
${body}
</div>
</body></html>`,
    { status, headers: PAGE_HEADERS }
  );
}

function errorPage(title: string, message: string, status: number): Response {
  return page(title, `  <p>${escapeHtml(message)}</p>`, status);
}

/**
 * Require a submission from this app's own origin: the confirmation page and
 * the route are served from the same origin, so any other origin, and a
 * request without one, is refused.
 */
function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(APP_URL).origin;
  } catch {
    return false;
  }
}

/**
 * Verify the signed link token and that the platform uses this route.
 * Returns either the verified payload or the page to render.
 */
async function verifyLinkRequest(token: string | null) {
  if (!token) {
    return {
      ok: false as const,
      response: errorPage('Bad Request', 'Missing token parameter.', 400),
    };
  }

  await bot.initialize();
  const linkPayload = await verifyLinkToken(bot.getState(), token);

  if (!linkPayload) {
    return {
      ok: false as const,
      response: errorPage(
        'Link Expired',
        'Invalid or expired link. Please go back to your chat and try again.',
        400
      ),
    };
  }

  const { identity } = linkPayload;

  if (!botPlatforms.require(identity.platform).usesGenericLinkAccountRoute) {
    return {
      ok: false as const,
      response: errorPage(
        'Link Not Supported',
        `${identity.platform} account links must be created from the platform-specific link page.`,
        400
      ),
    };
  }

  return { ok: true as const, token, linkPayload };
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

  if (!(await canKiloUserAccessPlatformIntegration(integration, kiloUserId))) {
    return { ok: false, error: 'This integration has invalid ownership data.' };
  }

  return { ok: true };
}

/**
 * GET /api/chat/link-account?token=<signed-token>
 *
 * Opened in the browser when a chat user clicks "Link Account". The link is an
 * HMAC-signed, time-limited token, and it names only the platform identity and
 * the stored context of the chat message that asked for the link.
 *
 * This request only renders the confirmation page; it never writes the
 * platform identity → Kilo user mapping. The mapping is written by the
 * explicit same-origin POST from that page (see `POST`).
 *
 * Flow:
 *  1. Verify the signed token (reject expired / tampered tokens).
 *  2. Authenticate the user via NextAuth session (redirect to sign-in if needed).
 *  3. Verify the user belongs to the org that owns the integration.
 *  4. Show the confirmation page naming the platform identity and the Kilo account.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const checked = await verifyLinkRequest(url.searchParams.get('token'));

  if (!checked.ok) {
    return checked.response;
  }

  const { token, linkPayload } = checked;
  const { identity } = linkPayload;

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

  return page(
    'Link your Kilo account',
    `  <p>You are about to link this ${escapeHtml(identity.platform)} account to your Kilo account.</p>
  <p>
    ${escapeHtml(identity.platform)} user: <strong>${escapeHtml(identity.userId)}</strong><br>
    Workspace: <strong>${escapeHtml(identity.teamId)}</strong><br>
    Kilo account: <strong>${escapeHtml(user.google_user_email)}</strong>
  </p>
  <p>Only continue if you asked Kilo for this link in your own ${escapeHtml(identity.platform)} conversation.</p>
  <form method="post" action="${LINK_ACCOUNT_PATH}">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit" style="font:inherit;padding:8px 16px">Link account</button>
  </form>`
  );
}

/**
 * POST /api/chat/link-account
 *
 * Submitted by the confirmation page rendered by `GET`, with the link token in
 * the form body. This is the only path that writes the platform identity →
 * Kilo user mapping, and it does so at most once per link:
 *
 *  1. Reject anything that was not submitted by our own origin.
 *  2. Re-verify the signed token and the platform.
 *  3. Re-authenticate the user and re-check integration access.
 *  4. Consume the link; an already-consumed link writes nothing.
 *  5. Write the mapping and re-process the original chat message.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return errorPage(
      'Invalid Request',
      'This confirmation has to be submitted from the Kilo app.',
      403
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage('Bad Request', 'Malformed request body.', 400);
  }

  const formToken = form.get('token');
  const checked = await verifyLinkRequest(typeof formToken === 'string' ? formToken : null);

  if (!checked.ok) {
    return checked.response;
  }

  const { token, linkPayload } = checked;
  const { contextKey, identity, thread, message } = linkPayload;

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    // A 302 turns this POST back into a GET of the confirmation page after
    // sign-in; nothing is written for this request.
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set(
      'callbackPath',
      `${LINK_ACCOUNT_PATH}?token=${encodeURIComponent(token)}`
    );
    return Response.redirect(signInUrl.toString());
  }

  const access = await verifyIntegrationAccess(identity, user.id);
  if (!access.ok) {
    return errorPage('Access Denied', access.error, 403);
  }

  // Consume before writing so a link completes exactly once, even when two
  // requests for the same token arrive together.
  if (!(await consumeLinkAccountContext(bot.getState(), contextKey))) {
    return errorPage(
      'Link Already Used',
      'This link has already been used. Please go back to your chat and mention Kilo again to get a new link.',
      400
    );
  }

  await linkKiloUser(bot.getState(), identity, user.id);

  after(() =>
    reprocessLinkedMessage(identity, ThreadImpl.fromJSON(thread), Message.fromJSON(message), user)
  );

  return page(
    'Account linked',
    `  <p>Your ${escapeHtml(identity.platform)} account has been linked to your Kilo account.<br>
     You can close this tab and return to your chat. Kilo is processing your message.</p>`
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

    await botPlatforms.require(platformIntegration.platform).withAuthContext({
      platformIntegration,
      fn: async () => {
        await processLinkedMessage({
          thread,
          message,
          platformIntegration,
          user,
        });
      },
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
