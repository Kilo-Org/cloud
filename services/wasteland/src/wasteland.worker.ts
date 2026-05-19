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
import { validateCfAccessRequest } from './middleware/cf-access.middleware';
import { timingMiddleware } from './middleware/analytics.middleware';
import { wrappedWastelandRouter } from './trpc/router';
import { getWastelandRegistryStub } from './dos/WastelandRegistry.do';
import { getWastelandDOStub } from './dos/Wasteland.do';
import * as wantedBoard from './wanted-board/wanted-board-ops-sdk';
import { loadSdkContext } from './wanted-board/wanted-board-ops-sdk';
import { WantedBoardOpError } from './wanted-board/errors';
import { readBranchHead } from '@kilocode/wl-sdk';

// ── DO Exports ──────────────────────────────────────────────────────────
// Wrangler requires these exports to match the class_name bindings in wrangler.jsonc.

export { WastelandDO } from './dos/Wasteland.do';
export { WastelandRegistryDO } from './dos/WastelandRegistry.do';
export { WastelandRPCEntrypoint } from './wasteland-rpc.entrypoint';

// ── Types ───────────────────────────────────────────────────────────────

export type WastelandEnv = {
  Bindings: Env;
  Variables: AuthVariables;
};

const app = new Hono<WastelandEnv>();
async function cfAccessDebugMiddleware(c: Context<WastelandEnv>, next: () => Promise<void>) {
  // Bypass CF Access in dev. We can't trust the request hostname for
  // a localhost check — `wrangler dev` rewrites `request.url` to the
  // production hostname inferred from `wrangler.jsonc`'s `routes`
  // block (see https://github.com/cloudflare/workers-sdk/issues/3635),
  // so `URL(c.req.url).hostname` is `wasteland.kiloapps.io` even when
  // the request actually hit `localhost`. The `ENVIRONMENT` binding
  // is the load-bearing check: prod deploys don't pass `--env dev`,
  // so `ENVIRONMENT` is `'production'` there and the bypass doesn't
  // fire.
  if (c.env.ENVIRONMENT === 'development') {
    return next();
  }

  try {
    await validateCfAccessRequest(c.req.raw, {
      team: c.env.CF_ACCESS_TEAM,
      audience: c.env.CF_ACCESS_AUD,
    });
  } catch (e) {
    console.warn(`CF Access validation failed ${e instanceof Error ? e.message : 'unknown'}`, {
      error: e,
    });
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  return next();
}

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

app.use('/debug/*', cfAccessDebugMiddleware);

// ── DEBUG: CF Access-protected wasteland introspection ─────────────────

app.get('/debug/wastelands/:wastelandId/status', async c => {
  const wastelandId = c.req.param('wastelandId');
  const doStub = getWastelandDOStub(c.env, wastelandId);
  const config = await doStub.getConfig();
  const members = await doStub.listMembers();
  const connectedTowns = await doStub.listConnectedTowns();
  return c.json({ config, members, connectedTowns });
});

app.get('/debug/registry', async c => {
  const registry = getWastelandRegistryStub(c.env);
  const all = await registry.listAll();
  return c.json({ wastelands: all });
});

// One-off backfill of `wasteland_registry.dolthub_upstream` from each
// per-wasteland DO's config. Idempotent — re-running converges the
// registry rows to whatever each WastelandDO currently reports as
// `dolthub_upstream`.
//
// Auth: behind cfAccessDebugMiddleware (CF Access in prod, bypassed in
// dev). No additional gating because the operation is self-correcting.
//
// Usage: POST /debug/registry/backfill-upstreams
app.post('/debug/registry/backfill-upstreams', async c => {
  const registry = getWastelandRegistryStub(c.env);
  const result = await registry.backfillDolthubUpstream();
  return c.json(result);
});

// ── DEBUG: lifecycle ops (browse/post/claim/done) ─────────────────────
// These proxy to the real wanted-board-ops functions, bypassing tRPC auth.
// The userId is passed as a query param (?userId=...) or body field.
// Used by E2E tests to exercise the real production code path.

function describeCauseChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  // Hard cap to avoid pathological circular causes blowing the response.
  for (let depth = 0; depth < 10 && current; depth += 1) {
    if (current instanceof Error) {
      const entry: Record<string, unknown> = {
        name: current.name,
        message: current.message,
      };
      // Capture WlDoltHubError-style `status`/`url`/`body` fields when present
      // so the client can see the failing DoltHub call directly.
      const c = current as unknown as Record<string, unknown>;
      if (typeof c.status === 'number') entry.status = c.status;
      if (typeof c.url === 'string') entry.url = c.url;
      if (c.body !== undefined) entry.body = c.body;
      if (typeof c.code === 'string') entry.code = c.code;
      chain.push(entry);
      current = current.cause;
    } else if (current !== undefined) {
      // Non-Error cause: stringify rather than reach into shape — JSON
      // is the safe escape hatch for arbitrary thrown values.
      chain.push(typeof current === 'string' ? current : JSON.stringify(current));
      current = undefined;
    }
  }
  return chain;
}

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
    return c.json(
      {
        error: err.message,
        code: err.code,
        cause: describeCauseChain(err.cause),
      },
      status as 400
    );
  }
  throw err;
}

/**
 * Parse a JSON request body against a Zod schema. Returns the parsed data
 * on success; on failure (non-JSON, schema mismatch) returns a 400 Response
 * the handler can return directly.
 *
 * Per services/wasteland/AGENTS.md: "Always validate data at IO boundaries
 * (HTTP responses, JSON.parse results, SSE event payloads, subprocess
 * output) with Zod schemas." This helper is the single enforcement point
 * for the debug routes below.
 */
async function parseJsonBody<T extends z.ZodTypeAny>(
  c: Context<WastelandEnv>,
  schema: T
): Promise<{ data: z.infer<T> } | { response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      response: c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400),
    };
  }
  return { data: parsed.data };
}

/**
 * Resolve a userId from either the `userId` query param or a JSON body
 * field of the same name. Used by debug endpoints that don't go through
 * the Kilo auth middleware. Hono caches `req.json()` so the same body can
 * still be re-parsed by the calling handler via `parseJsonBody`.
 */
async function resolveUserId(c: Context<WastelandEnv>): Promise<string | null> {
  const q = c.req.query('userId');
  if (q) return q;
  const result = await parseJsonBody(c, z.object({ userId: z.string().optional() }).passthrough());
  if ('response' in result) return null;
  return result.data.userId ?? null;
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

// Browse via DoltHub API direct — sanity-checks that a token + upstream
// combination is well-formed without going through the wanted-board ops
// layer.
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

// Auth probe: run a small `wanted` SELECT three ways (anonymous, with
// the user's stored token, and with a fresh OAuth token if installed).
// Use to diagnose "no such repository" errors that happen
// only on the authenticated path — DoltHub returns that error on
// authenticated reads against repos the user doesn't have explicit
// permissions on, even when the repo is public.
//
// Usage: GET /debug/wastelands/:id/auth-probe?userId=<userId>
//
// Returns a JSON envelope with one entry per probe:
//   {
//     credential: { hasLocal, hasOauth, dolthubOrg, rigHandle, tokenPrefix },
//     probes: {
//       anonymous: { ok, status, message },
//       localToken: { ok, status, message } | null,
//       freshToken: { ok, status, message } | null,
//     }
//   }
//
// Tokens are never returned in full — only a 6-char prefix for sanity
// checks (e.g. `dh+sat`, `dhat.v`).
app.get('/debug/wastelands/:wastelandId/auth-probe', async c => {
  const wastelandId = c.req.param('wastelandId');
  const userId = c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId query param' }, 400);

  const doStub = getWastelandDOStub(c.env, wastelandId);
  const config = await doStub.getConfig();
  if (!config?.dolthub_upstream) {
    return c.json({ error: 'No upstream configured on this wasteland' }, 412);
  }

  // Keep the column list tight so the response stays small even on a
  // populated repo.
  const sql = 'SELECT id, title, status FROM wanted ORDER BY created_at DESC LIMIT 3';
  const url = `${DOLTHUB_API_BASE}/${config.dolthub_upstream}/main?q=${encodeURIComponent(sql)}`;

  // Resolve the local credential (encrypted token + DoltHub username).
  const credential = await doStub.getCredential(userId);
  let localToken: string | null = null;
  if (credential) {
    const { resolveSecret } = await import('./util/secret.util');
    const { deriveEncryptionKey, decryptToken } = await import('./util/crypto.util');
    const rawKey = await resolveSecret(c.env.WASTELAND_ENCRYPTION_KEY);
    if (rawKey) {
      const cryptoKey = await deriveEncryptionKey(rawKey);
      try {
        localToken = await decryptToken(credential.encrypted_token, cryptoKey);
      } catch (err) {
        return c.json(
          {
            error: 'Failed to decrypt local credential',
            detail: err instanceof Error ? err.message : String(err),
          },
          500
        );
      }
    }
  }

  // Resolve a fresh OAuth token via apps/web's internal endpoint.
  const { fetchFreshDoltHubToken } = await import('./util/dolthub-token.util');
  const fresh = await fetchFreshDoltHubToken(c.env, { userId });
  const freshToken = fresh.status === 'ok' ? fresh.data.token : null;

  type ProbeResult = { ok: boolean; status: number; message: string; rows?: number };
  async function probe(token: string | null): Promise<ProbeResult> {
    const headers: Record<string, string> = { 'cache-control': 'no-cache' };
    if (token) headers.authorization = `token ${token}`;
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      return {
        ok: false,
        status: 0,
        message: `transport error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const bodyText = await res.text().catch(() => '');
    let bodyJson: {
      query_execution_status?: string;
      query_execution_message?: string;
      rows?: unknown[];
    } = {};
    try {
      bodyJson = JSON.parse(bodyText) as typeof bodyJson;
    } catch {
      /* keep empty */
    }
    const ok = res.ok && bodyJson.query_execution_status?.toLowerCase() === 'success';
    const message =
      bodyJson.query_execution_message ?? (bodyText.slice(0, 400) || res.statusText || '(empty)');
    return {
      ok,
      status: res.status,
      message,
      rows: Array.isArray(bodyJson.rows) ? bodyJson.rows.length : undefined,
    };
  }

  const [anonymous, localResult, freshResult] = await Promise.all([
    probe(null),
    localToken ? probe(localToken) : Promise.resolve(null),
    freshToken ? probe(freshToken) : Promise.resolve(null),
  ]);

  return c.json({
    upstream: config.dolthub_upstream,
    credential: {
      hasLocal: !!credential,
      hasOauth: fresh.status === 'ok',
      oauthStatus: fresh.status,
      oauthReason: fresh.status === 'unavailable' ? fresh.reason : undefined,
      dolthubOrg: credential?.dolthub_org ?? null,
      rigHandle: credential?.rig_handle ?? null,
      isUpstreamAdmin: credential?.is_upstream_admin ?? null,
      // First 6 chars of the token only — enough to tell `dh+sat` vs
      // `dhat.v` apart but not enough to do anything with it.
      localTokenPrefix: localToken ? localToken.slice(0, 6) : null,
      freshTokenPrefix: freshToken ? freshToken.slice(0, 6) : null,
    },
    probes: {
      anonymous,
      localToken: localResult,
      freshToken: freshResult,
    },
  });
});

const PostItemBody = z.object({
  userId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  type: z.enum(['bug', 'docs', 'feature', 'other']).optional(),
});

app.post('/debug/wastelands/:wastelandId/post', async c => {
  const wastelandId = c.req.param('wastelandId');
  const parsed = await parseJsonBody(c, PostItemBody);
  if ('response' in parsed) return parsed.response;
  const userId = parsed.data.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  try {
    const result = await wantedBoard.postWantedItem(c.env, wastelandId, userId, {
      title: parsed.data.title,
      description: parsed.data.description,
      priority: parsed.data.priority,
      type: parsed.data.type,
    });
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

const ItemIdBody = z.object({
  userId: z.string().optional(),
  itemId: z.string().min(1),
});

app.post('/debug/wastelands/:wastelandId/claim', async c => {
  const wastelandId = c.req.param('wastelandId');
  const parsed = await parseJsonBody(c, ItemIdBody);
  if ('response' in parsed) return parsed.response;
  const userId = parsed.data.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  try {
    const result = await wantedBoard.claimWantedItem(
      c.env,
      wastelandId,
      userId,
      parsed.data.itemId
    );
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

// Compare fork main HEAD to upstream main HEAD using the worker's
// stored credentials. Mirrors the staleness gate in `applyMutation`
// (`packages/wl-sdk/src/ops/mutate.ts`) without performing any writes,
// so callers can probe whether a fork would currently fail the
// `assertForkMainCurrent` check.
//
// Usage: GET /debug/wastelands/:wastelandId/fork-currency?userId=<userId>
//
// Response shape:
//   {
//     upstream: "owner/db",
//     fork: "forkOwner/forkDb",
//     upstreamHead: "<hash>" | null,   // null if HEAD couldn't be read
//     forkHead: "<hash>" | null,
//     isCurrent: boolean,              // true when both heads match (or
//                                      //   either was null — best-effort
//                                      //   parity with the SDK's gate)
//     deepLinkUrl?: string,            // present iff !isCurrent
//   }
app.get('/debug/wastelands/:wastelandId/fork-currency', async c => {
  const wastelandId = c.req.param('wastelandId');
  const userId = c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId query param' }, 400);

  try {
    // Delegate to the same adapter the tRPC `getForkCurrency` query
    // calls so the debug surface and the production UI surface stay
    // in lockstep — including the prefilled DoltHub deep-link URL.
    const result = await wantedBoard.getForkCurrency(c.env, wastelandId, userId);
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

// Probe a battery of candidate DoltHub API paths for syncing a fork's
// main branch with its upstream. We've already shown that `CALL
// DOLT_FETCH/MERGE/REMOTE` is rejected by the SQL endpoint and that
// `POST /{forkOwner}/{forkDb}/pulls` with from=upstream:main is
// rejected with "must have write permissions on from repository".
// This endpoint blasts through every other plausible path so we can
// pick a winner — or conclude there is none and route users to the
// DoltHub web UI for the sync.
//
// Usage: POST /debug/wastelands/:wastelandId/fork-sync-experiment?userId=<id>
//
// Response: { ctx, probes: Probe[], verification?: { winnerLabel, forkHeadAfter, advanced } }
// Probe: { label, url, method, requestBody?, status, body, ok }
//
// Each probe captures status + body separately so a 200 "Bad Request"
// envelope (DoltHub's pattern for SQL errors) is still inspectable.
const ProbeResultShape = z.object({
  label: z.string(),
  url: z.string(),
  method: z.string(),
  requestBody: z.unknown().optional(),
  status: z.number(),
  body: z.unknown(),
  ok: z.boolean(),
});
type ProbeResult = z.infer<typeof ProbeResultShape>;

app.post('/debug/wastelands/:wastelandId/fork-sync-experiment', async c => {
  const wastelandId = c.req.param('wastelandId');
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: 'Missing userId query param or body field' }, 400);

  let ctx: Awaited<ReturnType<typeof loadSdkContext>>;
  try {
    ctx = await loadSdkContext(c.env, wastelandId, userId);
  } catch (err) {
    return debugErrorResponse(c, err);
  }

  const upstreamParts = ctx.upstream.split('/');
  if (upstreamParts.length !== 2 || !upstreamParts[0] || !upstreamParts[1]) {
    return c.json({ error: `Malformed upstream "${ctx.upstream}"` }, 500);
  }
  const upstreamOwner = upstreamParts[0];
  const upstreamDb = upstreamParts[1];
  const forkOwner = ctx.forkOrg;
  const forkDb = upstreamDb;
  const token = ctx.token;

  // Read upstream HEAD up front for the branch-creation probe and to
  // give the response something concrete to compare against.
  const auth = { token };
  const [upstreamHead, forkHeadBefore] = await Promise.all([
    readBranchHead({ auth, owner: upstreamOwner, db: upstreamDb, branch: 'main' }),
    readBranchHead({ auth, owner: forkOwner, db: forkDb, branch: 'main' }),
  ]);

  async function probe(args: {
    label: string;
    url: string;
    method: 'GET' | 'POST';
    body?: unknown;
  }): Promise<ProbeResult> {
    const headers: Record<string, string> = {
      authorization: `token ${token}`,
      'cache-control': 'no-cache',
    };
    let bodyText: string | undefined;
    if (args.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyText = JSON.stringify(args.body);
    }
    let status = 0;
    let parsedBody: unknown = null;
    try {
      const res = await fetch(args.url, {
        method: args.method,
        headers,
        body: bodyText,
      });
      status = res.status;
      const text = await res.text().catch(() => '');
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    } catch (err) {
      parsedBody = `transport error: ${err instanceof Error ? err.message : String(err)}`;
    }
    // DoltHub's SQL endpoint frequently returns HTTP 200 with a
    // `query_execution_status: "Error"` envelope. Treat the probe as
    // successful only when the HTTP status is 2xx AND the SQL envelope
    // (if present) reports success.
    let ok = status >= 200 && status < 300;
    const envelope = z
      .object({ query_execution_status: z.string() })
      .passthrough()
      .safeParse(parsedBody);
    if (
      ok &&
      envelope.success &&
      envelope.data.query_execution_status.toLowerCase() !== 'success'
    ) {
      ok = false;
    }
    return {
      label: args.label,
      url: args.url,
      method: args.method,
      requestBody: args.body,
      status,
      body: parsedBody,
      ok,
    };
  }

  const remoteUrl = `https://doltremoteapi.dolthub.com/${upstreamOwner}/${upstreamDb}`;
  const writeBase = `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/write/main/main`;
  const sqlEnc = (sql: string) => `?q=${encodeURIComponent(sql)}`;

  const probes: ProbeResult[] = [];

  // 1a. write/main/main with no q param.
  probes.push(
    await probe({
      label: '1a-write-main-main-no-q',
      url: writeBase,
      method: 'POST',
    })
  );

  // 1b. write/<from>/<to> with from = "jrf0110/wl-commons:main".
  probes.push(
    await probe({
      label: '1b-write-cross-repo-from',
      url: `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/write/${encodeURIComponent(`${upstreamOwner}/${upstreamDb}:main`)}/main`,
      method: 'POST',
    })
  );

  // 1c. write with extra path components (cross-repo-from spelled out).
  probes.push(
    await probe({
      label: '1c-write-cross-repo-path',
      url: `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/write/${upstreamOwner}/${upstreamDb}/main/main`,
      method: 'POST',
    })
  );

  // 2. Backwards PR: open a PR on UPSTREAM that pushes upstream main
  //    into the fork. Almost certainly won't work but worth confirming.
  probes.push(
    await probe({
      label: '2-pr-on-upstream-targeting-fork',
      url: `${DOLTHUB_API_BASE}/${upstreamOwner}/${upstreamDb}/pulls`,
      method: 'POST',
      body: {
        title: 'Sync fork main with upstream main',
        description: 'fork-sync-experiment probe',
        fromBranchOwnerName: upstreamOwner,
        fromBranchRepoName: upstreamDb,
        fromBranchName: 'main',
        toBranchOwnerName: forkOwner,
        toBranchRepoName: forkDb,
        toBranchName: 'main',
      },
    })
  );

  // 3. CALL DOLT_PULL with the remote URL inline.
  probes.push(
    await probe({
      label: '3-dolt-pull-with-remote-url',
      url: `${writeBase}${sqlEnc(`CALL DOLT_PULL('${remoteUrl}','main')`)}`,
      method: 'POST',
    })
  );

  // 4. CALL DOLT_FETCH with remote URL inline.
  probes.push(
    await probe({
      label: '4-dolt-fetch-with-remote-url',
      url: `${writeBase}${sqlEnc(`CALL DOLT_FETCH('${remoteUrl}','main')`)}`,
      method: 'POST',
    })
  );

  // 5. CALL DOLT_MERGE on a cross-repo ref.
  probes.push(
    await probe({
      label: '5-dolt-merge-cross-repo-ref',
      url: `${writeBase}${sqlEnc(`CALL DOLT_MERGE('${upstreamOwner}/${upstreamDb}/main','--ff')`)}`,
      method: 'POST',
    })
  );

  // 6. Branch creation pointing at upstream commit hash. If DoltHub
  //    accepts an unknown hash here, the fork must already share
  //    history with upstream — which it does for a fork.
  if (upstreamHead) {
    // 6a — original guess at the body shape.
    probes.push(
      await probe({
        label: '6a-create-branch-name+startPoint',
        url: `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/branches`,
        method: 'POST',
        body: { name: 'sync-from-upstream-experiment', startPoint: upstreamHead },
      })
    );
    // 6b — match the keys the server complained were missing
    //      (newBranchName, revisionName, revisionType).
    probes.push(
      await probe({
        label: '6b-create-branch-revisionType-commit',
        url: `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/branches`,
        method: 'POST',
        body: {
          newBranchName: 'sync-from-upstream-experiment-2',
          revisionName: upstreamHead,
          revisionType: 'commit',
        },
      })
    );
    // 6c — same shape but cross-repo branch reference.
    probes.push(
      await probe({
        label: '6c-create-branch-revisionType-branch-cross-repo',
        url: `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/branches`,
        method: 'POST',
        body: {
          newBranchName: 'sync-from-upstream-experiment-3',
          revisionName: `${upstreamOwner}/${upstreamDb}/main`,
          revisionType: 'branch',
        },
      })
    );
  } else {
    probes.push({
      label: '6-create-branch-skipped',
      url: '(skipped — could not read upstream HEAD)',
      method: 'POST',
      requestBody: undefined,
      status: 0,
      body: 'skipped',
      ok: false,
    });
  }

  // 7. Ad-hoc — a few additional shapes the DoltHub web UI plausibly
  //    uses. None are documented but the failure mode (404 vs 405 vs
  //    422) is informative.
  probes.push(
    await probe({
      label: '7a-fork-sync-from-upstream',
      url: `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/sync-from-upstream`,
      method: 'POST',
      body: { branch: 'main' },
    })
  );
  probes.push(
    await probe({
      label: '7b-fork-sync',
      url: `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/sync`,
      method: 'POST',
      body: { branch: 'main' },
    })
  );
  probes.push(
    await probe({
      label: '7c-fork-update-from-upstream',
      url: `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/update-from-upstream`,
      method: 'POST',
      body: { branch: 'main' },
    })
  );
  probes.push(
    await probe({
      label: '7d-pulls-merge-upstream',
      url: `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/pulls/merge-upstream`,
      method: 'POST',
      body: { branch: 'main' },
    })
  );
  probes.push(
    await probe({
      label: '7e-fast-forward-write',
      url: `${writeBase}${sqlEnc(`CALL DOLT_BRANCH('-f','main','${upstreamOwner}/${upstreamDb}/main')`)}`,
      method: 'POST',
    })
  );
  probes.push(
    await probe({
      label: '7f-dolt-reset-hard-cross-repo',
      url: `${writeBase}${sqlEnc(`CALL DOLT_RESET('--hard','${upstreamOwner}/${upstreamDb}/main')`)}`,
      method: 'POST',
    })
  );

  // The DoltHub write endpoint is asynchronous — a 200 response with
  // `query_execution_status: "Success"` only confirms that the
  // operation was *queued* (it returns an `operation_name`). We have
  // to poll the operation endpoint to see whether the SQL actually
  // landed. Returning HTTP 200 here without polling would be a
  // false-positive trap, so for every probe that produced an
  // `operation_name` we poll until it terminates (or we time out).
  // Matches `PollResponse` in packages/wl-sdk/src/dolthub/operation.ts.
  const OperationShape = z
    .object({
      done: z.boolean().optional(),
      res_details: z
        .object({
          query_execution_status: z.string().optional(),
          query_execution_message: z.string().optional(),
          from_commit_id: z.string().nullable().optional(),
          to_commit_id: z.string().nullable().optional(),
        })
        .passthrough()
        .optional(),
      query_execution_status: z.string().optional(),
      query_execution_message: z.string().optional(),
    })
    .passthrough();

  async function pollOperation(operationName: string): Promise<{
    done: boolean;
    final: unknown;
    pollCount: number;
  }> {
    // The poll URL is `/{owner}/{db}/write?operationName=…` (verified
    // against `packages/wl-sdk/src/dolthub/operation.ts`'s buildPollPath),
    // not `/{operation_name}`. The `operation_name` field returned by
    // the write endpoint is just an identifier passed back as a query
    // parameter; the path is fixed.
    const url = `${DOLTHUB_API_BASE}/${forkOwner}/${forkDb}/write?operationName=${encodeURIComponent(operationName)}`;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(r => setTimeout(r, 1000));
      let parsedBody: unknown = null;
      try {
        const res = await fetch(url, { headers: { authorization: `token ${token}` } });
        const text = await res.text().catch(() => '');
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = text;
        }
      } catch (err) {
        return {
          done: true,
          final: `transport error: ${err instanceof Error ? err.message : String(err)}`,
          pollCount: attempt + 1,
        };
      }
      const parsed = OperationShape.safeParse(parsedBody);
      // Treat as terminal when `done: true`, OR when the
      // `query_execution_status` is anything other than `RowsFlow` /
      // pending. Some DoltHub responses surface a final
      // success/error envelope without a `done` flag.
      const status = parsed.success
        ? (parsed.data.res_details?.query_execution_status ??
          parsed.data.query_execution_status ??
          '')
        : '';
      const lower = status.toLowerCase();
      if (parsed.success && parsed.data.done) {
        return { done: true, final: parsedBody, pollCount: attempt + 1 };
      }
      if (lower === 'success' || lower === 'successwithwarning' || lower === 'error') {
        return { done: true, final: parsedBody, pollCount: attempt + 1 };
      }
    }
    return { done: false, final: 'timed out after 30s of polling', pollCount: 30 };
  }

  type OperationOutcome = {
    label: string;
    operationName: string;
    pollCount: number;
    done: boolean;
    final: unknown;
  };
  const operationOutcomes: OperationOutcome[] = [];
  for (const p of probes) {
    if (!p.ok) continue;
    const opShape = z
      .object({ operation_name: z.string().min(1) })
      .passthrough()
      .safeParse(p.body);
    if (!opShape.success) continue;
    const outcome = await pollOperation(opShape.data.operation_name);
    operationOutcomes.push({
      label: p.label,
      operationName: opShape.data.operation_name,
      pollCount: outcome.pollCount,
      done: outcome.done,
      final: outcome.final,
    });
  }

  // Re-read fork HEAD once at the end so we can see net effect across
  // the whole battery (some probes may have cumulatively advanced it).
  const forkHeadAfter = await readBranchHead({
    auth,
    owner: forkOwner,
    db: forkDb,
    branch: 'main',
  });
  const verification = {
    forkHeadBefore,
    forkHeadAfter,
    upstreamHead,
    advanced: forkHeadAfter !== forkHeadBefore,
    matchesUpstream: forkHeadAfter === upstreamHead,
  };

  return c.json({
    ctx: {
      upstream: `${upstreamOwner}/${upstreamDb}`,
      fork: `${forkOwner}/${forkDb}`,
      upstreamHead,
      forkHeadBefore,
      tokenPrefix: token.slice(0, 6),
    },
    probes,
    operationOutcomes,
    verification,
  });
});

const DoneBody = z.object({
  userId: z.string().optional(),
  itemId: z.string().min(1),
  evidence: z.string().min(1),
});

app.post('/debug/wastelands/:wastelandId/done', async c => {
  const wastelandId = c.req.param('wastelandId');
  const parsed = await parseJsonBody(c, DoneBody);
  if ('response' in parsed) return parsed.response;
  const userId = parsed.data.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  try {
    const result = await wantedBoard.markWantedItemDone(c.env, wastelandId, userId, {
      itemId: parsed.data.itemId,
      evidence: parsed.data.evidence,
    });
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

// Each /debug/wastelands/:id/<op> route below calls the corresponding
// wanted-board op directly (the same code path the production tRPC and
// RPC entrypoints take), so debug exercises the real adapter.

app.post('/debug/wastelands/:wastelandId/unclaim', async c => {
  const wastelandId = c.req.param('wastelandId');
  const parsed = await parseJsonBody(c, ItemIdBody);
  if ('response' in parsed) return parsed.response;
  const userId = parsed.data.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  try {
    const result = await wantedBoard.unclaimWantedItem(
      c.env,
      wastelandId,
      userId,
      parsed.data.itemId
    );
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

const AcceptBody = z.object({
  userId: z.string().optional(),
  itemId: z.string().min(1),
  submitterPullId: z.string().min(1).optional(),
  submitterRigHandle: z.string().min(1).optional(),
  submitterForkOwner: z.string().min(1).optional(),
  completionId: z.string().min(1).optional(),
  evidence: z.string().optional(),
  quality: z.enum(['excellent', 'good', 'fair', 'poor']),
  reliability: z.enum(['excellent', 'good', 'fair', 'poor']).optional(),
  severity: z.enum(['leaf', 'branch', 'root']).optional(),
  skillTags: z.array(z.string().min(1).max(64)).max(16).optional(),
  message: z.string().optional(),
  direct: z.boolean().optional(),
});

app.post('/debug/wastelands/:wastelandId/accept', async c => {
  const wastelandId = c.req.param('wastelandId');
  const parsed = await parseJsonBody(c, AcceptBody);
  if ('response' in parsed) return parsed.response;
  const userId = parsed.data.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  try {
    const result = await wantedBoard.acceptWantedItem(c.env, wastelandId, userId, {
      itemId: parsed.data.itemId,
      submitterPullId: parsed.data.submitterPullId,
      submitterRigHandle: parsed.data.submitterRigHandle,
      submitterForkOwner: parsed.data.submitterForkOwner,
      completionId: parsed.data.completionId,
      evidence: parsed.data.evidence,
      quality: parsed.data.quality,
      reliability: parsed.data.reliability,
      severity: parsed.data.severity,
      skillTags: parsed.data.skillTags,
      message: parsed.data.message,
      direct: parsed.data.direct,
    });
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

const RejectBody = z.object({
  userId: z.string().optional(),
  itemId: z.string().min(1),
  reason: z.string().min(1),
});

app.post('/debug/wastelands/:wastelandId/reject', async c => {
  const wastelandId = c.req.param('wastelandId');
  const parsed = await parseJsonBody(c, RejectBody);
  if ('response' in parsed) return parsed.response;
  const userId = parsed.data.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  try {
    const result = await wantedBoard.rejectWantedItem(c.env, wastelandId, userId, {
      itemId: parsed.data.itemId,
      reason: parsed.data.reason,
    });
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
});

app.post('/debug/wastelands/:wastelandId/close', async c => {
  const wastelandId = c.req.param('wastelandId');
  const parsed = await parseJsonBody(c, ItemIdBody);
  if ('response' in parsed) return parsed.response;
  const userId = parsed.data.userId ?? c.req.query('userId');
  if (!userId) return c.json({ error: 'Missing userId' }, 400);
  try {
    const result = await wantedBoard.closeWantedItem(
      c.env,
      wastelandId,
      userId,
      parsed.data.itemId
    );
    return c.json(result);
  } catch (err) {
    return debugErrorResponse(c, err);
  }
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

// Accept any JSON object — DoltHub validates the PATCH fields server-side,
// so we just forward whatever the caller sent. `.passthrough()` preserves
// unknown fields so new DoltHub options work without a code change.
const PatchPullBody = z.record(z.string(), z.unknown());

app.patch('/debug/dolthub/:owner/:db/pulls/:pullId', async c => {
  const token = getDoltHubToken(c);
  if (!token) return c.json({ error: 'Missing DoltHub token' }, 401);
  const { owner, db, pullId } = c.req.param();
  const parsed = await parseJsonBody(c, PatchPullBody);
  if ('response' in parsed) return parsed.response;
  const res = await fetch(`${DOLTHUB_API_BASE}/${owner}/${db}/pulls/${pullId}`, {
    method: 'PATCH',
    headers: {
      authorization: `token ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parsed.data),
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

// DoltHub write API — creates a branch and commits the DML in one call.
// URL: POST /api/v1alpha1/{owner}/{db}/write/{from_branch}/{to_branch}?q=<SQL>
// The write creates `to_branch` as a new branch forked from `from_branch`,
// then commits the DML on `to_branch`. Used by E2E tests to simulate what
// `wl` would do in production.
const WriteBody = z.object({
  q: z.string().optional(),
});

app.post('/debug/dolthub/:owner/:db/write/:fromBranch/:toBranch', async c => {
  const token = getDoltHubToken(c);
  if (!token) return c.json({ error: 'Missing DoltHub token' }, 401);
  const { owner, db, fromBranch, toBranch } = c.req.param();
  const parsed = await parseJsonBody(c, WriteBody);
  if ('response' in parsed) return parsed.response;
  const sql = parsed.data.q ?? c.req.query('q');
  if (!sql) return c.json({ error: 'Missing q (SQL) in body or query' }, 400);
  const url = `${DOLTHUB_API_BASE}/${owner}/${db}/write/${encodeURIComponent(fromBranch)}/${encodeURIComponent(toBranch)}?q=${encodeURIComponent(sql)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `token ${token}` },
  });
  const data: unknown = await res.json();
  return c.json(data, res.status as 200);
});

const CreatePullBody = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  fromBranchOwner: z.string().min(1),
  fromBranchDb: z.string().optional(),
  fromBranchRepo: z.string().optional(),
  fromBranch: z.string().min(1),
  toBranchOwner: z.string().optional(),
  toBranchDb: z.string().optional(),
  toBranchRepo: z.string().optional(),
  toBranch: z.string().optional(),
});

// Create a pull request. Used after a write to submit a branch upstream.
app.post('/debug/dolthub/:owner/:db/pulls', async c => {
  const token = getDoltHubToken(c);
  if (!token) return c.json({ error: 'Missing DoltHub token' }, 401);
  const { owner, db } = c.req.param();
  const parsed = await parseJsonBody(c, CreatePullBody);
  if ('response' in parsed) return parsed.response;
  // DoltHub wants camelCase params on POST /pulls
  const payload = {
    title: parsed.data.title,
    description: parsed.data.description ?? '',
    fromBranchOwnerName: parsed.data.fromBranchOwner,
    fromBranchRepoName: parsed.data.fromBranchDb ?? parsed.data.fromBranchRepo,
    fromBranchName: parsed.data.fromBranch,
    toBranchOwnerName: parsed.data.toBranchOwner ?? owner,
    toBranchRepoName: parsed.data.toBranchDb ?? parsed.data.toBranchRepo ?? db,
    toBranchName: parsed.data.toBranch ?? 'main',
  };
  const res = await fetch(`${DOLTHUB_API_BASE}/${owner}/${db}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `token ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
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
      // Walk the cause chain so the underlying DoltHub error (or whatever
      // the real failure was) is visible in the dev-server log, not just
      // the wrapped envelope's outer message.
      const chain: string[] = [];
      let cur: unknown = error;
      while (cur instanceof Error) {
        const next: {
          message: string;
          code?: string;
          status?: number;
          body?: unknown;
          url?: string;
        } = {
          message: cur.message,
        };
        const c = cur as { code?: unknown; status?: unknown; body?: unknown; url?: unknown };
        if (typeof c.code === 'string') next.code = c.code;
        if (typeof c.status === 'number') next.status = c.status;
        if (typeof c.url === 'string') next.url = c.url;
        if (c.body !== undefined) next.body = c.body;
        chain.push(JSON.stringify(next));
        cur = (cur as { cause?: unknown }).cause;
      }
      console.error(
        `[wasteland-trpc] error on ${path ?? 'unknown'}: ${chain.join(' \u2190 caused by \u2190 ')}`
      );
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
