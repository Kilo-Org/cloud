import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthContext } from '../auth';
import { registerConversationRoutes } from '../routes/conversations';
import { registerMessageRoutes } from '../routes/messages';
import { registerReactionsRoutes } from '../routes/reactions';
import { registerTypingRoutes } from '../routes/typing';

/**
 * Build a test app that bypasses real JWT/API-key auth and injects
 * callerId / callerKind directly so we can unit-test route logic.
 */
export function makeApp(
  callerId: string,
  callerKind: 'user' | 'bot',
  allowedSandboxIds: string[] = [],
) {
  const mockAuth = createMiddleware<{ Bindings: Env; Variables: AuthContext }>(async (c, next) => {
    c.set('callerId', callerId);
    c.set('callerKind', callerKind);
    c.set('allowedSandboxIds', allowedSandboxIds);
    await next();
  });

  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/v1/*', mockAuth);
  registerConversationRoutes(app);
  registerMessageRoutes(app);
  registerReactionsRoutes(app);
  registerTypingRoutes(app);
  return app;
}
