import type { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { handleAddReaction, handleRemoveReaction } from './handler';

export function registerReactionsRoutes(
  app: Hono<{ Bindings: Env; Variables: AuthContext }>
): void {
  app.post('/v1/messages/:messageId/reactions', handleAddReaction);
  app.delete('/v1/messages/:messageId/reactions', handleRemoveReaction);
}
