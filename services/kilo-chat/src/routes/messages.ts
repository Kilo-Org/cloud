import type { Hono } from 'hono';
import type { AuthContext } from '../auth';
import {
  handleCreateMessage,
  handleEditMessage,
  handleDeleteMessage,
  handleExecuteAction,
  handleListMessages,
} from './handler';

export function registerMessageRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  // POST /v1/messages — create message (returns clientId if present)
  app.post('/v1/messages', handleCreateMessage);

  // GET /v1/conversations/:conversationId/messages — list messages
  app.get('/v1/conversations/:conversationId/messages', handleListMessages);

  // PATCH /v1/messages/:messageId — edit message
  app.patch('/v1/messages/:messageId', handleEditMessage);

  // DELETE /v1/messages/:messageId — soft delete
  app.delete('/v1/messages/:messageId', handleDeleteMessage);

  // POST /v1/conversations/:conversationId/messages/:messageId/execute-action
  app.post(
    '/v1/conversations/:conversationId/messages/:messageId/execute-action',
    handleExecuteAction
  );
}
