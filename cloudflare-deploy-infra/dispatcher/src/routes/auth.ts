/**
 * Auth route handlers for password-protected workers.
 * Handles GET and POST requests to /__auth
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { getPasswordRecord } from '../auth/password-store';
import { verifyPassword } from '../auth/password';
import { signJwt } from '../auth/jwt';
import { renderLoginForm } from '../auth/ui/login-form';
import { createLoginRateLimiter } from '../auth/rate-limit';
import { returnPathSchema, authFormSchema } from '../schemas';

// Auth router - will be mounted at /__auth
export const auth = new Hono<{
  Bindings: Env;
  Variables: { publicSlug: string; workerName: string };
}>();

/**
 * GET /__auth?return=/path
 * Renders the login form with the return path.
 * If no password is set for the worker, redirects to the return path.
 */
auth.get('/', async c => {
  const publicSlug = c.get('publicSlug');
  const workerName = c.get('workerName');
  const returnPath = returnPathSchema.parse(c.req.query('return') ?? '/');

  const passwordRecord = await getPasswordRecord(c.env.DEPLOY_KV, workerName);

  if (!passwordRecord) {
    // No password set - redirect to target path since there's nothing to authenticate
    return c.redirect(returnPath, 302);
  }

  return c.html(
    renderLoginForm({
      workerName: publicSlug, // Display the public slug to user
      returnPath,
    })
  );
});

/**
 * POST /__auth
 * Verifies password and sets auth cookie on success.
 * Rate limited.
 */
auth.post('/', createLoginRateLimiter(), async c => {
  const publicSlug = c.get('publicSlug');
  const workerName = c.get('workerName');

  // Parse form data
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.html(
      renderLoginForm({
        workerName: publicSlug,
        returnPath: '/',
        error: 'Invalid request',
      }),
      401
    );
  }

  const formResult = authFormSchema.safeParse({
    password: formData.get('password'),
    return: formData.get('return') ?? '/',
  });

  if (!formResult.success) {
    const returnPath = returnPathSchema.parse(formData.get('return') ?? '/');
    return c.html(
      renderLoginForm({
        workerName: publicSlug,
        returnPath,
        error: 'Password is required',
      }),
      401
    );
  }

  const { password, return: returnPath } = formResult.data;

  const passwordRecord = await getPasswordRecord(c.env.DEPLOY_KV, workerName);

  if (!passwordRecord) {
    // No password set means worker shouldn't be protected
    // This is an unexpected state - just deny access
    return c.html(
      renderLoginForm({
        workerName: publicSlug,
        returnPath,
        error: 'Authentication not configured',
      }),
      401
    );
  }

  // Verify password
  const isValid = verifyPassword(password, passwordRecord);

  if (!isValid) {
    return c.html(
      renderLoginForm({
        workerName: publicSlug,
        returnPath,
        error: 'Invalid password',
      }),
      401
    );
  }

  const sessionDuration = c.env.SESSION_DURATION_SECONDS;
  const jwt = signJwt(
    {
      worker: workerName,
      passwordSetAt: passwordRecord.createdAt,
    },
    c.env.JWT_SECRET,
    sessionDuration
  );

  // Build cookie string with secure attributes
  // Note: Not setting Domain attribute - this scopes to exact subdomain
  const cookie = [
    `kilo_auth=${jwt}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${sessionDuration}`,
  ].join('; ');

  // Redirect to return path
  return new Response(null, {
    status: 302,
    headers: {
      Location: returnPath,
      'Set-Cookie': cookie,
    },
  });
});
