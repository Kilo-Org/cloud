import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthContext } from '../auth';
import { registerConversationRoutes } from '../routes/conversations';
import {
  handleAddReaction,
  handleCreateMessage,
  handleDeleteMessage,
  handleEditMessage,
  handleExecuteAction,
  handleListMessages,
  handleRemoveReaction,
  handleSetTyping,
  handleStopTyping,
} from '../routes/handler';

/**
 * Build a test app that bypasses real JWT/API-key auth and injects
 * callerId / callerKind directly so we can unit-test route logic.
 */
export function makeApp(callerId: string, callerKind: 'user' | 'bot') {
  const mockAuth = createMiddleware<{ Bindings: Env; Variables: AuthContext }>(async (c, next) => {
    c.set('callerId', callerId);
    c.set('callerKind', callerKind);
    await next();
  });

  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/v1/*', mockAuth);
  registerConversationRoutes(app);

  app.post('/v1/messages', handleCreateMessage);
  app.get('/v1/conversations/:conversationId/messages', handleListMessages);
  app.patch('/v1/messages/:messageId', handleEditMessage);
  app.delete('/v1/messages/:messageId', handleDeleteMessage);
  app.post(
    '/v1/conversations/:conversationId/messages/:messageId/execute-action',
    handleExecuteAction
  );

  app.post('/v1/messages/:messageId/reactions', handleAddReaction);
  app.delete('/v1/messages/:messageId/reactions', handleRemoveReaction);

  app.post('/v1/conversations/:conversationId/typing', handleSetTyping);
  app.post('/v1/conversations/:conversationId/typing/stop', handleStopTyping);

  return app;
}
