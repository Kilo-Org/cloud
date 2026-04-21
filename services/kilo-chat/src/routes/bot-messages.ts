import type { Hono } from 'hono';
import type { AuthContext } from '../auth';
import {
  handleCreateMessage,
  handleEditMessage,
  handleDeleteMessage,
  handleAddReaction,
  handleRemoveReaction,
  handleSetTyping,
  handleStopTyping,
  handleListMessages,
  handleGetMembers,
} from './handler';

export function registerBotRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  app.post('/bot/v1/sandboxes/:sandboxId/messages', handleCreateMessage);
  app.patch('/bot/v1/sandboxes/:sandboxId/messages/:messageId', handleEditMessage);
  app.delete('/bot/v1/sandboxes/:sandboxId/messages/:messageId', handleDeleteMessage);
  app.post('/bot/v1/sandboxes/:sandboxId/conversations/:conversationId/typing', handleSetTyping);
  app.post(
    '/bot/v1/sandboxes/:sandboxId/conversations/:conversationId/typing/stop',
    handleStopTyping
  );
  app.post('/bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions', handleAddReaction);
  app.delete('/bot/v1/sandboxes/:sandboxId/messages/:messageId/reactions', handleRemoveReaction);
  app.get(
    '/bot/v1/sandboxes/:sandboxId/conversations/:conversationId/messages',
    handleListMessages
  );
  app.get('/bot/v1/sandboxes/:sandboxId/conversations/:conversationId/members', handleGetMembers);
}
