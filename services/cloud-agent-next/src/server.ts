import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './router.js';
import type { Env } from './types.js';
import type { HonoContext } from './hono-context.js';
import { logger, withLogTags } from './logger.js';
import {
  resolveSecret,
  validateStreamTicket,
  STREAM_TICKET_AUDIENCE,
  TERMINAL_TICKET_AUDIENCE,
} from './auth.js';
import { validateKiloToken } from './validate-kilo-token.js';
import { consumeStreamTicketNonce } from './persistence/StreamTicketNonceDO.js';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import { createCallbackQueueConsumer } from './callbacks/index.js';
import type { CallbackJob } from './callbacks/index.js';
import {
  CLOUD_AGENT_REPORT_QUEUE_NAMES,
  consumeCloudAgentReportBatch,
  removeExpiredCloudAgentReportData,
} from './telemetry/report-consumer.js';
import { runCloudAgentOutcomeCollection } from './telemetry/outcome-aggregate.js';
import { runCloudAgentOpenStockCollection } from './telemetry/open-stock.js';
import { authMiddleware } from './middleware/auth.js';
import { balanceMiddleware } from './middleware/balance.js';
import { requestMethodAllowsBody } from './shared/http-proxy.js';
import { projectSessionAccessHttpError, requireCurrentSessionAccess } from './session-access.js';
import { timingSafeEqual } from '@kilocode/encryption';
import { and, eq, isNotNull } from 'drizzle-orm';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { getPgDb } from './db/pg.js';
import {
  KILO_FACADE_AUTH_TOKEN_HEADER,
  KILO_FACADE_USER_ID_HEADER,
} from './kilo-facade/user-kilo-facade.js';
import { getSandboxSessionStub } from './sandbox-session/session-stub.js';
import { isControlSession } from './session-identity.js';
import { PREVIEW_OPEN_PATH, handlePreviewOpen, handlePreviewRequest } from './preview/route.js';
import { matchPreviewHost } from './preview/host.js';
import { withoutPreviewMarkers } from './shared/preview-headers.js';
import { withDORetry } from './utils/do-retry.js';
import { parseBearerCredential } from './sandbox-control/credential.js';
import { admitSandboxWrapperUpgrade } from './sandbox-control/socket-admission.js';
import { PtyIdSchema, sessionIdSchema } from './router/schemas.js';
import { registerRuntimeArtifactRoutes } from './sandbox-control/runtime-artifact-routes.js';
import { registerStartupFailureRoute } from './sandbox-control/startup-failure.js';
import { registerControlLogRoutes } from './sandbox-control/log-routes.js';
import {
  runtimeCredentialProxyFacadeBaseUrl,
  runtimeCredentialProxyUpstream,
  type RuntimeProxyHandleClaims,
  verifyRuntimeCredentialProxyHandle,
} from './runtime-credential-proxy.js';
import { logRuntimeProxyRequestFailed } from './runtime-credential-proxy-diagnostics.js';
import { deriveKiloSandboxTargets } from './kilo/kilo-targets.js';
import {
  inferRuntimeCredentialProxyRoute,
  resolveRuntimeCredentialProxyScopeIngestRoute,
  resolveRuntimeCredentialProxyScopedIngestRoute,
  type RuntimeCredentialProxyRoute,
} from './kilo/runtime-credential-proxy-routes.js';
import {
  encodeCloudAgentSessionScopeV2ViewHeaders,
  forwardCloudAgentSessionScopeRequest,
  forwardCloudAgentSessionScopeV2Request,
} from './cloud-agent-session-scope-proxy.js';
import type { ScopeGrantView } from './control-plane/sandbox/scope-view.js';
import {
  issueRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_HEADER,
  type RuntimeProxyAttestationAudience,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { TRPCError } from '@trpc/server';
import {
  readWidgetApprovalKey,
  widgetApprovalKeyRequestSchema,
  type WidgetApproval,
} from './widget-approval-key.js';

const app = new Hono<HonoContext>();

function isAllowedWebSocketOrigin(env: Env, origin: string | undefined): boolean {
  const allowedOrigins = (env.WS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const isRealOrigin = origin !== undefined && origin !== 'null';
  return allowedOrigins.length === 0 || !isRealOrigin || allowedOrigins.includes(origin);
}

function createTerminalForwardRequest(
  request: Request,
  pathname: '/terminal/browser' | '/terminal/wrapper',
  ptyId: string,
  authorization?: string
): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  url.searchParams.set('ptyId', ptyId);

  const headers = new Headers();
  for (const name of ['Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (authorization !== undefined) headers.set('Authorization', authorization);

  return new Request(url, { method: 'GET', headers });
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
  if (!PtyIdSchema.safeParse(ptyId).success) {
    logger.withFields({ cloudAgentSessionId }).warn('/terminal: Invalid ptyId parameter');
    return new Response('Invalid ptyId parameter', { status: 400 });
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

  const nextAuthSecret = await resolveSecret(env.NEXTAUTH_SECRET);
  const ticketResult = validateStreamTicket(ticket, nextAuthSecret, TERMINAL_TICKET_AUDIENCE);
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

  if (!isControlSession(cloudAgentSessionId)) {
    logger.withFields({ cloudAgentSessionId, userId }).warn('/terminal: Legacy session rejected');
    return new Response('Not found', { status: 404 });
  }

  try {
    await requireCurrentSessionAccess({
      env,
      kiloUserId: userId,
      cloudAgentSessionId,
      expectedOrganizationId: ticketResult.payload.organizationId ?? null,
      expectedKiloSessionId: ticketResult.payload.kiloSessionId,
    });
  } catch (error) {
    return projectSessionAccessHttpError(error);
  }

  const nonce = ticketResult.payload.nonce;
  if (!nonce) {
    logger.withFields({ cloudAgentSessionId, userId }).warn('/terminal: Missing ticket nonce');
    return new Response('Missing ticket nonce', { status: 401 });
  }
  const consumed = await consumeStreamTicketNonce(
    env,
    nonce,
    (ticketResult.payload as unknown as { exp: number }).exp * 1000
  );
  if (!consumed) {
    logger.withFields({ cloudAgentSessionId, userId }).warn('/terminal: Ticket nonce already used');
    return new Response('Ticket nonce already used', { status: 401 });
  }

  logger.withFields({ cloudAgentSessionId, userId, ptyId }).info('/terminal: WebSocket authorized');

  return getSandboxSessionStub(env, userId, cloudAgentSessionId).fetch(
    createTerminalForwardRequest(request, '/terminal/browser', ptyId)
  );
}

app.use('*', async (c: Context<HonoContext>, next: Next) => {
  await withLogTags({ source: 'worker-entry' }, async () => {
    const url = new URL(c.req.url);
    logger.setTags({ method: c.req.method, path: url.pathname });
    logger.info('Handling request');
    await next();
  });
});

// Kilo 7.4.20 and current releases both append their own `/api/...` route to
// configured targets. Only a verified opaque handle may turn that otherwise
// ordinary Worker path into a facade request.
app.use('*', async (c: Context<HonoContext>, next: Next) => {
  const facadeBase = c.env.WORKER_URL
    ? runtimeCredentialProxyFacadeBaseUrl(c.env.WORKER_URL)
    : null;
  if (!facadeBase) return next();
  const facadePath = new URL(facadeBase).pathname.replace(/\/+$/, '');
  const requestPath = new URL(c.req.url).pathname;
  const path = facadePath
    ? requestPath.startsWith(`${facadePath}/`)
      ? requestPath.slice(facadePath.length)
      : null
    : requestPath;
  if (!path) return next();
  // This route remains available for already-issued configurations. A prefixed
  // deployment never supported it because Hono registers the legacy route at
  // the Worker root; root deployments retain the transition behavior.
  if (path.startsWith('/api/runtime-credential-proxy/')) return next();
  const handle = runtimeProxyAuthorization(c.req.raw);
  if (!handle) return next();
  const claims = await verifyRuntimeCredentialProxyHandle(c.env, handle);
  if (!claims) return next();
  const route = inferRuntimeCredentialProxyRoute(path);
  if (!route) return c.text('Not found', 404);
  return forwardRuntimeCredentialProxy(c, handle, claims, route, path);
});

app.get('/health', (c: Context<HonoContext>) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Handle authentication is bearer-only; the URL contains neither a credential
// nor an upstream authority. Register before the broad facade routes.
app.all('/api/runtime-credential-proxy/:route/*', routeRuntimeCredentialProxy);

function requireInternalApi(c: Context<HonoContext>): Response | null {
  if (!c.env.INTERNAL_API_SECRET) {
    return c.text('Internal API secret not configured', 500);
  }
  const internalApiKey = c.req.header('x-internal-api-key');
  if (!internalApiKey || !timingSafeEqual(internalApiKey, c.env.INTERNAL_API_SECRET)) {
    return c.text('Invalid or missing internal API key', 401);
  }
  return null;
}

registerControlLogRoutes(app);
registerRuntimeArtifactRoutes(app);
registerStartupFailureRoute(app);

app.get('/sandbox-control/:sandboxId', async (c: Context<HonoContext>) => {
  return admitSandboxWrapperUpgrade(c.req.raw, c.env, c.req.param('sandboxId') ?? '');
});

app.get('/sandbox-terminal/:ownerId/:sessionId/:ptyId', async (c: Context<HonoContext>) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const ownerId = c.req.param('ownerId');
  const sessionId = c.req.param('sessionId');
  const ptyId = c.req.param('ptyId');
  if (!ownerId) {
    return c.text('Invalid ownerId', 400);
  }
  if (!sessionId || !sessionIdSchema.safeParse(sessionId).success) {
    return c.text('Invalid sessionId', 400);
  }
  if (!isControlSession(sessionId)) {
    return c.text('Invalid sessionId', 400);
  }
  if (!ptyId || !PtyIdSchema.safeParse(ptyId).success) {
    return c.text('Invalid ptyId', 400);
  }

  const authorization = c.req.header('Authorization');
  if (!authorization || parseBearerCredential(authorization) === null) {
    return c.text('Invalid or missing Authorization header', 401);
  }

  const stub = getSandboxSessionStub(c.env, ownerId, sessionId);
  return stub.fetch(
    createTerminalForwardRequest(c.req.raw, '/terminal/wrapper', ptyId, authorization)
  );
});

function createSanitizedForwardRequest(
  request: Request,
  url: string | URL,
  headers: Headers,
  body?: BodyInit
): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
  };
  if ((body !== undefined || request.body) && requestMethodAllowsBody(request.method)) {
    init.body = body ?? request.body;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

function runtimeProxyAuthorization(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  const match = authorization ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization) : null;
  return match?.[1] ?? null;
}

function runtimeProxyHeaders(request: Request, token: string, organizationId?: string): Headers {
  const headers = new Headers(request.headers);
  for (const name of [
    'Authorization',
    'X-API-Key',
    'API-Key',
    'X-Auth-Token',
    'Cookie',
    'Host',
    'Connection',
    'Proxy-Connection',
    'Keep-Alive',
    'Proxy-Authenticate',
    'Proxy-Authorization',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
    'X-Kilocode-OrganizationId',
  ]) {
    headers.delete(name);
  }
  const attributionHeaders = new Set([
    'x-kilocode-feature',
    'x-kilocode-editorname',
    'x-kilocode-mode',
    'x-kilocode-machineid',
    'x-kilocode-taskid',
    'x-kilocode-projectid',
    'x-kilocode-version',
    'x-kilo-session',
    'x-kilo-request',
  ]);
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith('proxy-') ||
      name.startsWith('x-forwarded-') ||
      name.startsWith('x-internal-') ||
      ((name.startsWith('x-kilo-') || name.startsWith('x-kilocode-')) &&
        !attributionHeaders.has(name)) ||
      name === 'forwarded' ||
      name === 'x-real-ip' ||
      name === 'x-kilocode-organizationid'
    ) {
      headers.delete(name);
    }
  }
  headers.set('Authorization', `Bearer ${token}`);
  if (organizationId) headers.set('X-Kilocode-OrganizationId', organizationId);
  return headers;
}

function sanitizeRuntimeProxyResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of [
    'Set-Cookie',
    'Connection',
    'Proxy-Connection',
    'Keep-Alive',
    'Proxy-Authenticate',
    'Proxy-Authorization',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
  ]) {
    headers.delete(name);
  }
  headers.delete(RUNTIME_PROXY_ATTESTATION_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let value = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return value + decoder.decode();
      const bytes = new Uint8Array(chunk.value);
      size += bytes.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        return null;
      }
      value += decoder.decode(bytes, { stream: true });
    }
  } catch {
    return null;
  }
}

async function routeRuntimeCredentialProxy(c: Context<HonoContext>): Promise<Response> {
  const handle = runtimeProxyAuthorization(c.req.raw);
  if (!handle) return c.text('Unauthorized', 401);
  const claims = await verifyRuntimeCredentialProxyHandle(c.env, handle);
  if (!claims) return c.text('Unauthorized', 401);
  const route = c.req.param('route');
  const prefix = `/api/runtime-credential-proxy/${route}/`;
  const requestPath = new URL(c.req.url).pathname;
  if (!requestPath.startsWith(prefix)) return c.text('Not found', 404);
  const path = `/${requestPath.slice(prefix.length).replace(/^\/+/, '')}`;
  if (route !== 'backend' && route !== 'provider' && route !== 'ingest' && route !== 'exa')
    return c.text('Not found', 404);
  return forwardRuntimeCredentialProxy(c, handle, claims, route, path);
}

async function forwardRuntimeCredentialProxy(
  c: Context<HonoContext>,
  handle: string,
  claims: RuntimeProxyHandleClaims,
  route: RuntimeCredentialProxyRoute,
  path: string
): Promise<Response> {
  if (!claims) return c.text('Unauthorized', 401);
  let bodyText: string | undefined;
  if (route === 'ingest' && path === '/api/session' && c.req.method === 'POST') {
    bodyText = (await readBoundedBody(c.req.raw, 8192)) ?? undefined;
    if (bodyText === undefined) return c.text('Not found', 404);
  }
  let credential: {
    token: string;
    organizationId?: string;
    runtimeAuthorization: { userId: string; authorizationId: string; resourceId: string };
    scopeView?: ScopeGrantView;
  } | null;
  try {
    credential = await withDORetry(
      () => getSandboxSessionStub(c.env, claims.userId, claims.sessionId),
      session => session.resolveRuntimeCredentialProxyGrant(handle),
      'resolveRuntimeCredentialProxyGrant'
    );
  } catch {
    return c.text('Credential unavailable', 503);
  }
  if (!credential) return c.text('Unauthorized', 401);
  const targets = deriveKiloSandboxTargets(c.env, credential.token, { requireHttps: true });
  if (!targets.success) return c.text('Not found', 404);

  const search = new URL(c.req.url).search;
  const scopeView = route === 'ingest' ? credential.scopeView : undefined;
  let scopedV1 = false;
  let scopedV2Headers: Record<string, string> | null = null;
  let upstream: URL | null;
  if (scopeView !== undefined) {
    const adopted = resolveRuntimeCredentialProxyScopeIngestRoute({
      targets: targets.targets,
      route,
      method: c.req.method,
      pathname: path,
      search,
      memberRootKiloSessionIds: scopeView.memberRootKiloSessionIds,
      organizationId: credential.organizationId,
      contentType: c.req.header('content-type'),
      bodyText,
    });
    if (adopted === null) return c.text('Not found', 404);
    upstream = adopted.upstream;
    if (adopted.kind === 'scoped') {
      const v2Headers = encodeCloudAgentSessionScopeV2ViewHeaders(scopeView);
      if (v2Headers === null) return c.text('Credential unavailable', 503);
      scopedV2Headers = v2Headers;
    }
  } else {
    const scopedUpstream = resolveRuntimeCredentialProxyScopedIngestRoute({
      targets: targets.targets,
      route,
      method: c.req.method,
      pathname: path,
      search,
      kiloSessionId: claims.kiloSessionId,
      organizationId: credential.organizationId,
      contentType: c.req.header('content-type'),
      bodyText,
    });
    scopedV1 = scopedUpstream !== null;
    upstream =
      scopedUpstream ??
      runtimeCredentialProxyUpstream(
        targets.targets,
        route,
        c.req.method,
        path,
        search,
        claims.kiloSessionId,
        credential.organizationId,
        c.req.header('content-type'),
        bodyText
      );
  }
  if (!upstream) return c.text('Not found', 404);
  try {
    // The route allowlist is resolved above before a proof is issued.
    const audience: RuntimeProxyAttestationAudience =
      route === 'backend' ? 'kilo-api' : route === 'ingest' ? 'session-ingest' : 'kilo-gateway';
    const proof = await issueRuntimeProxyAttestation({
      secret: await resolveSecret(c.env.NEXTAUTH_SECRET).then(value => {
        if (!value) throw new Error('Authentication unavailable');
        return value;
      }),
      audience,
      bearer: credential.token,
      ...credential.runtimeAuthorization,
    });
    const headers = runtimeProxyHeaders(c.req.raw, credential.token, credential.organizationId);
    headers.set(RUNTIME_PROXY_ATTESTATION_HEADER, proof);
    const request = createSanitizedForwardRequest(c.req.raw, upstream, headers, bodyText);
    const response =
      scopedV2Headers !== null
        ? await forwardCloudAgentSessionScopeV2Request(request, c.env, {
            authorization: `Bearer ${credential.token}`,
            scopeHeaders: scopedV2Headers,
            runtimeProxyAttestation: proof,
          })
        : scopedV1
          ? await forwardCloudAgentSessionScopeRequest(request, c.env, {
              authorization: `Bearer ${credential.token}`,
              sessionIngestScope: {
                cloudAgentSessionId: claims.sessionId,
                rootKiloSessionId: claims.kiloSessionId,
              },
              runtimeProxyAttestation: proof,
            })
          : await fetch(request, { redirect: 'manual' });
    if (!response.ok) {
      logRuntimeProxyRequestFailed({
        upstreamAttempted: true,
        upstreamStatus: response.status,
        sessionId: claims.sessionId,
        kiloSessionId: claims.kiloSessionId,
      });
    }
    return sanitizeRuntimeProxyResponse(response);
  } catch {
    return c.text('Upstream unavailable', 502);
  }
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
  const nextAuthSecret = await resolveSecret(c.env.NEXTAUTH_SECRET);
  const authResult = await validateKiloToken(c.req.header('Authorization') ?? null, {
    secret: nextAuthSecret,
    connectionString: c.env.HYPERDRIVE.connectionString,
  });
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

  const nextAuthSecret = await resolveSecret(c.env.NEXTAUTH_SECRET);
  const ticketResult = validateStreamTicket(ticket, nextAuthSecret, STREAM_TICKET_AUDIENCE);
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

  if (!isControlSession(cloudAgentSessionId)) {
    logger.withFields({ cloudAgentSessionId, userId }).warn('/stream: Legacy session rejected');
    return c.text('Not found', 404);
  }

  try {
    await requireCurrentSessionAccess({
      env: c.env,
      kiloUserId: userId,
      cloudAgentSessionId,
      expectedOrganizationId: ticketResult.payload.organizationId ?? null,
      expectedKiloSessionId: ticketResult.payload.kiloSessionId,
    });
  } catch (error) {
    return projectSessionAccessHttpError(error);
  }

  const nonce = ticketResult.payload.nonce;
  if (!nonce) {
    logger.withFields({ cloudAgentSessionId, userId }).warn('/stream: Missing ticket nonce');
    return c.text('Missing ticket nonce', 401);
  }
  const consumed = await consumeStreamTicketNonce(
    c.env,
    nonce,
    (ticketResult.payload as unknown as { exp: number }).exp * 1000
  );
  if (!consumed) {
    logger.withFields({ cloudAgentSessionId, userId }).warn('/stream: Ticket nonce already used');
    return c.text('Ticket nonce already used', 401);
  }

  logger.withFields({ cloudAgentSessionId, userId }).info('/stream: WebSocket upgrade authorized');

  return getSandboxSessionStub(c.env, userId, cloudAgentSessionId).fetch(c.req.raw);
});

app.get('/terminal', async (c: Context<HonoContext>) => {
  return handleTerminalWebSocket(c.req.raw, c.env);
});

app.post('/internal/streams/close', async (c: Context<HonoContext>) => {
  const unauthorized = requireInternalApi(c);
  if (unauthorized) return unauthorized;

  const body = (await c.req.json().catch(() => null)) as {
    userId?: unknown;
    organizationId?: unknown;
  } | null;
  const userId = body?.userId;
  const organizationId = body?.organizationId;
  if (
    typeof userId !== 'string' ||
    userId.length === 0 ||
    typeof organizationId !== 'string' ||
    organizationId.length === 0
  ) {
    return c.text('Invalid request', 400);
  }

  const db = getPgDb(c.env);
  const rows = await db
    .select({ cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, userId),
        eq(cli_sessions_v2.organization_id, organizationId),
        isNotNull(cli_sessions_v2.cloud_agent_session_id)
      )
    );

  for (const row of rows) {
    const sessionId = row.cloudAgentSessionId;
    if (!sessionId || !isControlSession(sessionId)) continue;
    await getSandboxSessionStub(c.env, userId, sessionId).closeOrgStreams(organizationId);
  }

  return c.body(null, 204);
});

// Home widget identity read for the trusted web backend only: the internal key
// gates the route, the body names the exact owned session, and the response
// carries a one-way binding plus the pending request's command as one trimmed
// line, never the raw permission or any mutation authority.
app.post('/internal/widgets/approval-key', async (c: Context<HonoContext>) => {
  const unauthorized = requireInternalApi(c);
  if (unauthorized) return unauthorized;

  const parsed = widgetApprovalKeyRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.text('Invalid request', 400);
  }

  let approval: WidgetApproval;
  try {
    approval = await readWidgetApprovalKey(c.env, parsed.data);
  } catch (error) {
    // Ownership refusals (403) and an unavailable access read (503) come from
    // `requireCurrentSessionAccess`; anything else is a DO failure (500).
    if (error instanceof TRPCError) return projectSessionAccessHttpError(error);
    throw error;
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ approvalKey: approval.approvalKey, command: approval.command });
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
      validatedSessionAccess: c.get('validatedSessionAccess'),
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

export const REPORT_RETENTION_CRON = '17 2 * * *';
export const OUTCOME_AGGREGATE_CRON = '*/5 * * * *';
// Cloudflare has been observed to keep firing a previously configured `*/3` trigger after a
// deploy changed it to `*/5`. Accept both so a stale trigger cannot silently disable collection;
// the collector floors `scheduledTime` to 5-minute buckets, so extra ticks only repeat a bucket.
export const OUTCOME_AGGREGATE_CRONS = new Set([OUTCOME_AGGREGATE_CRON, '*/3 * * * *']);

export default {
  fetch(incoming: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    // The preview marker selects the physical sandbox DO's port path, so a client
    // copy never passes ingress, whichever route later forwards the request.
    const request = withoutPreviewMarkers(incoming);
    const url = new URL(request.url);
    if (matchPreviewHost(url.hostname, env.PREVIEW_HOST_SUFFIX) !== null) {
      return handlePreviewRequest(request, env);
    }
    if (url.pathname === PREVIEW_OPEN_PATH) {
      return handlePreviewOpen(request, env);
    }
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
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === REPORT_RETENTION_CRON) {
      await removeExpiredCloudAgentReportData(env);
      return;
    }
    if (OUTCOME_AGGREGATE_CRONS.has(controller.cron)) {
      try {
        await runCloudAgentOutcomeCollection(env, new Date(), controller.scheduledTime);
      } finally {
        await runCloudAgentOpenStockCollection(env);
      }
      return;
    }
    logger.warn('Cloud Agent scheduled handler received an unrecognized cron', {
      cron: controller.cron,
    });
  },
};

export { Sandbox } from '@cloudflare/sandbox';
export { UserKiloFacade } from './kilo-facade/user-kilo-facade.js';
