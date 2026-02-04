import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './router.js';
import type { Env } from './types.js';
import type { HonoContext } from './hono-context.js';
import { logger, withLogTags } from './logger.js';
import { validateStreamTicket, validateKiloToken } from './auth.js';
import { createCallbackQueueConsumer } from './callbacks/index.js';
import type { CallbackJob } from './callbacks/index.js';
import { authMiddleware } from './middleware/auth.js';
import { balanceMiddleware } from './middleware/balance.js';

const app = new Hono<HonoContext>();

app.use('*', async (c: Context<HonoContext>, next: Next) => {
  await withLogTags({ source: 'worker-entry' }, async () => {
    const url = new URL(c.req.url);
    logger.setTags({ method: c.req.method, path: url.pathname });
    logger.info('Handling request');
    await next();
  });
});

app.get('/health', (c: Context<HonoContext>) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.get('/stream', async (c: Context<HonoContext>) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const url = new URL(c.req.url);
  const cloudAgentSessionId = url.searchParams.get('cloudAgentSessionId');
  if (!cloudAgentSessionId) {
    logger.warn('/stream: Missing cloudAgentSessionId parameter');
    return c.text('Missing cloudAgentSessionId parameter', 400);
  }

  const ticket = url.searchParams.get('ticket');
  if (!ticket) {
    logger.withFields({ cloudAgentSessionId }).warn('/stream: Missing ticket');
    return c.text('Missing ticket', 401);
  }

  const ticketResult = validateStreamTicket(ticket, c.env.NEXTAUTH_SECRET);
  if (!ticketResult.success) {
    logger
      .withFields({ cloudAgentSessionId, error: ticketResult.error })
      .warn('/stream: Ticket validation failed');
    return c.text(ticketResult.error, 401);
  }

  const userId = ticketResult.payload.userId;
  if (!userId) {
    logger.withFields({ cloudAgentSessionId }).warn('/stream: Invalid ticket - missing userId');
    return c.text('Invalid ticket: missing userId', 401);
  }

  const ticketCloudAgentSessionId =
    ticketResult.payload.cloudAgentSessionId ?? ticketResult.payload.sessionId;
  if (ticketCloudAgentSessionId !== cloudAgentSessionId) {
    logger
      .withFields({ cloudAgentSessionId, ticketCloudAgentSessionId })
      .warn('/stream: Session mismatch between URL and ticket');
    return c.text('Session mismatch', 403);
  }

  logger.withFields({ cloudAgentSessionId, userId }).info('/stream: WebSocket upgrade authorized');

  const doId = c.env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${cloudAgentSessionId}`);
  const stub = c.env.CLOUD_AGENT_SESSION.get(doId);
  return stub.fetch(c.req.raw);
});

app.all('/sessions/:userId/:sessionId/ingest', async (c: Context<HonoContext>) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  let userId: string;
  try {
    userId = decodeURIComponent(c.req.param('userId'));
  } catch {
    return c.text('Invalid userId encoding', 400);
  }

  const sessionId = c.req.param('sessionId');
  const authHeader = c.req.header('Authorization');
  const authResult = validateKiloToken(authHeader ?? null, c.env.NEXTAUTH_SECRET);
  if (!authResult.success) {
    return c.text(authResult.error, 401);
  }
  if (authResult.userId !== userId) {
    return c.text('Token does not match session user', 403);
  }

  const doId = c.env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
  const stub = c.env.CLOUD_AGENT_SESSION.get(doId);
  const doUrl = new URL(c.req.url);
  doUrl.pathname = '/ingest';
  const doRequest = new Request(doUrl.toString(), c.req.raw);
  return stub.fetch(doRequest);
});

app.use('/trpc/*', authMiddleware);
app.use('/trpc/*', balanceMiddleware);

app.use(
  '/trpc/*',
  trpcServer({
    router: appRouter,
    endpoint: '/trpc',
    createContext: (_opts: unknown, c: Context<HonoContext>) => ({
      env: c.env,
      userId: c.get('userId'),
      authToken: c.get('authToken'),
      botId: c.get('botId'),
      request: c.req.raw,
    }),
    onError: ({ error, path }: { error: Error; path?: string }) => {
      logger.setTags({ path });
      logger
        .withFields({
          error: error.message,
          stack: error.stack,
        })
        .error('tRPC error');
    },
  })
);

app.notFound((c: Context<HonoContext>) => {
  return c.json({ error: 'Not found' }, 404);
});

app.onError((err: Error, c: Context<HonoContext>) => {
  logger
    .withFields({
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    .error('Unhandled error');

  return c.json({ error: 'Internal server error' }, 500);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, _env: Env): Promise<void> {
    if (batch.queue.startsWith('cloud-agent-next-callback-queue')) {
      const consumer = createCallbackQueueConsumer();
      return consumer(batch as MessageBatch<CallbackJob>);
    }

    logger.warn(`Received message from unexpected queue: ${batch.queue}`);
  },
};

export { Sandbox } from '@cloudflare/sandbox';
export { CloudAgentSession } from './persistence/CloudAgentSession.js';
