import type { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../auth';
import { ulidSchema } from './schemas';
import {
  handleCreateMessage,
  handleEditMessage,
  handleDeleteMessage,
  handleExecuteAction,
} from './handler';

const listMessagesQuerySchema = z.object({
  before: ulidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerMessageRoutes(app: Hono<{ Bindings: Env; Variables: AuthContext }>): void {
  // POST /v1/messages — create message (returns clientId if present)
  app.post('/v1/messages', handleCreateMessage);

  // GET /v1/conversations/:id/messages — list messages
  app.get('/v1/conversations/:id/messages', async c => {
    const idParam = ulidSchema.safeParse(c.req.param('id'));
    if (!idParam.success) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }
    const conversationId = idParam.data;
    const callerId = c.get('callerId');

    const query = listMessagesQuerySchema.safeParse({
      before: c.req.query('before') || undefined,
      limit: c.req.query('limit') ?? 50,
    });
    if (!query.success) {
      return c.json({ error: 'Invalid query', issues: query.error.issues }, 400);
    }

    const convStub = c.env.CONVERSATION_DO.get(c.env.CONVERSATION_DO.idFromName(conversationId));

    if (!(await convStub.isMember(callerId))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const result = await convStub.listMessages({
      limit: query.data.limit,
      before: query.data.before,
    });

    return c.json({ messages: result.messages });
  });

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
