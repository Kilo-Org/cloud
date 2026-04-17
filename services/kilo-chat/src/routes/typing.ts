import type { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { handleSetTyping } from './handler';

export function registerTypingRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  // Human typing: returns {} (200)
  app.post(
    '/v1/conversations/:conversationId/typing',
    handleSetTyping(c => c.json({}))
  );
}
