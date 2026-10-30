import { bot } from '@/lib/bot';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { verifyLinkToken, type PlatformIdentity } from '@/lib/bot-identity';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { LINK_ACCOUNT_PATH, errorPage, escapeHtml, page } from '@/lib/bot/link-account-page';
import { LinkAccountProofUnavailableError } from '@/lib/bot/link-account-proof';

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
 * HMAC-signed, time-limited token, and it names the platform identity and the
 * stored context of the chat message that asked for the link.
 *
 * This request only renders the confirmation page; it never writes the
 * platform identity → Kilo user mapping. Submitting that page starts the
 * platform's identity proof (see `POST`), and only the proof's callback writes
 * the mapping.
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

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set('callbackPath', url.pathname + url.search);
    return Response.redirect(signInUrl.toString());
  }

  const access = await verifyIntegrationAccess(identity, user.id);
  if (!access.ok) {
    return errorPage('Access Denied', access.error, 403);
  }

  const platform = escapeHtml(identity.platform);

  return page(
    'Link your Kilo account',
    `  <p>You are about to link a ${platform} account to your Kilo account.</p>
  <p>
    ${platform} user: <strong>${escapeHtml(identity.userId)}</strong><br>
    Workspace: <strong>${escapeHtml(identity.teamId)}</strong><br>
    Kilo account: <strong>${escapeHtml(user.google_user_email)}</strong>
  </p>
  <p>In the next step you sign in to ${platform} as the ${platform} user named above.
  Kilo links the account only when that sign-in matches this request.</p>
  <form method="post" action="${LINK_ACCOUNT_PATH}">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit" style="font:inherit;padding:8px 16px">Continue to ${platform}</button>
  </form>`
  );
}

/**
 * POST /api/chat/link-account
 *
 * Submitted by the confirmation page rendered by `GET`, with the link token in
 * the form body. This route writes nothing itself: it starts the platform's
 * identity proof, which returns to the platform's OAuth callback. That callback
 * is the only place that writes the platform identity → Kilo user mapping, and
 * it does so only for an identity the provider itself asserted for the
 * signed-in Kilo user, at most once per link:
 *
 *  1. Reject anything that was not submitted by our own origin.
 *  2. Re-verify the signed token and the platform.
 *  3. Re-authenticate the user and re-check integration access.
 *  4. Redirect to the platform's identity proof.
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
  const { contextKey, identity } = linkPayload;

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

  const beginProof = botPlatforms.require(identity.platform).beginLinkAccountProof;
  if (!beginProof) {
    return errorPage(
      'Link Not Supported',
      `${identity.platform} account links cannot be verified from this page.`,
      400
    );
  }

  let proofUrl: string;
  try {
    proofUrl = beginProof({ identity, contextKey, user });
  } catch (error) {
    if (error instanceof LinkAccountProofUnavailableError) {
      return errorPage('Link Unavailable', error.message, 503);
    }
    throw error;
  }

  return Response.redirect(proofUrl, 303);
}
