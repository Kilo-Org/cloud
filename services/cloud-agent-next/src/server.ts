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
  validateWrapperDispatchTicket,
  STREAM_TICKET_AUDIENCE,
  TERMINAL_TICKET_AUDIENCE,
  type WrapperAuthClaims,
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
import { authMiddleware } from './middleware/auth.js';
import { balanceMiddleware } from './middleware/balance.js';
import { resolveTerminalWrapperClient } from './terminal/access.js';
import { requestMethodAllowsBody } from './shared/http-proxy.js';
import { hasDuplicateQueryParameters } from './shared/http-query.js';
import { projectSessionAccessHttpError, requireCurrentSessionAccess } from './session-access.js';
import { timingSafeEqual } from '@kilocode/encryption';
import { and, eq, isNotNull } from 'drizzle-orm';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { getPgDb } from './db/pg.js';
import {
  KILO_FACADE_AUTH_TOKEN_HEADER,
  KILO_FACADE_GLOBAL_FEED_PATH,
  KILO_FACADE_USER_ID_HEADER,
} from './kilo-facade/user-kilo-facade.js';
import { getSandboxControlStub, isSandboxControlId } from './sandbox-control/stub.js';
import { getSandboxSessionStub, resolveSessionStub } from './sandbox-session/session-stub.js';
import { sessionPlaneFromId } from './session-plane.js';
import { withDORetry } from './utils/do-retry.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  parseBearerCredential,
} from './sandbox-control/credential.js';
import { PtyIdSchema, sessionIdSchema } from './router/schemas.js';
import { registerControlLogRoutes } from './sandbox-control/log-routes.js';
import {
  runtimeCredentialProxyUpstream,
  verifyRuntimeCredentialProxyHandle,
} from './runtime-credential-proxy.js';
import { deriveKiloSandboxTargets } from './kilo/kilo-targets.js';
import {
  issueRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_HEADER,
  type RuntimeProxyAttestationAudience,
} from '@kilocode/worker-utils/runtime-proxy-attestation';

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

  if (sessionPlaneFromId(cloudAgentSessionId) === 'control') {
    const stub = getSandboxSessionStub(env, userId, cloudAgentSessionId);
    return stub.fetch(createTerminalForwardRequest(request, '/terminal/browser', ptyId));
  }

  const stub = resolveSessionStub(env, userId, cloudAgentSessionId);
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

app.post('/internal/sandbox-control/seed', async (c: Context<HonoContext>) => {
  const unauthorized = requireInternalApi(c);
  if (unauthorized) return unauthorized;

  const body = (await c.req.json().catch(() => null)) as { sandboxId?: unknown } | null;
  const sandboxId = body?.sandboxId;
  if (typeof sandboxId !== 'string' || !isSandboxControlId(sandboxId)) {
    return c.text('Invalid sandboxId', 400);
  }

  const credential = generateSandboxCredential();
  const stub = getSandboxControlStub(c.env, sandboxId);
  await stub.setWrapperCredentialHash(await hashSandboxCredential(credential));
  return c.json({ sandboxId, credential });
});

app.get('/sandbox-control/:sandboxId', async (c: Context<HonoContext>) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const sandboxId = c.req.param('sandboxId');
  if (!sandboxId || !isSandboxControlId(sandboxId)) {
    return c.text('Invalid sandboxId', 400);
  }

  const stub = getSandboxControlStub(c.env, sandboxId);
  return stub.fetch(c.req.raw);
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
  if (
    !sessionId ||
    !sessionIdSchema.safeParse(sessionId).success ||
    sessionPlaneFromId(sessionId) !== 'control'
  ) {
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
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith('proxy-') ||
      name.startsWith('x-forwarded-') ||
      name.startsWith('x-internal-') ||
      name.startsWith('x-kilo-') ||
      name.startsWith('x-kilocode-') ||
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
  if (route !== 'backend' && route !== 'provider' && route !== 'ingest')
    return c.text('Not found', 404);
  const isWorktreeHandle = 'kind' in claims && claims.kind === 'worktree';
  // Root-addressed ingest is authorized by a member handle after the native
  // Vercel policy rewrites the static process capability.
  if (isWorktreeHandle && route === 'ingest') return c.text('Not found', 404);
  let bodyText: string | undefined;
  if (route === 'ingest' && path === '/api/session' && c.req.method === 'POST') {
    bodyText = (await readBoundedBody(c.req.raw, 8192)) ?? undefined;
    if (bodyText === undefined) return c.text('Not found', 404);
  }
  let credential: {
    token: string;
    organizationId?: string;
    runtimeAuthorization: { userId: string; authorizationId: string; resourceId: string };
  } | null;
  let selectedWorktreeMember: { sessionId: string; kiloSessionId: string; handle: string } | null =
    null;
  try {
    if (isWorktreeHandle) {
      const candidates = await withDORetry(
        () => getSandboxControlStub(c.env, claims.sandboxId),
        control => control.resolveWorktreeRuntimeCredentialProxyGrant({ handle }),
        'resolveWorktreeRuntimeCredentialProxyGrant'
      );
      credential = null;
      for (const member of candidates) {
        const resolved = await withDORetry(
          () => resolveSessionStub(c.env, claims.userId, member.sessionId),
          session => session.resolveRuntimeCredentialProxyGrant(member.handle),
          'resolveRuntimeCredentialProxyMember'
        );
        if (resolved) {
          selectedWorktreeMember = member;
          credential = resolved;
          break;
        }
      }
    } else {
      if (!('sessionId' in claims)) return c.text('Unauthorized', 401);
      credential = await withDORetry(
        () => resolveSessionStub(c.env, claims.userId, claims.sessionId),
        session => session.resolveRuntimeCredentialProxyGrant(handle),
        'resolveRuntimeCredentialProxyGrant'
      );
    }
  } catch {
    return c.text('Credential unavailable', 503);
  }
  if (!credential) return c.text('Unauthorized', 401);
  const targets = deriveKiloSandboxTargets(c.env, credential.token, { requireHttps: true });
  if (!targets.success) return c.text('Not found', 404);
  const upstream = runtimeCredentialProxyUpstream(
    targets.targets,
    route,
    c.req.method,
    path,
    new URL(c.req.url).search,
    'kiloSessionId' in claims
      ? claims.kiloSessionId
      : (selectedWorktreeMember?.kiloSessionId ?? ''),
    credential.organizationId,
    c.req.header('content-type'),
    bodyText
  );
  if (!upstream) return c.text('Not found', 404);
  try {
    // The route allowlist is resolved above before a proof is issued.
    const audience: RuntimeProxyAttestationAudience =
      route === 'backend' ? 'kilo-api' : route === 'provider' ? 'kilo-gateway' : 'session-ingest';
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
    const response = await fetch(
      createSanitizedForwardRequest(c.req.raw, upstream, headers, bodyText),
      { redirect: 'manual' }
    );
    return sanitizeRuntimeProxyResponse(response);
  } catch {
    return c.text('Upstream unavailable', 502);
  }
}

function parseOptionalWrapperGeneration(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Defense-in-depth on top of the DO's own fencing checks: reject a wrapper
 * dispatch ticket whose claims disagree with the fence tuple carried on the
 * request itself. Only compares fields the caller supplies — a route that
 * doesn't parse a given fence field yet is not forced to require it.
 *
 * A legacy raw Kilo JWT (see auth.ts) carries no fence claims to compare, so
 * it is exempt — wrapper processes bound before ticket support shipped rely
 * on requireCurrentSessionAccess/the DO's own checks until their next dispatch.
 */
function ticketClaimsMismatchRequestFence(
  claims: WrapperAuthClaims,
  expected: {
    cloudAgentSessionId: string;
    kiloSessionId?: string | null;
    wrapperRunId?: string | null;
    wrapperGeneration?: number;
    wrapperConnectionId?: string | null;
  }
): boolean {
  if (claims.type !== 'wrapper_dispatch_ticket') return false;
  if (claims.cloudAgentSessionId !== expected.cloudAgentSessionId) return true;
  if (expected.kiloSessionId != null && claims.kiloSessionId !== expected.kiloSessionId)
    return true;
  if (expected.wrapperRunId != null && claims.wrapperRunId !== expected.wrapperRunId) return true;
  if (
    expected.wrapperGeneration !== undefined &&
    claims.wrapperGeneration !== expected.wrapperGeneration
  ) {
    return true;
  }
  if (
    expected.wrapperConnectionId != null &&
    claims.wrapperConnectionId !== expected.wrapperConnectionId
  ) {
    return true;
  }
  return false;
}

function stripPublicCredentialHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  sanitized.delete('Authorization');
  sanitized.delete('Cookie');
  sanitized.delete(KILO_FACADE_USER_ID_HEADER);
  sanitized.delete(KILO_FACADE_AUTH_TOKEN_HEADER);
  return sanitized;
}

async function rejectLegacyWrapperTokenForRuntimeGrant(
  env: Env,
  claims: WrapperAuthClaims,
  userId: string,
  sessionId: string
): Promise<Response | null> {
  if (claims.type !== 'legacy_kilo_token') return null;
  const status = await withDORetry(
    () => resolveSessionStub(env, userId, sessionId),
    stub => stub.getRuntimeAuthorizationStatus(),
    'getRuntimeAuthorizationStatus'
  );
  return status === 'legacy'
    ? null
    : new Response('Legacy wrapper token is not authorized', { status: 401 });
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

  const stub = resolveSessionStub(c.env, userId, cloudAgentSessionId);
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
  if (sessionPlaneFromId(cloudAgentSessionId) === 'control') {
    return c.text('Not found', 404);
  }

  let userId: string;
  try {
    userId = decodeURIComponent(rawUserId);
  } catch {
    return c.text('Invalid userId encoding', 400);
  }

  const nextAuthSecret = await resolveSecret(c.env.NEXTAUTH_SECRET);
  const authResult = await validateWrapperDispatchTicket(
    c.req.header('Authorization') ?? null,
    nextAuthSecret
  );
  if (!authResult.success) {
    return c.text(authResult.error, 401);
  }
  if (authResult.claims.userId !== userId) {
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

  if (
    ticketClaimsMismatchRequestFence(authResult.claims, {
      cloudAgentSessionId,
      kiloSessionId,
      wrapperRunId,
      wrapperGeneration,
      wrapperConnectionId,
    })
  ) {
    return c.text('Ticket does not match dispatch fence', 403);
  }

  try {
    await requireCurrentSessionAccess({
      env: c.env,
      kiloUserId: userId,
      cloudAgentSessionId,
      expectedKiloSessionId: kiloSessionId,
    });
  } catch (error) {
    return projectSessionAccessHttpError(error);
  }

  const sessionStub = resolveSessionStub(c.env, userId, cloudAgentSessionId);
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
  const nextAuthSecret = await resolveSecret(c.env.NEXTAUTH_SECRET);
  const authResult = await validateWrapperDispatchTicket(authHeader ?? null, nextAuthSecret);
  if (!authResult.success) {
    return c.text(authResult.error, 401);
  }
  if (authResult.claims.userId !== userId) {
    return c.text('Token does not match session user', 403);
  }

  const legacyRejection = await rejectLegacyWrapperTokenForRuntimeGrant(
    c.env,
    authResult.claims,
    userId,
    sessionId
  );
  if (legacyRejection) return legacyRejection;

  const url = new URL(c.req.url);
  const wrapperGenerationParam = url.searchParams.get('wrapperGeneration');
  const wrapperGeneration = parseOptionalWrapperGeneration(wrapperGenerationParam);
  if (wrapperGenerationParam !== null && wrapperGeneration === undefined) {
    return c.text('Invalid wrapperGeneration parameter', 400);
  }
  if (
    ticketClaimsMismatchRequestFence(authResult.claims, {
      cloudAgentSessionId: sessionId,
      kiloSessionId: url.searchParams.get('kiloSessionId'),
      wrapperRunId: url.searchParams.get('wrapperRunId'),
      wrapperGeneration,
      wrapperConnectionId: url.searchParams.get('wrapperConnectionId'),
    })
  ) {
    return c.text('Ticket does not match dispatch fence', 403);
  }

  try {
    await requireCurrentSessionAccess({
      env: c.env,
      kiloUserId: userId,
      cloudAgentSessionId: sessionId,
    });
  } catch (error) {
    return projectSessionAccessHttpError(error);
  }

  if (sessionPlaneFromId(sessionId) === 'control') {
    return c.text('Not found', 404);
  }

  const stub = resolveSessionStub(c.env, userId, sessionId);
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
    if (sessionPlaneFromId(sessionId) === 'control') {
      return c.text('Not found', 404);
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
    const nextAuthSecret = await resolveSecret(c.env.NEXTAUTH_SECRET);
    const authResult = await validateWrapperDispatchTicket(authHeader ?? null, nextAuthSecret);
    if (!authResult.success) {
      return c.text(authResult.error, 401);
    }
    if (authResult.claims.userId !== userId) {
      return c.text('Token does not match session user', 403);
    }

    const legacyRejection = await rejectLegacyWrapperTokenForRuntimeGrant(
      c.env,
      authResult.claims,
      userId,
      sessionId
    );
    if (legacyRejection) return legacyRejection;

    const kiloSessionId = new URL(c.req.url).searchParams.get('kiloSessionId');
    if (!kiloSessionId && authResult.claims.type === 'wrapper_dispatch_ticket') {
      return c.text('Missing kiloSessionId parameter', 400);
    }

    if (
      ticketClaimsMismatchRequestFence(authResult.claims, {
        cloudAgentSessionId: sessionId,
        kiloSessionId,
      })
    ) {
      return c.text('Ticket does not match dispatch fence', 403);
    }

    try {
      const sessionAccess = await requireCurrentSessionAccess({
        env: c.env,
        kiloUserId: userId,
        cloudAgentSessionId: sessionId,
        expectedKiloSessionId: kiloSessionId ?? undefined,
      });
      const authoritativeKiloSessionId = kiloSessionId ?? sessionAccess.kiloSessionId;
      if (!authoritativeKiloSessionId) {
        return c.text('Missing kiloSessionId parameter', 400);
      }
    } catch (error) {
      return projectSessionAccessHttpError(error);
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
    if (!row.cloudAgentSessionId) continue;
    const stub = resolveSessionStub(c.env, userId, row.cloudAgentSessionId);
    await stub.closeOrgStreams(organizationId);
  }

  return c.body(null, 204);
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
