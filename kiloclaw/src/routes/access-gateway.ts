import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../types';
import { KILOCLAW_AUTH_COOKIE, KILOCLAW_AUTH_COOKIE_MAX_AGE } from '../config';
import { getWorkerDb, validateAndRedeemAccessCode, findPepperByUserId } from '../db';
import { signKiloToken, validateKiloToken } from '../auth/jwt';
import { deriveGatewayToken } from '../auth/gateway-token';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { sandboxIdFromInstanceId, isValidInstanceId } from '@kilocode/worker-utils/instance-id';
import type { KiloClawEnv } from '../types';

/**
 * Access gateway routes — unauthenticated.
 * Serves an HTML form for entering a one-time access code, then validates
 * it via Hyperdrive, sets an auth cookie, and redirects to the OpenClaw UI.
 *
 * The gateway token (for OpenClaw websocket auth) is derived server-side
 * from the userId after authentication, never passed through the URL or form.
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

/**
 * Derive the redirect URL with the gateway token hash fragment.
 * The token is computed server-side from the userId — never touches the client.
 */
/**
 * Resolve the DO's authoritative sandboxId for gateway token derivation.
 * For instance-keyed DOs this is the ki_ value; for legacy DOs it's the
 * userId-derived base64url value. Falls back to sandboxIdFromUserId if
 * the DO can't be reached (e.g. not provisioned yet).
 */
async function resolveSandboxId(userId: string, env: KiloClawEnv): Promise<string> {
  try {
    const registryKey = `user:${userId}`;
    const registryStub = env.KILOCLAW_REGISTRY.get(env.KILOCLAW_REGISTRY.idFromName(registryKey));
    const entries = await registryStub.listInstances(registryKey);
    if (entries.length > 0) {
      const entry = entries[0];
      // Try the DO's authoritative sandboxId first.
      try {
        const stub = env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(entry.doKey));
        const status = await stub.getStatus();
        if (status.sandboxId) return status.sandboxId;
      } catch {
        // DO unreachable — derive from the registry entry's doKey.
        // If doKey is a UUID (instance-keyed), derive ki_ sandboxId from it.
        // If doKey is a userId (legacy), fall through to sandboxIdFromUserId.
        if (isValidInstanceId(entry.doKey)) {
          return sandboxIdFromInstanceId(entry.doKey);
        }
      }
    }
  } catch {
    // Registry unreachable — fall back to legacy derivation
  }
  return sandboxIdFromUserId(userId);
}

async function buildRedirectUrl(userId: string, env: KiloClawEnv): Promise<string> {
  if (!env.GATEWAY_TOKEN_SECRET) return '/';
  const sandboxId = await resolveSandboxId(userId, env);
  const token = await deriveGatewayToken(sandboxId, env.GATEWAY_TOKEN_SECRET);
  return `/#token=${token}`;
}

function renderPage(params: { userId: string; error?: string }) {
  const { userId, error } = params;
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

/**
 * Validate an access code, set the auth cookie, and return the redirect URL.
 * Returns an error object if validation fails (caller should show an error).
 */
async function redeemCodeAndSetCookie(
  c: Context<AppEnv>,
  code: string,
  userId: string
): Promise<{ redirectUrl: string } | { error: string; status: 401 | 500 }> {
  const connectionString = c.env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    console.error('[access-gateway] HYPERDRIVE not configured');
    return { error: 'Server configuration error.', status: 500 };
  }

  const secret = c.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.error('[access-gateway] NEXTAUTH_SECRET not configured');
    return { error: 'Server configuration error.', status: 500 };
  }

  const db = getWorkerDb(connectionString);

  const redeemedUserId = await validateAndRedeemAccessCode(db, code, userId);
  if (!redeemedUserId) {
    return {
      error: 'Invalid or expired access code. Please generate a new one from your dashboard.',
      status: 401,
    };
  }

  const user = await findPepperByUserId(db, redeemedUserId);
  if (!user) {
    return { error: 'User not found.', status: 401 };
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
    secure: c.env.WORKER_ENV !== 'development',
    sameSite: 'Lax',
    maxAge: KILOCLAW_AUTH_COOKIE_MAX_AGE,
  });

  const redirectUrl = await buildRedirectUrl(redeemedUserId, c.env);
  return { redirectUrl };
}

accessGatewayRoutes.get('/kilo-access-gateway', async c => {
  const userId = c.req.query('userId');
  if (!userId) {
    return c.text('Missing userId parameter', 400);
  }

  // If the user already has a valid cookie, derive the gateway token and redirect
  const secret = c.env.NEXTAUTH_SECRET;
  if (secret) {
    const cookie = getCookie(c, KILOCLAW_AUTH_COOKIE);
    if (await hasValidCookie(cookie, userId, secret, c.env.WORKER_ENV)) {
      const redirectUrl = await buildRedirectUrl(userId, c.env);
      return c.redirect(redirectUrl);
    }
  }

  // If an auth_code is provided in the URL, validate it directly (auto-auth flow).
  // This lets the dashboard embed the code in the Open link so users skip manual entry.
  const authCode = c.req.query('auth_code')?.trim().toUpperCase();
  if (authCode) {
    const result = await redeemCodeAndSetCookie(c, authCode, userId);
    if ('redirectUrl' in result) {
      return c.html(renderLoadingPage(result.redirectUrl));
    }
    // Code was invalid/expired — fall through to the manual form with the error
    return c.html(renderPage({ userId, error: result.error }), result.status);
  }

  return c.html(renderPage({ userId }));
});

accessGatewayRoutes.post('/kilo-access-gateway', async c => {
  const body = await c.req.parseBody();
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';

  if (!code || !userId) {
    return c.html(renderPage({ userId, error: 'Access code and user ID are required.' }), 400);
  }

  const result = await redeemCodeAndSetCookie(c, code, userId);
  if ('redirectUrl' in result) {
    return c.html(renderLoadingPage(result.redirectUrl));
  }
  return c.html(renderPage({ userId, error: result.error }), result.status);
});

export { accessGatewayRoutes };
