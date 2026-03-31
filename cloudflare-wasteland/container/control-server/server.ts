import { z } from 'zod';

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

function flatten(data?: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  return data as Record<string, unknown>;
}

const log = {
  info: (msg: string, data?: unknown) =>
    console.log(JSON.stringify({ level: 'info', msg, ...flatten(data), ts: new Date().toISOString() })),
  warn: (msg: string, data?: unknown) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...flatten(data), ts: new Date().toISOString() })),
  error: (msg: string, data?: unknown) =>
    console.error(JSON.stringify({ level: 'error', msg, ...flatten(data), ts: new Date().toISOString() })),
};

// ---------------------------------------------------------------------------
// Zod schemas for wl CLI output
// ---------------------------------------------------------------------------

const WantedItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  bounty: z.number().optional(),
  status: z.string().optional(),
  claimedBy: z.string().optional(),
  claimId: z.string().optional(),
  evidence: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough();

type WantedItem = z.infer<typeof WantedItemSchema>;

const BrowseOutputSchema = z.array(WantedItemSchema);

const ClaimOutputSchema = z.object({
  success: z.boolean().optional(),
  claimId: z.string().optional(),
}).passthrough();

const PostOutputSchema = z.object({
  success: z.boolean().optional(),
  itemId: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Request body schemas
// ---------------------------------------------------------------------------

const BrowseBodySchema = z.object({
  upstream: z.string().min(1),
});

const ClaimBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  userId: z.string().min(1),
});

const DoneBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  evidence: z.string().min(1),
});

const PostBodySchema = z.object({
  upstream: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  bounty: z.number().optional(),
});

const SyncBodySchema = z.object({
  upstream: z.string().min(1),
});

const JoinBodySchema = z.object({
  upstream: z.string().min(1),
});

const StatusBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Mutex for serializing mutations
// ---------------------------------------------------------------------------

function createMutex() {
  let locked = false;
  const waiting: Array<() => void> = [];

  return {
    async acquire(): Promise<void> {
      if (!locked) {
        locked = true;
        return;
      }
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    },
    release(): void {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        locked = false;
      }
    },
  };
}

const mutationMutex = createMutex();

// ---------------------------------------------------------------------------
// CLI execution helper
// ---------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 60_000;

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function execWl(
  args: string[],
  env: Record<string, string>,
): Promise<ExecResult> {
  const proc = Bun.spawn(['wl', ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeout = setTimeout(() => {
    proc.kill();
  }, CLI_TIMEOUT_MS);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  return { stdout, stderr, exitCode };
}

function buildEnv(token: string, upstream: string): Record<string, string> {
  return {
    DOLTHUB_TOKEN: token,
    WL_UPSTREAM: upstream,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const startTime = Date.now();
let lastOperationTimestamp: string | null = null;
let cachedWlVersion: string | null = null;

async function getWlVersion(): Promise<string> {
  if (cachedWlVersion) return cachedWlVersion;
  try {
    const result = await execWl(['--version'], {});
    cachedWlVersion = result.stdout.trim() || 'unknown';
  } catch {
    cachedWlVersion = 'unknown';
  }
  return cachedWlVersion;
}

function uptimeSeconds(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function extractToken(req: Request): string | null {
  return req.headers.get('DOLTHUB_TOKEN') ?? req.headers.get('dolthub_token');
}

async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<{ data: T } | { error: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { error: errorResponse('Invalid JSON body') };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { error: errorResponse(`Validation error: ${parsed.error.issues.map((i) => i.message).join(', ')}`) };
  }
  return { data: parsed.data };
}

// ---------------------------------------------------------------------------
// Mutation verification: re-query after mutation to confirm state change
// ---------------------------------------------------------------------------

async function verifyItemState(
  token: string,
  upstream: string,
  itemId: string,
  expectedCheck: (item: WantedItem) => boolean,
): Promise<{ verified: boolean; item?: WantedItem }> {
  const env = buildEnv(token, upstream);
  const result = await execWl(['status', itemId, '--json'], env);
  if (result.exitCode !== 0) {
    log.warn('verification re-query failed', { itemId, stderr: result.stderr });
    return { verified: false };
  }
  try {
    const item = WantedItemSchema.parse(JSON.parse(result.stdout));
    return { verified: expectedCheck(item), item };
  } catch {
    log.warn('verification parse failed', { itemId, stdout: result.stdout });
    return { verified: false };
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleBrowse(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, BrowseBodySchema);
  if ('error' in body) return body.error;

  const env = buildEnv(token, body.data.upstream);
  const result = await execWl(['browse', '--json'], env);

  if (result.exitCode !== 0) {
    log.error('wl browse failed', { stderr: result.stderr, exitCode: result.exitCode });
    return errorResponse(`wl browse failed: ${result.stderr}`, 502);
  }

  let items: WantedItem[];
  try {
    items = BrowseOutputSchema.parse(JSON.parse(result.stdout));
  } catch (err) {
    log.error('failed to parse browse output', { stdout: result.stdout, error: String(err) });
    return errorResponse('Failed to parse wl browse output', 502);
  }

  lastOperationTimestamp = new Date().toISOString();
  log.info('wl browse completed', { upstream: body.data.upstream, itemCount: items.length });
  return jsonResponse({ items });
}

async function handleClaim(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, ClaimBodySchema);
  if ('error' in body) return body.error;

  await mutationMutex.acquire();
  try {
    const env = buildEnv(token, body.data.upstream);
    const result = await execWl(['claim', body.data.itemId, '--json'], env);

    if (result.exitCode !== 0) {
      log.error('wl claim failed', { stderr: result.stderr, exitCode: result.exitCode, itemId: body.data.itemId });
      return errorResponse(`wl claim failed: ${result.stderr}`, 502);
    }

    let parsed: z.infer<typeof ClaimOutputSchema>;
    try {
      parsed = ClaimOutputSchema.parse(JSON.parse(result.stdout));
    } catch (err) {
      log.error('failed to parse claim output', { stdout: result.stdout, error: String(err) });
      return errorResponse('Failed to parse wl claim output', 502);
    }

    // Verify mutation
    const verification = await verifyItemState(
      token,
      body.data.upstream,
      body.data.itemId,
      (item) => item.claimedBy === body.data.userId || item.status === 'claimed',
    );
    if (!verification.verified) {
      log.warn('claim verification failed — mutation may be a no-op', { itemId: body.data.itemId });
      return errorResponse('Claim mutation could not be verified — possible no-op', 409);
    }

    lastOperationTimestamp = new Date().toISOString();
    log.info('wl claim completed', { itemId: body.data.itemId, claimId: parsed.claimId });
    return jsonResponse({ success: true, claimId: parsed.claimId });
  } finally {
    mutationMutex.release();
  }
}

async function handleDone(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, DoneBodySchema);
  if ('error' in body) return body.error;

  await mutationMutex.acquire();
  try {
    const env = buildEnv(token, body.data.upstream);
    const result = await execWl(['done', body.data.itemId, '--evidence', body.data.evidence, '--json'], env);

    if (result.exitCode !== 0) {
      log.error('wl done failed', { stderr: result.stderr, exitCode: result.exitCode, itemId: body.data.itemId });
      return errorResponse(`wl done failed: ${result.stderr}`, 502);
    }

    // Verify mutation
    const verification = await verifyItemState(
      token,
      body.data.upstream,
      body.data.itemId,
      (item) => item.status === 'done' || item.status === 'completed',
    );
    if (!verification.verified) {
      log.warn('done verification failed — mutation may be a no-op', { itemId: body.data.itemId });
      return errorResponse('Done mutation could not be verified — possible no-op', 409);
    }

    lastOperationTimestamp = new Date().toISOString();
    log.info('wl done completed', { itemId: body.data.itemId });
    return jsonResponse({ success: true });
  } finally {
    mutationMutex.release();
  }
}

async function handlePost(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, PostBodySchema);
  if ('error' in body) return body.error;

  await mutationMutex.acquire();
  try {
    const env = buildEnv(token, body.data.upstream);
    const args = ['post', '--title', body.data.title, '--description', body.data.description];
    if (body.data.bounty !== undefined) {
      args.push('--bounty', String(body.data.bounty));
    }
    args.push('--json');
    const result = await execWl(args, env);

    if (result.exitCode !== 0) {
      log.error('wl post failed', { stderr: result.stderr, exitCode: result.exitCode });
      return errorResponse(`wl post failed: ${result.stderr}`, 502);
    }

    let parsed: z.infer<typeof PostOutputSchema>;
    try {
      parsed = PostOutputSchema.parse(JSON.parse(result.stdout));
    } catch (err) {
      log.error('failed to parse post output', { stdout: result.stdout, error: String(err) });
      return errorResponse('Failed to parse wl post output', 502);
    }

    // Verify mutation — check that the new item exists
    if (parsed.itemId) {
      const verification = await verifyItemState(
        token,
        body.data.upstream,
        parsed.itemId,
        (item) => item.title === body.data.title,
      );
      if (!verification.verified) {
        log.warn('post verification failed — mutation may be a no-op', { itemId: parsed.itemId });
        return errorResponse('Post mutation could not be verified — possible no-op', 409);
      }
    }

    lastOperationTimestamp = new Date().toISOString();
    log.info('wl post completed', { itemId: parsed.itemId });
    return jsonResponse({ success: true, itemId: parsed.itemId });
  } finally {
    mutationMutex.release();
  }
}

async function handleSync(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, SyncBodySchema);
  if ('error' in body) return body.error;

  const env = buildEnv(token, body.data.upstream);
  const result = await execWl(['sync'], env);

  if (result.exitCode !== 0) {
    log.error('wl sync failed', { stderr: result.stderr, exitCode: result.exitCode });
    return errorResponse(`wl sync failed: ${result.stderr}`, 502);
  }

  lastOperationTimestamp = new Date().toISOString();
  log.info('wl sync completed', { upstream: body.data.upstream });
  return jsonResponse({ success: true });
}

async function handleJoin(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, JoinBodySchema);
  if ('error' in body) return body.error;

  const env = buildEnv(token, body.data.upstream);
  const result = await execWl(['join', body.data.upstream], env);

  if (result.exitCode !== 0) {
    log.error('wl join failed', { stderr: result.stderr, exitCode: result.exitCode });
    return errorResponse(`wl join failed: ${result.stderr}`, 502);
  }

  lastOperationTimestamp = new Date().toISOString();
  log.info('wl join completed', { upstream: body.data.upstream });
  return jsonResponse({ success: true });
}

async function handleStatus(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, StatusBodySchema);
  if ('error' in body) return body.error;

  const env = buildEnv(token, body.data.upstream);
  const result = await execWl(['status', body.data.itemId, '--json'], env);

  if (result.exitCode !== 0) {
    log.error('wl status failed', { stderr: result.stderr, exitCode: result.exitCode, itemId: body.data.itemId });
    return errorResponse(`wl status failed: ${result.stderr}`, 502);
  }

  let item: WantedItem;
  try {
    item = WantedItemSchema.parse(JSON.parse(result.stdout));
  } catch (err) {
    log.error('failed to parse status output', { stdout: result.stdout, error: String(err) });
    return errorResponse('Failed to parse wl status output', 502);
  }

  lastOperationTimestamp = new Date().toISOString();
  log.info('wl status completed', { itemId: body.data.itemId });
  return jsonResponse({ item });
}

async function handleHealth(): Promise<Response> {
  const wlVersion = await getWlVersion();
  return jsonResponse({
    status: 'ok',
    wl_version: wlVersion,
    uptime: uptimeSeconds(),
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type RouteHandler = (req: Request) => Promise<Response>;

const routes: Array<{ method: string; path: string; handler: RouteHandler }> = [
  { method: 'POST', path: '/wl/browse', handler: handleBrowse },
  { method: 'POST', path: '/wl/claim', handler: handleClaim },
  { method: 'POST', path: '/wl/done', handler: handleDone },
  { method: 'POST', path: '/wl/post', handler: handlePost },
  { method: 'POST', path: '/wl/sync', handler: handleSync },
  { method: 'POST', path: '/wl/join', handler: handleJoin },
  { method: 'POST', path: '/wl/status', handler: handleStatus },
  { method: 'GET', path: '/health', handler: handleHealth },
];

function matchRoute(method: string, pathname: string): RouteHandler | null {
  for (const route of routes) {
    if (route.method === method && route.path === pathname) {
      return route.handler;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8080;

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const handler = matchRoute(req.method, url.pathname);

    if (!handler) {
      return errorResponse('Not found', 404);
    }

    try {
      return await handler(req);
    } catch (err) {
      log.error('unhandled error in request handler', {
        method: req.method,
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse('Internal server error', 500);
    }
  },
});

log.info('wasteland control server started', { port: server.port });

// ---------------------------------------------------------------------------
// Heartbeat — log status every 60 seconds
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 60_000;

setInterval(async () => {
  const wlVersion = await getWlVersion();
  log.info('heartbeat', {
    wl_version: wlVersion,
    uptime: uptimeSeconds(),
    last_operation: lastOperationTimestamp,
  });
}, HEARTBEAT_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on('SIGTERM', () => {
  log.info('received SIGTERM, shutting down');
  server.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('received SIGINT, shutting down');
  server.stop();
  process.exit(0);
});
