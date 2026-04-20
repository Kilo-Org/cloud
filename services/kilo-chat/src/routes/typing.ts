import type { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { handleSetTyping, handleStopTyping } from './handler';

export function registerTypingRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  app.post('/v1/conversations/:conversationId/typing', handleSetTyping);
  app.post('/v1/conversations/:conversationId/typing/stop', handleStopTyping);
}
