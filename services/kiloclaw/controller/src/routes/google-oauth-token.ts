import { z } from 'zod';
import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

const GoogleOAuthTokenRequestSchema = z.object({
  capabilities: z.array(z.string().min(1)).default(['calendar_read']),
});

type TokenProvider = {
  getToken: (capabilities: readonly string[]) => Promise<{
    accessToken: string;
    expiresAt: string;
    accountEmail: string;
    scopes: string[];
  }>;
};

export function registerGoogleOAuthTokenRoutes(
  app: Hono,
  expectedToken: string,
  tokenProvider: TokenProvider
): void {
  app.use('/_kilo/google-oauth/*', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
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
}
