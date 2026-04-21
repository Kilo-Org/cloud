import { z } from 'zod';
import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';

const GoogleOAuthTokenRequestSchema = z.object({
  capabilities: z.array(z.string().min(1)).default(['calendar_read']),
});

const GoogleOAuthStatusRequestSchema = z.object({});

type TokenProvider = {
  getToken: (capabilities: readonly string[]) => Promise<{
    accessToken: string;
    expiresAt: string;
    accountEmail: string;
    scopes: string[];
  }>;
  getStatus: () => Promise<{
    connected: boolean;
    accounts: Array<{
      email: string;
      client: string;
      services: string[];
      scopes: string[];
      created_at: string;
      auth: string;
      profile: 'legacy' | 'kilo_owned';
      status: string;
    }>;
  }>;
};

export function registerGoogleOAuthTokenRoutes(
  app: Hono,
  expectedToken: string,
  tokenProvider: TokenProvider
): void {
  app.use('/_kilo/google-oauth/*', async (c, next) => {
    const authHeader = c.req.header('authorization');
    const [scheme, token] = (authHeader ?? '').split(/\s+/, 2);
    const bearer = scheme?.toLowerCase() === 'bearer' ? token : null;

    if (!timingSafeTokenEqual(bearer, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  });

  app.post('/_kilo/google-oauth/token', async c => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = GoogleOAuthTokenRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', details: parsed.error.flatten().fieldErrors }, 400);
    }

    try {
      const token = await tokenProvider.getToken(parsed.data.capabilities);
      return c.json(token, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'google_oauth_token_fetch_failed';
      return c.json({ error: message }, 502);
    }
  });

  app.post('/_kilo/google-oauth/status', async c => {
    let payload: unknown = {};
    try {
      payload = await c.req.json();
    } catch {
      payload = {};
    }

    const parsed = GoogleOAuthStatusRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', details: parsed.error.flatten().fieldErrors }, 400);
    }

    try {
      const status = await tokenProvider.getStatus();
      return c.json(status, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'google_oauth_status_failed';
      return c.json({ error: message }, 502);
    }
  });
}
