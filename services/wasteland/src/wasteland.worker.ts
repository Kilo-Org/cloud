import * as Sentry from '@sentry/cloudflare';
import { withSentry } from '@sentry/cloudflare';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { trpcServer } from '@hono/trpc-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { resError } from './util/res.util';
import { logger } from './util/log.util';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { MiddlewareHandler } from 'hono';
import type { AuthVariables } from './middleware/auth.middleware';
import { kiloAuthMiddleware } from './middleware/kilo-auth.middleware';
import { timingMiddleware } from './middleware/analytics.middleware';
import { wrappedWastelandRouter } from './trpc/router';
import { getWastelandRegistryStub } from './dos/WastelandRegistry.do';
import { getWastelandDOStub } from './dos/Wasteland.do';
import { getWastelandContainerStub } from './dos/WastelandContainer.do';
import * as wantedBoard from './wanted-board/wanted-board-ops';
import { WantedBoardOpError } from './wanted-board/wanted-board-ops';

// ── DO Exports ──────────────────────────────────────────────────────────
// Wrangler requires these exports to match the class_name bindings in wrangler.jsonc.

export { WastelandDO } from './dos/Wasteland.do';
export { WastelandContainerDO } from './dos/WastelandContainer.do';
export { WastelandRegistryDO } from './dos/WastelandRegistry.do';
export { WastelandRPCEntrypoint } from './wasteland-rpc.entrypoint';

// ── Types ───────────────────────────────────────────────────────────────

export type WastelandEnv = {
  Bindings: Env;
  Variables: AuthVariables;
};

const app = new Hono<WastelandEnv>();

// ── Timing ──────────────────────────────────────────────────────────────
// Capture high-resolution start timestamp before any other middleware.

app.use('*', timingMiddleware);

// ── Structured logging context ──────────────────────────────────────────
// Establishes AsyncLocalStorage context so all downstream logs are tagged.
// Cast needed: workers-tagged-logger@1.0.0 was built against an older Hono.
app.use('*', useWorkersLogger('wasteland-worker') as unknown as MiddlewareHandler);

// ── Request logging ─────────────────────────────────────────────────────

app.use('*', async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  logger.info(`--> ${method} ${path}`);
  await next();
  const elapsed = Math.round(performance.now() - (c.get('requestStartTime') ?? 0));
  logger.info(`<-- ${method} ${path} ${c.res.status}`, { durationMs: elapsed });
});

// ── CORS ────────────────────────────────────────────────────────────────
// Allow browser requests from the main Kilo app. In development, allow
// localhost origins for the Next.js dev server.

const corsMiddleware = cors({
  origin: (origin, c: Context<WastelandEnv>) => {
    if (c.env.ENVIRONMENT === 'development') {
      if (origin.startsWith('http://localhost:')) return origin;
    }
    const allowed = ['https://app.kilo.ai', 'https://kilo.ai'];
    return allowed.includes(origin) ? origin : '';
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 3600,
  credentials: true,
});

app.use('/api/*', corsMiddleware);
app.use('/trpc/*', corsMiddleware);

// ── Health ──────────────────────────────────────────────────────────────

app.get('/', c => c.json({ service: 'wasteland', status: 'ok' }));

app.get('/health', async (c: Context<WastelandEnv>) => {
  const env = c.env;

  // Query active wasteland count from the registry (best-effort)
  let activeWastelands: number | null = null;
  try {
    const registry = getWastelandRegistryStub(env);
    activeWastelands = await registry.countAll();
  } catch {
    // Registry may be unavailable — report null rather than failing the health check
  }

  return c.json({
    status: 'ok',
    version: env.CF_VERSION_METADATA?.id ?? null,
    activeWastelands,
    trpcHealthy: true,
    sentryConfigured: !!env.SENTRY_DSN,
    analyticsEngineConfigured: !!env.WASTELAND_AE,
  });
});

// ── DEBUG: unauthenticated wasteland introspection ─────────────────────
// These endpoints are unprotected in dev. In prod they are behind CF Access.

app.get('/debug/wastelands/:wastelandId/status', async c => {
  const wastelandId = c.req.param('wastelandId');
  const doStub = getWastelandDOStub(c.env, wastelandId);
  const config = await doStub.getConfig();
  const members = await doStub.listMembers();
  const connectedTowns = await doStub.listConnectedTowns();
  const wantedBoard = await doStub.getWantedBoard();
  return c.json({ config, members, connectedTowns, wantedBoardCount: wantedBoard.length });
});

app.get('/debug/wastelands/:wastelandId/wanted', async c => {
  const wastelandId = c.req.param('wastelandId');
  const doStub = getWastelandDOStub(c.env, wastelandId);
  const board = await doStub.getWantedBoard();
  return c.json({ items: board });
});

app.get('/debug/wastelands/:wastelandId/container/config', async c => {
  const wastelandId = c.req.param('wastelandId');
  const container = getWastelandContainerStub(c.env, wastelandId);
  const res = await container.fetch(new Request('http://container/wl/config'));
  const data: unknown = await res.json();
  return c.json(data);
});

app.get('/debug/wastelands/:wastelandId/container/health', async c => {
  const wastelandId = c.req.param('wastelandId');
  const container = getWastelandContainerStub(c.env, wastelandId);
  const res = await container.fetch(new Request('http://container/health'));
  const data: unknown = await res.json();
  return c.json(data);
});

app.get('/debug/registry', async c => {
  const registry = getWastelandRegistryStub(c.env);
  const all = await registry.listAll();
  return c.json({ wastelands: all });
});

// ── DEBUG: lifecycle ops (browse/post/claim/done) ─────────────────────
// These proxy to the real wanted-board-ops functions, bypassing tRPC auth.
// The userId is passed as a query param (?userId=...) or body field.
// Used by E2E tests to exercise the real production code path.

function debugErrorResponse(c: Context<WastelandEnv>, err: unknown) {
  if (err instanceof WantedBoardOpError) {
    const status =
      err.code === 'PRECONDITION_FAILED'
        ? 412
        : err.code === 'NOT_FOUND'
          ? 404
          : err.code === 'UPSTREAM_ERROR'
            ? 502
            : 500;
    return c.json({ error: err.message, code: err.code }, status as 400);
  }
  throw err;
}

async function resolveUserId(c: Context<WastelandEnv>): Promise<string | null> {
  const q = c.req.query('userId');
  if (q) return q;
  try {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body === 'object' && body !== null && 'userId' in body) {
      return String(body.userId);
    }
  } catch {
    // ignore
  }
  return null;
}

app.get('/debug/wastelands/:wastelandId/browse', async c => {
  const wastelandId = c.req.param('wastelandId');
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'Missing userId query param' }, 400);
  try {
    const items = await wantedBoard.browseWantedBoard(c.env, wastelandId, userId);
    return c.json({ itemCount: items.length, items });
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

// Browse via DoltHub API direct (bypasses container — useful when the
// container's Bun TLS is broken in local wrangler dev).
app.get('/debug/wastelands/:wastelandId/browse-direct', async c => {
  const wastelandId = c.req.param('wastelandId');
  const doStub = getWastelandDOStub(c.env, wastelandId);
  const config = await doStub.getConfig();
  if (!config?.dolthub_upstream) {
    return c.json({ error: 'No upstream configured' }, 400);
  }
  const token = getDoltHubToken(c);
  if (!token) return c.json({ error: 'Missing DoltHub token (Authorization: token ...)' }, 401);
  const q = `SELECT id, title, description, project, type, priority, tags,
                    posted_by, claimed_by, status, effort_level, evidence_url,
                    sandbox_required, sandbox_scope, sandbox_min_tier,
                    created_at, updated_at
             FROM wanted
             ORDER BY priority ASC, created_at DESC`;
  const url = `${DOLTHUB_API_BASE}/${config.dolthub_upstream}/main?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { authorization: `token ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return c.json({ error: `DoltHub API ${res.status}: ${body.slice(0, 300)}` }, 502);
  }
  const data: unknown = await res.json();
  const parsed = z
    .object({ rows: z.array(z.record(z.string(), z.unknown())) })
    .passthrough()
    .safeParse(data);
  if (!parsed.success) {
    return c.json({ error: 'Unexpected DoltHub API response' }, 502);
  }
  return c.json({ itemCount: parsed.data.rows.length, items: parsed.data.rows });
});

app.post('/debug/wastelands/:wastelandId/post', async c => {
  const wastelandId = c.req.param('wastelandId');
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  if (!body.title || !body.description) {
    return c.json({ error: 'title and description required' }, 400);
  }
  try {
    const result = await wantedBoard.postWantedItem(c.env, wastelandId, userId, {
      title: body.title,
      description: body.description,
      priority: body.priority,
      type: body.type,
    });
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

app.post('/debug/wastelands/:wastelandId/claim', async c => {
  const wastelandId = c.req.param('wastelandId');
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  if (!body.itemId) return c.json({ error: 'itemId required' }, 400);
  try {
    const result = await wantedBoard.claimWantedItem(c.env, wastelandId, userId, body.itemId);
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

app.post('/debug/wastelands/:wastelandId/done', async c => {
  const wastelandId = c.req.param('wastelandId');
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  if (!body.itemId || !body.evidence) {
    return c.json({ error: 'itemId and evidence required' }, 400);
  }
  try {
    const result = await wantedBoard.markWantedItemDone(c.env, wastelandId, userId, {
      itemId: body.itemId,
      evidence: body.evidence,
    });
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

// Generic container dispatch for wl ops not yet exposed via the
// wanted-board-ops module (unclaim, accept, reject, close, accept-upstream,
// reject-upstream, close-upstream). Uses the credential stored for the
// given userId to decrypt the DoltHub token.
async function debugCallContainer(
  c: Context<WastelandEnv>,
  wastelandId: string,
  userId: string,
  path: string,
  extraBody: Record<string, unknown>
) {
  const { getWastelandContainerStub } = await import('./dos/WastelandContainer.do');
  const { deriveEncryptionKey, decryptToken } = await import('./util/crypto.util');
  const { resolveSecret } = await import('./util/secret.util');

  const doStub = getWastelandDOStub(c.env, wastelandId);
  const config = await doStub.getConfig();
  if (!config?.dolthub_upstream) {
    return c.json({ error: 'Wasteland has no DoltHub upstream configured' }, 412);
  }
  const credential = await doStub.getCredential(userId);
  if (!credential) {
    return c.json({ error: 'No DoltHub credential stored for user' }, 412);
  }
  const rawKey = await resolveSecret(c.env.WASTELAND_ENCRYPTION_KEY);
  if (!rawKey) return c.json({ error: 'Encryption key unavailable' }, 500);
  const cryptoKey = await deriveEncryptionKey(rawKey);
  const token = await decryptToken(credential.encrypted_token, cryptoKey);

  const container = getWastelandContainerStub(c.env, wastelandId);
  const res = await container.fetch(
    new Request(`http://container${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', DOLTHUB_TOKEN: token },
      body: JSON.stringify({ upstream: config.dolthub_upstream, ...extraBody }),
    })
  );
  const data: unknown = await res.json();
  return c.json(data, res.status as 200);
}

app.post('/debug/wastelands/:wastelandId/unclaim', async c => {
  const wastelandId = c.req.param('wastelandId');
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  if (!body.itemId) return c.json({ error: 'itemId required' }, 400);
  return debugCallContainer(c, wastelandId, userId, '/wl/unclaim', {
    itemId: body.itemId,
  });
});

app.post('/debug/wastelands/:wastelandId/accept', async c => {
  const wastelandId = c.req.param('wastelandId');
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  if (!body.itemId || !body.quality) {
    return c.json({ error: 'itemId and quality required' }, 400);
  }
  return debugCallContainer(c, wastelandId, userId, '/wl/accept', {
    itemId: body.itemId,
    quality: body.quality,
    comment: body.comment,
  });
});

app.post('/debug/wastelands/:wastelandId/reject', async c => {
  const wastelandId = c.req.param('wastelandId');
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  if (!body.itemId || !body.comment) {
    return c.json({ error: 'itemId and comment required' }, 400);
  }
  return debugCallContainer(c, wastelandId, userId, '/wl/reject', {
    itemId: body.itemId,
    comment: body.comment,
  });
});

app.post('/debug/wastelands/:wastelandId/close', async c => {
  const wastelandId = c.req.param('wastelandId');
  const body = await c.req.json().catch(() => ({}));
  const userId = body.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  if (!body.itemId) return c.json({ error: 'itemId required' }, 400);
  return debugCallContainer(c, wastelandId, userId, '/wl/close', {
    itemId: body.itemId,
  });
});

// ── DEBUG: DoltHub API passthrough — for maintainer-side ops ──────────
// These use a token provided in the Authorization header (not the stored
// credential) so the maintainer can merge PRs even if their DoltHub
// account is different from the town owner.

const DOLTHUB_API_BASE = 'https://www.dolthub.com/api/v1alpha1';

function getDoltHubToken(c: Context<WastelandEnv>): string | null {
  const header = c.req.header('Authorization');
  if (header?.startsWith('token ')) return header.slice(6);
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return c.req.query('token') ?? null;
}

app.get('/debug/dolthub/:owner/:db/pulls', async c => {
  const token = getDoltHubToken(c);
  if (!token) return c.json({ error: 'Missing DoltHub token' }, 401);
  const { owner, db } = c.req.param();
  const stateFilter = c.req.query('state'); // 'open', 'closed', 'merged', or undefined
  const res = await fetch(`${DOLTHUB_API_BASE}/${owner}/${db}/pulls`, {
    headers: { authorization: `token ${token}` },
  });
  const data: unknown = await res.json();
  if (!stateFilter) return c.json(data, res.status as 200);
  // DoltHub API ignores the state query param — filter client-side
  const parsed = z
    .object({ pulls: z.array(z.object({ state: z.string() }).passthrough()) })
    .passthrough()
    .safeParse(data);
  if (!parsed.success) return c.json(data, res.status as 200);
  const want = stateFilter.toLowerCase();
  return c.json(
    {
      ...parsed.data,
      pulls: parsed.data.pulls.filter(p => p.state.toLowerCase() === want),
    },
    res.status as 200
  );
});

app.get('/debug/dolthub/:owner/:db/pulls/:pullId', async c => {
  const token = getDoltHubToken(c);
  if (!token) return c.json({ error: 'Missing DoltHub token' }, 401);
  const { owner, db, pullId } = c.req.param();
  const res = await fetch(`${DOLTHUB_API_BASE}/${owner}/${db}/pulls/${pullId}`, {
    headers: { authorization: `token ${token}` },
  });
  const data: unknown = await res.json();
  return c.json(data, res.status as 200);
});

app.post('/debug/dolthub/:owner/:db/pulls/:pullId/merge', async c => {
  const token = getDoltHubToken(c);
  if (!token) return c.json({ error: 'Missing DoltHub token' }, 401);
  const { owner, db, pullId } = c.req.param();
  const res = await fetch(`${DOLTHUB_API_BASE}/${owner}/${db}/pulls/${pullId}/merge`, {
    method: 'POST',
    headers: { authorization: `token ${token}` },
  });
  const data: unknown = await res.json();
  return c.json(data, res.status as 200);
});

app.patch('/debug/dolthub/:owner/:db/pulls/:pullId', async c => {
  const token = getDoltHubToken(c);
  if (!token) return c.json({ error: 'Missing DoltHub token' }, 401);
  const { owner, db, pullId } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const res = await fetch(`${DOLTHUB_API_BASE}/${owner}/${db}/pulls/${pullId}`, {
    method: 'PATCH',
    headers: {
      authorization: `token ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json();
  return c.json(data, res.status as 200);
});

app.get('/debug/dolthub/:owner/:db/sql', async c => {
  const token = getDoltHubToken(c);
  if (!token) return c.json({ error: 'Missing DoltHub token' }, 401);
  const { owner, db } = c.req.param();
  const branch = c.req.query('branch') ?? 'main';
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'Missing q query param' }, 400);
  const url = `${DOLTHUB_API_BASE}/${owner}/${db}/${branch}?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { authorization: `token ${token}` },
  });
  const data: unknown = await res.json();
  return c.json(data, res.status as 200);
});

// ── Kilo User Auth ──────────────────────────────────────────────────────
// Validate Kilo user JWT (signed with NEXTAUTH_SECRET) for all /api/*
// routes. Skipped in development mode for easier local testing.

app.use('/api/*', kiloAuthMiddleware);

// ── tRPC ────────────────────────────────────────────────────────────────
// Serve the wasteland tRPC router directly. The frontend tRPC client
// connects here instead of going through the Next.js proxy layer.

app.use('/trpc/*', kiloAuthMiddleware);
app.use(
  '/trpc/*',
  trpcServer({
    router: wrappedWastelandRouter,
    endpoint: '/trpc',
    createContext: (_opts: unknown, c: Context<WastelandEnv>) => ({
      env: c.env,
      userId: c.get('kiloUserId') ?? '',
      isAdmin: c.get('kiloIsAdmin') ?? false,
      apiTokenPepper: c.get('kiloApiTokenPepper') ?? null,
      orgMemberships: c.get('kiloOrgMemberships') ?? [],
    }),
    onError: ({ error, path }: { error: Error; path?: string }) => {
      console.error(`[wasteland-trpc] error on ${path ?? 'unknown'}:`, error.message);
      if (!(error instanceof TRPCError)) {
        Sentry.captureException(error);
      }
    },
  })
);

// ── Error handling ──────────────────────────────────────────────────────

app.notFound(c => c.json(resError('Not found'), 404));

app.onError((err, c) => {
  console.error('Unhandled error', { error: err.message, stack: err.stack });
  Sentry.captureException(err);
  return c.json(resError('Internal server error'), 500);
});

// ── Export with Sentry wrapping ─────────────────────────────────────────

export default withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN ?? '',
    release: env.SENTRY_RELEASE || env.CF_VERSION_METADATA?.id,
    tracesSampleRate: 0.1,
    enabled: !!env.SENTRY_DSN,
  }),
  {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return app.fetch(request, env, ctx);
    },
  }
);
