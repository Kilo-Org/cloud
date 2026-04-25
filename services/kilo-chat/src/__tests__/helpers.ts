import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
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

type HonoApp = Hono<{ Bindings: Env; Variables: AuthContext }>;

/**
 * Wraps a Hono app so `request()` and `fetch()` always supply a test
 * ExecutionContext from `cloudflare:test`. Route handlers call
 * `c.executionCtx.waitUntil()` unconditionally; the wrapper awaits any deferred
 * work before returning so isolated-storage cleanup between tests is safe.
 */
export function withTestExecutionCtx(app: HonoApp): HonoApp {
  const origRequest = app.request.bind(app);
  const origFetch = app.fetch.bind(app);
  app.request = async (input, requestInit, envArg, execCtx) => {
    if (execCtx) return origRequest(input, requestInit, envArg, execCtx);
    const ctx = createExecutionContext();
    const res = await origRequest(input, requestInit, envArg, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  app.fetch = async (request, envArg, execCtx) => {
    if (execCtx) return origFetch(request, envArg, execCtx);
    const ctx = createExecutionContext();
    const res = await origFetch(request, envArg, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  return app;
}

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

  const app: HonoApp = new Hono<{ Bindings: Env; Variables: AuthContext }>();
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

  return withTestExecutionCtx(app);
}
