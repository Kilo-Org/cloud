import * as Sentry from '@sentry/cloudflare';
import { withSentry } from '@sentry/cloudflare';
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

// ── DO Exports ──────────────────────────────────────────────────────────
// Wrangler requires these exports to match the class_name bindings in wrangler.jsonc.

export { WastelandDO } from './dos/WastelandDO.stub';
export { WastelandContainerDO } from './dos/WastelandContainer.do';
export { WastelandRegistryDO } from './dos/WastelandRegistry.do';

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
app.get('/health', c => c.json({ status: 'ok' }));

// ── Kilo User Auth ──────────────────────────────────────────────────────
// Validate Kilo user JWT (signed with NEXTAUTH_SECRET) for all /api/*
// routes. Skipped in development mode for easier local testing.

app.use('/api/*', async (c: Context<WastelandEnv, string>, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : kiloAuthMiddleware(c, next)
);

// ── tRPC ────────────────────────────────────────────────────────────────
// Serve the wasteland tRPC router directly. The frontend tRPC client
// connects here instead of going through the Next.js proxy layer.

app.use('/trpc/*', async (c: Context<WastelandEnv, string>, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : kiloAuthMiddleware(c, next)
);
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
