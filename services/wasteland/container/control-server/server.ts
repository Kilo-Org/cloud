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
    console.log(
      JSON.stringify({ level: 'info', msg, ...flatten(data), ts: new Date().toISOString() })
    ),
  warn: (msg: string, data?: unknown) =>
    console.warn(
      JSON.stringify({ level: 'warn', msg, ...flatten(data), ts: new Date().toISOString() })
    ),
  error: (msg: string, data?: unknown) =>
    console.error(
      JSON.stringify({ level: 'error', msg, ...flatten(data), ts: new Date().toISOString() })
    ),
};

// ---------------------------------------------------------------------------
// Zod schemas for wl CLI output
// ---------------------------------------------------------------------------

const WantedItemSchema = z
  .object({
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
  })
  .passthrough();

type WantedItem = z.infer<typeof WantedItemSchema>;

const BrowseOutputSchema = z.array(WantedItemSchema);

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

const InitBodySchema = z.object({
  upstream: z.string().min(1),
  token: z.string().min(1),
  dolthubOrg: z.string().min(1),
});

const PostBodySchema = z.object({
  upstream: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  bounty: z.number().optional(),
  priority: z.number().int().min(0).max(3).optional(),
  type: z.enum(['feature', 'bug', 'docs', 'other']).optional(),
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
      await new Promise<void>(resolve => {
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

const CLI_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_LONG_MS = 600_000; // 10 min for slow ops like join/fork

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function execWl(
  args: string[],
  env: Record<string, string>,
  timeoutMs = CLI_TIMEOUT_MS
): Promise<ExecResult> {
  log.info('execWl', { args, envKeys: Object.keys(env), timeoutMs });

  const proc = Bun.spawn(['wl', ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeout = setTimeout(() => {
    log.error('wl command timed out, killing process', { args, timeoutMs });
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  // Strip spinner/backspace noise from terminal output
  const cleanStderr = stderr
    .replace(/[\x08]/g, '')
    .replace(/[|/\\-] Uploading\.\.\./g, '')
    .trim();
  const cleanStdout = stdout.replace(/[\x08]/g, '').trim();

  if (exitCode !== 0) {
    log.error('wl command failed', {
      args,
      exitCode,
      stdout: cleanStdout.slice(0, 1000),
      stderr: cleanStderr.slice(0, 1000),
    });
  }

  return { stdout: cleanStdout, stderr: cleanStderr, exitCode };
}

function buildEnv(token: string, upstream: string): Record<string, string> {
  const dolthubOrg = process.env.DOLTHUB_ORG ?? '';
  return {
    DOLTHUB_TOKEN: token,
    WL_UPSTREAM: upstream,
    ...(dolthubOrg ? { DOLTHUB_ORG: dolthubOrg } : {}),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const startTime = Date.now();
let lastOperationTimestamp: string | null = null;
let cachedWlVersion: string | null = null;
let joined = false;

// Init gate: all handlers that need wl await this. Resolves once wl join
// succeeds. On failure, resets so the next request retries.
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (joined) return;
  if (!initPromise) {
    initPromise = selfInit();
  }
  await initPromise;
  if (!joined) {
    // Previous attempt failed — allow retry on next call
    initPromise = null;
    throw new Error('Wasteland not initialized — wl join has not succeeded');
  }
}

async function getWlVersion(): Promise<string> {
  if (cachedWlVersion) return cachedWlVersion;
  try {
    const result = await execWl(['version'], {});
    cachedWlVersion = result.stdout.trim() || 'unknown';
  } catch {
    cachedWlVersion = 'unknown';
  }
  return cachedWlVersion;
}

async function runDolt(args: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(['dolt', ...args], {
    env: process.env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function configureDolt(): Promise<void> {
  const userName = process.env.DOLT_USER_NAME || process.env.DOLTHUB_ORG || 'wasteland';
  const userEmail = process.env.DOLT_USER_EMAIL || `${userName}@wasteland.kilo.ai`;

  // dolt commit requires user.name and user.email to be set globally
  for (const [key, value] of [
    ['user.name', userName],
    ['user.email', userEmail],
  ]) {
    const result = await runDolt(['config', '--global', '--add', key, value]);
    if (result.exitCode !== 0) {
      log.warn(`dolt config --add ${key} failed`, {
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
  }

  // dolt push requires a JWK credential keypair associated with the user's
  // DoltHub account. If a JWK is provided via DOLT_CREDS_JWK env var, write
  // it to a temp file and import it.
  const jwk = process.env.DOLT_CREDS_JWK;
  if (jwk) {
    const tmpPath = '/tmp/dolt-cred.jwk';
    await Bun.write(tmpPath, jwk);
    const result = await runDolt(['creds', 'import', tmpPath]);
    if (result.exitCode !== 0) {
      log.warn('dolt creds import failed', { stderr: result.stderr });
    } else {
      log.info('dolt creds imported from DOLT_CREDS_JWK');
      // Use the imported credential
      const lsResult = await runDolt(['creds', 'ls']);
      log.info('dolt creds available', { stdout: lsResult.stdout.trim() });
    }
  } else {
    // No JWK provided — create fresh creds. The user will need to add the
    // public key to their DoltHub account for push to work.
    const existing = await runDolt(['creds', 'ls']);
    if (!existing.stdout.includes('*')) {
      const newResult = await runDolt(['creds', 'new']);
      log.info('created new dolt credential', { stdout: newResult.stdout.trim() });
      log.warn(
        'no DOLT_CREDS_JWK provided — created fresh dolt credential. ' +
          'Add the public key above to your DoltHub account at https://www.dolthub.com/settings/credentials'
      );
    }
  }

  // Log the dolt credential state for debugging
  const credsCheck = await runDolt(['creds', 'check']);
  log.info('dolt creds check', {
    exitCode: credsCheck.exitCode,
    stdout: credsCheck.stdout.trim().slice(0, 500),
    stderr: credsCheck.stderr.trim().slice(0, 500),
  });

  log.info('dolt config set', { userName, userEmail });
}

async function joinUpstream(token: string, upstream: string): Promise<void> {
  if (joined) return;

  await configureDolt();

  const env = buildEnv(token, upstream);
  const result = await execWl(['join', upstream], env, CLI_TIMEOUT_LONG_MS);

  if (result.exitCode !== 0) {
    throw new Error(
      `wl join failed (exit ${result.exitCode}): stdout=${result.stdout.slice(0, 300)} stderr=${result.stderr.slice(0, 300)}`
    );
  }

  joined = true;
  log.info('wl join succeeded', { upstream });
}

// ---------------------------------------------------------------------------
// Startup self-init
// ---------------------------------------------------------------------------

async function selfInit(): Promise<void> {
  const upstream = process.env.WL_UPSTREAM;
  const token = process.env.DOLTHUB_TOKEN;
  const dolthubOrg = process.env.DOLTHUB_ORG;

  log.info('selfInit', {
    hasUpstream: !!upstream,
    hasToken: !!token,
    hasDolthubOrg: !!dolthubOrg,
    upstream: upstream ?? null,
    dolthubOrg: dolthubOrg ?? null,
  });

  if (!upstream || !token || !dolthubOrg) {
    log.warn('selfInit skipped: missing env vars');
    return;
  }

  try {
    await joinUpstream(token, upstream);
  } catch (err) {
    log.error('selfInit join failed', { error: err instanceof Error ? err.message : String(err) });
  }
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

async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>
): Promise<{ data: T } | { error: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { error: errorResponse('Invalid JSON body') };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: errorResponse(
        `Validation error: ${parsed.error.issues.map(i => i.message).join(', ')}`
      ),
    };
  }
  return { data: parsed.data };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleBrowse(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, BrowseBodySchema);
  if ('error' in body) return body.error;

  await ensureInit();

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

  await ensureInit();

  await mutationMutex.acquire();
  try {
    const env = buildEnv(token, body.data.upstream);
    const result = await execWl(['claim', body.data.itemId], env);

    if (result.exitCode !== 0) {
      log.error('wl claim failed', {
        stderr: result.stderr,
        exitCode: result.exitCode,
        itemId: body.data.itemId,
      });
      return errorResponse(`wl claim failed: ${result.stderr}`, 502);
    }

    lastOperationTimestamp = new Date().toISOString();
    log.info('wl claim completed', { itemId: body.data.itemId });
    return jsonResponse({ success: true });
  } finally {
    mutationMutex.release();
  }
}

async function handleDone(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, DoneBodySchema);
  if ('error' in body) return body.error;

  await ensureInit();

  await mutationMutex.acquire();
  try {
    const env = buildEnv(token, body.data.upstream);
    const result = await execWl(['done', body.data.itemId, '--evidence', body.data.evidence], env);

    if (result.exitCode !== 0) {
      log.error('wl done failed', {
        stderr: result.stderr,
        exitCode: result.exitCode,
        itemId: body.data.itemId,
      });
      return errorResponse(`wl done failed: ${result.stderr}`, 502);
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

  await ensureInit();

  await mutationMutex.acquire();
  try {
    const env = buildEnv(token, body.data.upstream);
    const args = ['post', '--title', body.data.title, '--description', body.data.description];
    if (body.data.bounty !== undefined) {
      args.push('--bounty', String(body.data.bounty));
    }
    if (body.data.priority !== undefined) {
      args.push('--priority', String(body.data.priority));
    }
    if (body.data.type !== undefined) {
      args.push('--type', body.data.type);
    }
    const result = await execWl(args, env);

    if (result.exitCode !== 0) {
      return errorResponse(`wl post failed: ${result.stderr}`, 502);
    }

    // Extract item ID from wl post output (e.g. "w-638b24c413")
    const itemIdMatch = result.stdout.match(/w-[0-9a-f]+/);
    const itemId = itemIdMatch ? itemIdMatch[0] : null;

    // Check if upstream push failed (non-fatal — item is saved locally)
    const pushFailed = result.stdout.includes('Push failed');
    if (pushFailed) {
      log.warn('wl post: item created locally but upstream push failed', { itemId });
    }

    lastOperationTimestamp = new Date().toISOString();
    log.info('wl post completed', { itemId, pushFailed });
    return jsonResponse({ success: true, itemId, pushFailed });
  } finally {
    mutationMutex.release();
  }
}

async function handleSync(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, SyncBodySchema);
  if ('error' in body) return body.error;

  await ensureInit();

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

  await ensureInit();

  const env = buildEnv(token, body.data.upstream);
  const result = await execWl(['status', body.data.itemId], env);

  if (result.exitCode !== 0) {
    log.error('wl status failed', {
      stderr: result.stderr,
      exitCode: result.exitCode,
      itemId: body.data.itemId,
    });
    return errorResponse(`wl status failed: ${result.stderr}`, 502);
  }

  lastOperationTimestamp = new Date().toISOString();
  log.info('wl status completed', { itemId: body.data.itemId });
  return jsonResponse({ output: result.stdout });
}

async function handleHealth(): Promise<Response> {
  const wlVersion = await getWlVersion();
  return jsonResponse({
    status: 'ok',
    wl_version: wlVersion,
    uptime: uptimeSeconds(),
    joined,
  });
}

async function checkJoined(upstream: string | null): Promise<boolean> {
  if (!upstream) return false;

  const result = await execWl(['list'], {});
  if (result.exitCode !== 0) return false;

  // wl list outputs one wasteland per line; check if our upstream is listed
  return result.stdout.includes(upstream);
}

async function getDoltCredPubKey(): Promise<string | null> {
  const result = await runDolt(['creds', 'ls']);
  if (result.exitCode !== 0) return null;
  // Active credential is marked with * prefix
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*')) {
      return trimmed.slice(1).trim();
    }
  }
  return null;
}

async function handleConfig(): Promise<Response> {
  const upstream = process.env.WL_UPSTREAM ?? null;
  const dolthubOrg = process.env.DOLTHUB_ORG ?? null;
  const hasToken = !!process.env.DOLTHUB_TOKEN;
  const hasJwk = !!process.env.DOLT_CREDS_JWK;
  const wlVersion = await getWlVersion();
  const isJoined = await checkJoined(upstream);
  const doltCredPubKey = await getDoltCredPubKey();

  // Keep the in-memory flag in sync
  if (isJoined) joined = true;

  return jsonResponse({
    joined: isJoined,
    upstream,
    dolthubOrg,
    hasToken,
    hasJwk,
    doltCredPubKey,
    wlVersion,
    uptime: uptimeSeconds(),
    lastOperation: lastOperationTimestamp,
  });
}

async function handleInit(req: Request): Promise<Response> {
  const body = await parseBody(req, InitBodySchema);
  if ('error' in body) return body.error;

  // Update process env so buildEnv picks up the org for this and future calls
  process.env.DOLTHUB_ORG = body.data.dolthubOrg;
  process.env.WL_UPSTREAM = body.data.upstream;
  process.env.DOLTHUB_TOKEN = body.data.token;

  // Reset init state so joinUpstream runs fresh
  joined = false;
  initPromise = null;

  try {
    await joinUpstream(body.data.token, body.data.upstream);
    return jsonResponse({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(`Init failed: ${message}`, 500);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type RouteHandler = (req: Request) => Promise<Response>;

const routes: Array<{ method: string; path: string; handler: RouteHandler }> = [
  { method: 'POST', path: '/wl/browse', handler: handleBrowse },
  { method: 'POST', path: '/wl/claim', handler: handleClaim },
  { method: 'GET', path: '/wl/config', handler: handleConfig },
  { method: 'POST', path: '/wl/done', handler: handleDone },
  { method: 'POST', path: '/wl/init', handler: handleInit },
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

// Kick off self-init (non-blocking — server is already listening).
// Handlers that need wl will await ensureInit() which shares this promise.
void ensureInit();

// ---------------------------------------------------------------------------
// Heartbeat — log status every 60 seconds
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 60_000;

setInterval(async () => {
  const wlVersion = await getWlVersion();
  log.info('heartbeat', {
    wl_version: wlVersion,
    uptime: uptimeSeconds(),
    joined,
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
