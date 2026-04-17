import type { Hono } from 'hono';
import type { AuthContext } from '../auth';
import {
  handleCreateMessage,
  handleEditMessage,
  handleDeleteMessage,
  handleAddReaction,
  handleRemoveReaction,
  handleSetTyping,
} from './handler';

export function registerBotRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  // POST /bot/v1/sandboxes/:sandboxId/messages — create message (no clientId in response)
  app.post('/bot/v1/sandboxes/:sandboxId/messages', handleCreateMessage(false));

  // PATCH /bot/v1/sandboxes/:sandboxId/messages/:messageId — edit message
  app.patch('/bot/v1/sandboxes/:sandboxId/messages/:messageId', handleEditMessage('messageId'));

  // DELETE /bot/v1/sandboxes/:sandboxId/messages/:messageId — soft delete
  app.delete('/bot/v1/sandboxes/:sandboxId/messages/:messageId', handleDeleteMessage('messageId'));

  // POST /bot/v1/sandboxes/:sandboxId/conversations/:conversationId/typing — bot returns 204
  app.post(
    '/bot/v1/sandboxes/:sandboxId/conversations/:conversationId/typing',
    handleSetTyping('conversationId', () => new Response(null, { status: 204 }))
  );

  // POST /bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions — add reaction
  app.post(
    '/bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions',
    handleAddReaction('messageId')
  );

  // DELETE /bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions — remove reaction
  app.delete(
    '/bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions',
    handleRemoveReaction('messageId')
  );
}
