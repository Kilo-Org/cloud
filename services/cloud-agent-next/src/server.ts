import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './router.js';
import type { Env } from './types.js';
import type { HonoContext } from './hono-context.js';
import { logger, withLogTags } from './logger.js';
import { validateStreamTicket, validateKiloToken } from './auth.js';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { createCallbackQueueConsumer } from './callbacks/index.js';
import type { CallbackJob } from './callbacks/index.js';
import {
  CLOUD_AGENT_REPORT_QUEUE_NAMES,
  consumeCloudAgentReportBatch,
  removeExpiredCloudAgentReportData,
} from './telemetry/report-consumer.js';
import { authMiddleware } from './middleware/auth.js';
import { balanceMiddleware } from './middleware/balance.js';
import { resolveTerminalWrapperClient } from './terminal/access.js';
import { requestMethodAllowsBody } from './shared/http-proxy.js';
import { hasDuplicateQueryParameters } from './shared/http-query.js';
import {
  KILO_FACADE_AUTH_TOKEN_HEADER,
  KILO_FACADE_GLOBAL_FEED_PATH,
  KILO_FACADE_USER_ID_HEADER,
} from './kilo-facade/user-kilo-facade.js';

const app = new Hono<HonoContext>();

function isAllowedWebSocketOrigin(env: Env, origin: string | undefined): boolean {
  const allowedOrigins = (env.WS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const isRealOrigin = origin !== undefined && origin !== 'null';
  return allowedOrigins.length === 0 || !isRealOrigin || allowedOrigins.includes(origin);
}

// TODO: the name is not very clear. I thought it is a termination of a websocket, not that websocket is for PTY
async function handleTerminalWebSocket(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const url = new URL(request.url);
  const cloudAgentSessionId = url.searchParams.get('cloudAgentSessionId');
  if (!cloudAgentSessionId) {
    logger.warn('/terminal: Missing cloudAgentSessionId parameter');
    return new Response('Missing cloudAgentSessionId parameter', { status: 400 });
  }

  const ptyId = url.searchParams.get('ptyId');
  if (!ptyId) {
    logger.withFields({ cloudAgentSessionId }).warn('/terminal: Missing ptyId parameter');
    return new Response('Missing ptyId parameter', { status: 400 });
  }

  if (!isAllowedWebSocketOrigin(env, request.headers.get('Origin') ?? undefined)) {
    logger.withFields({ cloudAgentSessionId, ptyId }).warn('/terminal: Origin not allowed');
    return new Response('Origin not allowed', { status: 403 });
  }

  const ticket = url.searchParams.get('ticket');
  if (!ticket) {
    logger.withFields({ cloudAgentSessionId }).warn('/terminal: Missing ticket');
    return new Response('Missing ticket', { status: 401 });
  }

  const ticketResult = validateStreamTicket(ticket, env.NEXTAUTH_SECRET);
  if (!ticketResult.success) {
    logger
      .withFields({ cloudAgentSessionId, error: ticketResult.error })
      .warn('/terminal: Ticket validation failed');
    return new Response(ticketResult.error, { status: 401 });
  }

  const userId = ticketResult.payload.userId;
  if (!userId) {
    logger.withFields({ cloudAgentSessionId }).warn('/terminal: Invalid ticket - missing userId');
    return new Response('Invalid ticket: missing userId', { status: 401 });
  }

  if (ticketResult.payload.purpose !== 'terminal') {
    logger.withFields({ cloudAgentSessionId, userId }).warn('/terminal: Invalid ticket purpose');
    return new Response('Invalid ticket purpose', { status: 403 });
  }

  const ticketCloudAgentSessionId =
    ticketResult.payload.cloudAgentSessionId ?? ticketResult.payload.sessionId;
  if (ticketCloudAgentSessionId !== cloudAgentSessionId) {
    logger
      .withFields({ cloudAgentSessionId, ticketCloudAgentSessionId })
      .warn('/terminal: Session mismatch between URL and ticket');
    return new Response('Session mismatch', { status: 403 });
  }

  if (ticketResult.payload.ptyId !== ptyId) {
    logger.withFields({ cloudAgentSessionId, userId, ptyId }).warn('/terminal: PTY mismatch');
    return new Response('PTY mismatch', { status: 403 });
  }

  logger.withFields({ cloudAgentSessionId, userId, ptyId }).info('/terminal: WebSocket authorized');

  const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${cloudAgentSessionId}`);
  const stub = env.CLOUD_AGENT_SESSION.get(doId);
  const metadata = await stub.getMetadata();
  const terminal = await resolveTerminalWrapperClient({
    env,
    metadata,
    sessionId: cloudAgentSessionId,
  });
  if (!terminal.success || !terminal.data) {
    return new Response(terminal.error ?? 'Terminal unavailable', { status: 503 });
  }

  return terminal.data.client.connectTerminal(ptyId, request);
}

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

function createSanitizedForwardRequest(
  request: Request,
  url: string | URL,
  headers: Headers
): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
  };
  if (request.body && requestMethodAllowsBody(request.method)) {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

function stripPublicCredentialHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  sanitized.delete('Authorization');
  sanitized.delete('Cookie');
  sanitized.delete(KILO_FACADE_USER_ID_HEADER);
  sanitized.delete(KILO_FACADE_AUTH_TOKEN_HEADER);
  return sanitized;
}

async function routeToUserKiloFacade(
  c: Context<HonoContext>,
  userId: string,
  authToken: string
): Promise<Response> {
  const doId = c.env.USER_KILO_FACADE.idFromName(userId);
  const stub = c.env.USER_KILO_FACADE.get(doId);
  const headers = stripPublicCredentialHeaders(c.req.raw.headers);
  headers.set(KILO_FACADE_USER_ID_HEADER, userId);
  headers.set(KILO_FACADE_AUTH_TOKEN_HEADER, authToken);
  const request = createSanitizedForwardRequest(c.req.raw, c.req.url, headers);
  return stub.fetch(request);
}

async function routeAuthenticatedKiloFacade(c: Context<HonoContext>): Promise<Response> {
  const authResult = await validateKiloToken(
    c.req.header('Authorization') ?? null,
    c.env.NEXTAUTH_SECRET
  );
  if (!authResult.success) {
    return c.text(authResult.error, 401);
  }
  return routeToUserKiloFacade(c, authResult.userId, authResult.token);
}

app.all('/kilo', routeAuthenticatedKiloFacade);
app.all('/kilo/*', routeAuthenticatedKiloFacade);

// TODO: I think this and /terminal share a bit of code. Could be worth extracting to middleware or just a common method?
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

  if (ticketResult.payload.purpose && ticketResult.payload.purpose !== 'stream') {
    logger.withFields({ cloudAgentSessionId, userId }).warn('/stream: Invalid ticket purpose');
    return c.text('Invalid ticket purpose', 403);
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

app.get('/terminal', async (c: Context<HonoContext>) => {
  return handleTerminalWebSocket(c.req.raw, c.env);
});

app.all('/sessions/:userId/:sessionId/kilo-global-ingest', async (c: Context<HonoContext>) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const rawUserId = c.req.param('userId');
  const cloudAgentSessionId = c.req.param('sessionId');
  if (!rawUserId || !cloudAgentSessionId) {
    return c.text('Missing route params', 400);
  }

  let userId: string;
  try {
    userId = decodeURIComponent(rawUserId);
  } catch {
    return c.text('Invalid userId encoding', 400);
  }

  const authResult = await validateKiloToken(
    c.req.header('Authorization') ?? null,
    c.env.NEXTAUTH_SECRET
  );
  if (!authResult.success) {
    return c.text(authResult.error, 401);
  }
  if (authResult.userId !== userId) {
    return c.text('Token does not match session user', 403);
  }

  const url = new URL(c.req.url);
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return c.text('Invalid global feed producer identity', 400);
  }
  const kiloSessionId = url.searchParams.get('kiloSessionId');
  const wrapperRunId = url.searchParams.get('wrapperRunId');
  const wrapperGenerationParam = url.searchParams.get('wrapperGeneration');
  const wrapperConnectionId = url.searchParams.get('wrapperConnectionId');
  const wrapperGeneration = wrapperGenerationParam ? Number(wrapperGenerationParam) : NaN;

  if (
    !kiloSessionId ||
    !wrapperRunId ||
    !Number.isInteger(wrapperGeneration) ||
    wrapperGeneration < 0 ||
    !wrapperConnectionId
  ) {
    return c.text('Invalid global feed producer identity', 400);
  }

  const sessionDoId = c.env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${cloudAgentSessionId}`);
  const sessionStub = c.env.CLOUD_AGENT_SESSION.get(sessionDoId);
  const validation = await sessionStub.validateKiloGlobalFeedProducer({
    kiloSessionId,
    wrapperRunId,
    wrapperGeneration,
    wrapperConnectionId,
  });
  if (!validation.success) {
    return new Response(validation.message, { status: validation.status });
  }

  const facadeId = c.env.USER_KILO_FACADE.idFromName(userId);
  const facadeStub = c.env.USER_KILO_FACADE.get(facadeId);
  const facadeUrl = new URL(c.req.url);
  facadeUrl.pathname = KILO_FACADE_GLOBAL_FEED_PATH;
  facadeUrl.search = '';
  facadeUrl.searchParams.set('userId', userId);
  facadeUrl.searchParams.set('cloudAgentSessionId', cloudAgentSessionId);
  facadeUrl.searchParams.set('kiloSessionId', kiloSessionId);
  facadeUrl.searchParams.set('wrapperRunId', wrapperRunId);
  facadeUrl.searchParams.set('wrapperGeneration', String(wrapperGeneration));
  facadeUrl.searchParams.set('wrapperConnectionId', wrapperConnectionId);

  const headers = stripPublicCredentialHeaders(c.req.raw.headers);
  const request = createSanitizedForwardRequest(c.req.raw, facadeUrl, headers);
  return facadeStub.fetch(request);
});

app.all('/sessions/:userId/:sessionId/ingest', async (c: Context<HonoContext>) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const rawUserId = c.req.param('userId');
  const sessionId = c.req.param('sessionId');
  if (!rawUserId || !sessionId) {
    return c.text('Missing route params', 400);
  }

  let userId: string;
  try {
    userId = decodeURIComponent(rawUserId);
  } catch {
    return c.text('Invalid userId encoding', 400);
  }

  const authHeader = c.req.header('Authorization');
  const authResult = await validateKiloToken(authHeader ?? null, c.env.NEXTAUTH_SECRET);
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

const ALLOWED_LOG_FILENAMES = new Set(['logs.tar.gz']);
const MAX_LOG_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

app.put(
  '/sessions/:userId/:sessionId/logs/:executionId/:filename',
  async (c: Context<HonoContext>) => {
    const rawUserId = c.req.param('userId');
    const filename = c.req.param('filename');
    const sessionId = c.req.param('sessionId');
    const executionId = c.req.param('executionId');
    if (!rawUserId || !filename || !sessionId || !executionId) {
      return c.text('Missing route params', 400);
    }

    let userId: string;
    try {
      userId = decodeURIComponent(rawUserId);
    } catch {
      return c.text('Invalid userId encoding', 400);
    }

    if (!ALLOWED_LOG_FILENAMES.has(filename)) {
      return c.text('Invalid filename', 400);
    }

    const authHeader = c.req.header('Authorization');
    const authResult = await validateKiloToken(authHeader ?? null, c.env.NEXTAUTH_SECRET);
    if (!authResult.success) {
      return c.text(authResult.error, 401);
    }
    if (authResult.userId !== userId) {
      return c.text('Token does not match session user', 403);
    }

    const contentLength = parseInt(c.req.header('Content-Length') ?? '', 10);
    if (contentLength > MAX_LOG_UPLOAD_BYTES) {
      return c.text('Request body too large', 413);
    }

    // Buffer the body — R2 requires a known-length value (ArrayBuffer, string, etc.)
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) {
      return c.text('Missing request body', 400);
    }
    if (body.byteLength > MAX_LOG_UPLOAD_BYTES) {
      return c.text('Request body too large', 413);
    }

    const safeUserId = encodeURIComponent(userId);
    const safeSessionId = encodeURIComponent(sessionId);
    const safeExecutionId = encodeURIComponent(executionId);

    try {
      await c.env.R2_BUCKET.put(
        `logs/${safeUserId}/${safeSessionId}/${safeExecutionId}/${filename}`,
        body,
        { httpMetadata: { contentType: 'application/gzip' } }
      );
    } catch (err) {
      logger
        .withFields({ error: err instanceof Error ? err.message : String(err) })
        .error('R2 put failed for log upload');
      return c.text('R2 write failed', 500);
    }

    return c.body(null, 204);
  }
);

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

app.notFound(createNotFoundHandler());
app.onError(createErrorHandler(logger, { includeMessage: false }));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname === '/terminal' &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      return handleTerminalWebSocket(request, env);
    }

    return app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue.startsWith('cloud-agent-next-callback-queue')) {
      const consumer = createCallbackQueueConsumer();
      return consumer(batch as MessageBatch<CallbackJob>);
    }
    if (CLOUD_AGENT_REPORT_QUEUE_NAMES.has(batch.queue)) {
      return consumeCloudAgentReportBatch(batch, env);
    }

    logger.warn(`Received message from unexpected queue: ${batch.queue}`);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await removeExpiredCloudAgentReportData(env);
  },
};

export { Sandbox } from '@cloudflare/sandbox';
export { CloudAgentSession } from './persistence/CloudAgentSession.js';
export { UserKiloFacade } from './kilo-facade/user-kilo-facade.js';
