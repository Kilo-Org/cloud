import { createMiddleware } from 'hono/factory';
import { extractBearerToken, verifyKiloToken } from '@kilocode/worker-utils';

export type AuthContext = {
  callerId: string;
  callerKind: 'user' | 'bot';
};

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AuthContext;
}>(async (c, next) => {
  const token = extractBearerToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Try API key auth first (cheap string comparison)
  const apiKey = await c.env.KILOCHAT_API_KEY.get();
  if (apiKey && token === apiKey) {
    const sandboxId = c.req.header('x-kilo-sandbox-id');
    if (!sandboxId) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('callerId', `bot:kiloclaw:${sandboxId}`);
    c.set('callerKind', 'bot');
    return next();
  }

  // Try JWT auth
  try {
    const jwtSecret = await c.env.NEXTAUTH_SECRET.get();
    if (!jwtSecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const payload = await verifyKiloToken(token, jwtSecret);
    c.set('callerId', payload.kiloUserId);
    c.set('callerKind', 'user');
    return next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
});
