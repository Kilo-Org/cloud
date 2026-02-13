import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../types';
import { KILOCLAW_AUTH_COOKIE, KILOCLAW_AUTH_COOKIE_MAX_AGE } from '../config';
import { createDatabaseConnection, AccessCodeStore, UserStore } from '../db';
import { signKiloToken, validateKiloToken } from '../auth/jwt';

/**
 * Access gateway routes — unauthenticated.
 * Serves an HTML form for entering a one-time access code, then validates
 * it via Hyperdrive, sets an auth cookie, and redirects to the OpenClaw UI.
 *
 * The gateway token (for OpenClaw websocket auth) is carried through the
 * entire flow as a query param / hidden field / redirect hash fragment.
 */
const accessGatewayRoutes = new Hono<AppEnv>();

// Shared styles used by both the form page and the loading page
const BASE_STYLES = /* css */ `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: #0a0a0a; color: #e0e0e0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 1rem;
  }
  .card {
    background: #161616; border: 1px solid #2a2a2a; border-radius: 12px;
    padding: 2rem; max-width: 420px; width: 100%;
  }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; color: #fff; }
  .subtitle { font-size: 0.85rem; color: #888; margin-bottom: 1.5rem; }
`;

function buildRedirectUrl(gatewayToken: string | undefined): string {
  return gatewayToken ? `/#token=${gatewayToken}` : '/';
}

function renderPage(params: { userId: string; gatewayToken?: string; error?: string }) {
  const { userId, gatewayToken, error } = params;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KiloClaw Access Gateway</title>
  <style>
    ${BASE_STYLES}
    label { display: block; font-size: 0.8rem; color: #aaa; margin-bottom: 0.5rem; }
    input[type="text"] {
      width: 100%; padding: 0.75rem 1rem; font-size: 1.25rem; font-family: monospace;
      letter-spacing: 0.15em; text-align: center; text-transform: uppercase;
      background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #fff;
      outline: none; transition: border-color 0.15s;
    }
    input[type="text"]:focus { border-color: #666; }
    input[type="text"]::placeholder { color: #444; letter-spacing: 0.1em; }
    .error {
      background: #2d1515; border: 1px solid #5c2020; border-radius: 6px;
      padding: 0.6rem 0.8rem; font-size: 0.8rem; color: #f87171; margin-bottom: 1rem;
    }
    button {
      width: 100%; padding: 0.75rem; margin-top: 1rem; font-size: 0.9rem;
      font-weight: 600; background: #fff; color: #0a0a0a; border: none;
      border-radius: 8px; cursor: pointer; transition: opacity 0.15s;
    }
    button:hover { opacity: 0.85; }
    button:active { opacity: 0.7; }
  </style>
</head>
<body>
  <div class="card">
    <h1>KiloClaw Access</h1>
    <p class="subtitle">Enter the access code from your dashboard</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/kilo-access-gateway">
      <input type="hidden" name="userId" value="${escapeHtml(userId)}" />
      ${gatewayToken ? `<input type="hidden" name="gatewayToken" value="${escapeHtml(gatewayToken)}" />` : ''}
      <label for="code">Access Code</label>
      <input type="text" id="code" name="code" placeholder="XXXXX-XXXXX"
             maxlength="11" autocomplete="off" autofocus required />
      <button type="submit">Authenticate</button>
    </form>
  </div>
</body>
</html>`;
}

function renderLoadingPage(redirectUrl: string) {
  const safeUrl = escapeHtml(redirectUrl);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="2;url=${safeUrl}" />
  <title>Loading KiloClaw...</title>
  <style>
    ${BASE_STYLES}
    .loading { text-align: center; }
    .spinner {
      display: inline-block; width: 24px; height: 24px;
      border: 2px solid #333; border-top-color: #fff; border-radius: 50%;
      animation: spin 0.8s linear infinite; margin-bottom: 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { font-size: 0.85rem; color: #aaa; }
    a { color: #888; font-size: 0.8rem; margin-top: 1rem; display: inline-block; }
  </style>
</head>
<body>
  <div class="card loading">
    <div class="spinner"></div>
    <h1>Access code accepted</h1>
    <p class="status">Loading KiloClaw Control UI...</p>
    <noscript><a href="${safeUrl}">Click here to continue</a></noscript>
  </div>
  <script>setTimeout(function() { window.location.href = ${JSON.stringify(redirectUrl)}; }, 1000);</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Check if the user already has a valid auth cookie.
 * Returns true if the cookie JWT is valid and the userId matches.
 *
 * Note: this only checks the JWT signature/expiry/version — it does NOT
 * validate the pepper against the DB. If the pepper was rotated, authMiddleware
 * will catch it on the next real request and return 401.
 */
async function hasValidCookie(
  cookieValue: string | undefined,
  userId: string,
  secret: string,
  workerEnv: string | undefined
): Promise<boolean> {
  if (!cookieValue) return false;
  const result = await validateKiloToken(cookieValue, secret, workerEnv);
  return result.success && result.userId === userId;
}

accessGatewayRoutes.get('/kilo-access-gateway', async c => {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.text('Missing userId parameter', 400);
  }

  const gatewayToken = c.req.query('token') || undefined;
  const redirectUrl = buildRedirectUrl(gatewayToken);

  // If the user already has a valid cookie, skip straight to the UI
  const secret = c.env.NEXTAUTH_SECRET;
  if (secret) {
    const cookie = getCookie(c, KILOCLAW_AUTH_COOKIE);
    if (await hasValidCookie(cookie, userId, secret, c.env.WORKER_ENV)) {
      return c.redirect(redirectUrl);
    }
  }

  return c.html(renderPage({ userId, gatewayToken }));
});

accessGatewayRoutes.post('/kilo-access-gateway', async c => {
  const body = await c.req.parseBody();
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const gatewayToken =
    typeof body.gatewayToken === 'string' && body.gatewayToken ? body.gatewayToken : undefined;

  if (!code || !userId) {
    return c.html(
      renderPage({ userId, gatewayToken, error: 'Access code and user ID are required.' }),
      400
    );
  }

  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    console.error('[access-gateway] HYPERDRIVE not configured');
    return c.html(renderPage({ userId, gatewayToken, error: 'Server configuration error.' }), 500);
  }

  const secret = c.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.error('[access-gateway] NEXTAUTH_SECRET not configured');
    return c.html(renderPage({ userId, gatewayToken, error: 'Server configuration error.' }), 500);
  }

  const db = createDatabaseConnection(connectionString);
  const accessCodeStore = new AccessCodeStore(db);

  const redeemedUserId = await accessCodeStore.validateAndRedeem(code, userId);
  if (!redeemedUserId) {
    return c.html(
      renderPage({
        userId,
        gatewayToken,
        error: 'Invalid or expired access code. Please generate a new one from your dashboard.',
      }),
      401
    );
  }

  // Look up the user's pepper so the JWT matches what authMiddleware expects
  const userStore = new UserStore(db);
  const user = await userStore.findPepperByUserId(redeemedUserId);
  if (!user) {
    return c.html(renderPage({ userId, gatewayToken, error: 'User not found.' }), 401);
  }

  const token = await signKiloToken({
    userId: redeemedUserId,
    pepper: user.api_token_pepper,
    secret,
    env: c.env.WORKER_ENV,
  });

  setCookie(c, KILOCLAW_AUTH_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: KILOCLAW_AUTH_COOKIE_MAX_AGE,
  });

  return c.html(renderLoadingPage(buildRedirectUrl(gatewayToken)));
});

export { accessGatewayRoutes };
