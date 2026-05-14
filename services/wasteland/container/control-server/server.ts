import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
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

// `direct` is NOT a flag on wanted-item subcommands — it's only accepted by
// `wl join` and `wl create`. Wanted-item mutations always follow the mode
// configured on the fork (pr vs wild-west) at join time. The `direct` field
// below is kept in the body schemas for historical reasons (old callers) but
// is now ignored at the CLI boundary — see `buildItemArgs` below.
const LegacyDirectFlagShape = { direct: z.boolean().optional() } as const;

const ClaimBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  userId: z.string().min(1),
  ...LegacyDirectFlagShape,
});

const DoneBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  evidence: z.string().min(1),
  ...LegacyDirectFlagShape,
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
  ...LegacyDirectFlagShape,
});

const SyncBodySchema = z.object({
  upstream: z.string().min(1),
});

const JoinBodySchema = z.object({
  upstream: z.string().min(1),
});

const CreateBodySchema = z.object({
  upstream: z.string().min(1), // target org/db (e.g. "jfawcett/my-wasteland")
  name: z.string().optional(), // display name for the wasteland (wl --name)
  displayName: z.string().optional(), // rig display name (wl --display-name)
  handle: z.string().optional(), // rig handle (wl --handle; defaults to org part)
  email: z.string().optional(), // registration email
});

const StatusBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
});

const UnclaimBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  ...LegacyDirectFlagShape,
});

// `wl accept` takes --quality as an integer 1-5 (required), plus optional
// --reliability, --severity, --skills, --message. `message` attaches to the
// stamp, visible in `stamps.message`. We accept the user-friendly enum here
// and map it to the CLI's integer below.
const AcceptBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  quality: z.enum(['excellent', 'good', 'fair', 'poor']),
  message: z.string().optional(),
  ...LegacyDirectFlagShape,
});

// `wl accept` expects quality as an integer on a 1-5 scale. We use a 4-level
// enum in the admin UI (poor < fair < good < excellent) and translate here.
const QUALITY_TO_INT: Record<'excellent' | 'good' | 'fair' | 'poor', number> = {
  excellent: 5,
  good: 4,
  fair: 3,
  poor: 2,
};

// `wl reject` takes --reason (included in commit message). No --comment.
const RejectBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  reason: z.string().min(1),
  ...LegacyDirectFlagShape,
});

const CloseBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  ...LegacyDirectFlagShape,
});

// Upstream-side commands adopt a fork submission. Same flag shapes as their
// non-upstream counterparts, except reject-upstream takes no reason at all
// (wl CLI has no flag for it — reject-upstream just closes the fork PR).
const AcceptUpstreamBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  rigHandle: z.string().min(1),
  quality: z.enum(['excellent', 'good', 'fair', 'poor']),
  message: z.string().optional(),
});

const RejectUpstreamBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  rigHandle: z.string().min(1),
});

const CloseUpstreamBodySchema = z.object({
  upstream: z.string().min(1),
  itemId: z.string().min(1),
  rigHandle: z.string().min(1),
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

/**
 * Log a warning when a caller passes `direct: true` on a wanted-item
 * subcommand. `--direct` is only accepted by `wl join` / `wl create`; the
 * wanted-item mutations inherit direct-vs-PR behavior from the mode the
 * fork was joined with. Early iterations of this service plumbed `direct`
 * through to every command, which was a bug — the CLI rejects those with
 * "unknown flag: --direct". We accept the field for backwards compatibility
 * but ignore it at the CLI boundary.
 */
function warnIfDirectRequested(subcommand: string, direct: boolean | undefined): void {
  if (direct) {
    log.warn('direct flag ignored', {
      subcommand,
      hint: 'wl wanted-item commands do not accept --direct; mode is set at join time',
    });
  }
}

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
// True once the container has received a DoltHub token via either an
// explicit /wl/init call OR the boot-time DOLTHUB_TOKEN env var. Reported
// through /wl/config so the caller can tell whether to re-init. Kept as
// a module flag instead of mutating process.env so the token itself
// never lives anywhere outside the request that provided it.
let hasInitToken = false;

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

async function runDolt(args: string[], cwd?: string): Promise<ExecResult> {
  const proc = Bun.spawn(['dolt', ...args], {
    env: process.env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// DoltHub SQL API — queries the upstream database via REST (no local clone)
// ---------------------------------------------------------------------------

const DOLTHUB_API_BASE = 'https://www.dolthub.com/api/v1alpha1';

async function dolthubSql(
  upstream: string,
  query: string,
  token: string
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const url = `${DOLTHUB_API_BASE}/${upstream}/main?q=${encodeURIComponent(query)}`;

  let res: Response;
  try {
    // `cache: 'no-store'` + `cache-control: no-cache` defeats any edge
    // cache between us and DoltHub. Without this, freshly merged rows can
    // take up to a minute to become visible via the SQL API even though
    // the merge has completed — we'd rather pay the round-trip every time
    // than show stale claim state on the board.
    res = await fetch(url, {
      cache: 'no-store',
      headers: {
        authorization: `token ${token}`,
        'cache-control': 'no-cache',
      },
    });
  } catch (err) {
    return {
      rows: [],
      error: `DoltHub API fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { rows: [], error: `DoltHub API ${res.status}: ${body.slice(0, 300)}` };
  }

  try {
    const data: unknown = await res.json();
    // DoltHub REST API returns { query_execution_status: "Success", ..., rows: [...] }
    const parsed = z
      .object({ rows: z.array(z.record(z.string(), z.unknown())) })
      .passthrough()
      .safeParse(data);
    if (parsed.success) return { rows: parsed.data.rows };
    // Fallback: maybe the response is just an array
    const arr = z.array(z.record(z.string(), z.unknown())).safeParse(data);
    if (arr.success) return { rows: arr.data };
    return {
      rows: [],
      error: `Unexpected DoltHub API response format: ${JSON.stringify(data).slice(0, 300)}`,
    };
  } catch {
    return { rows: [], error: 'Failed to parse DoltHub API response' };
  }
}

/**
 * Probes DoltHub to confirm `{owner}/{db}` exists before we attempt
 * `wl join` against it. Used as a defensive check during selfInit so a
 * mis-configured `WL_UPSTREAM` (typo, repo deleted, intent recorded
 * before `wl create` ran, …) doesn't push the container into a
 * crash-loop.
 *
 * Two-stage to avoid DoltHub's "Calls authenticated with a token must
 * include a refName" 400: anonymous probe at `/{owner}/{db}` first,
 * authenticated `/{owner}/{db}/main` fallback only when the anonymous
 * probe says missing AND we have a token. `200 Error "branch not found"`
 * on the auth fallback also counts as exists (non-`main` default branch).
 */
async function upstreamExistsOnDolthub(upstream: string, token: string | null): Promise<boolean> {
  const parsed = parseUpstream(upstream);
  if (!parsed) return false;
  const { org, db } = parsed;

  const anonRes = await fetch(
    `${DOLTHUB_API_BASE}/${org}/${db}?q=${encodeURIComponent('SELECT 1')}`,
    { cache: 'no-store', headers: { 'cache-control': 'no-cache' } }
  ).catch(() => null);
  if (anonRes?.ok) {
    const data = await anonRes.json().catch(() => null);
    if (
      data &&
      typeof data === 'object' &&
      (data as Record<string, unknown>).query_execution_status === 'Success'
    ) {
      return true;
    }
  }
  if (!token) return false;

  const authRes = await fetch(
    `${DOLTHUB_API_BASE}/${org}/${db}/main?q=${encodeURIComponent('SELECT 1')}`,
    {
      cache: 'no-store',
      headers: { authorization: `token ${token}`, 'cache-control': 'no-cache' },
    }
  ).catch(() => null);
  if (!authRes?.ok) return false;
  const data = await authRes.json().catch(() => null);
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (obj.query_execution_status === 'Success') return true;
  if (
    obj.query_execution_status === 'Error' &&
    typeof obj.query_execution_message === 'string' &&
    /branch not found/i.test(obj.query_execution_message)
  ) {
    return true;
  }
  return false;
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

/**
 * Parse an upstream path like "jrf0110/wl-commons" into { org, db }.
 */
function parseUpstream(upstream: string): { org: string; db: string } | null {
  const parts = upstream.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { org: parts[0], db: parts[1] };
}

/**
 * Check whether the given rig handle is already registered in the upstream
 * `rigs` table. Returns false on any API error (caller falls back to `wl join`
 * which will report a clearer error if DoltHub is genuinely unreachable).
 */
async function isRigRegisteredOnUpstream(
  upstream: string,
  handle: string,
  token: string
): Promise<boolean> {
  const escaped = handle.replace(/'/g, "''");
  const result = await dolthubSql(
    upstream,
    `SELECT handle FROM rigs WHERE handle = '${escaped}' LIMIT 1`,
    token
  );
  if (result.error) {
    log.warn('rigs pre-flight check failed — falling through to wl join', {
      upstream,
      handle,
      error: result.error,
    });
    return false;
  }
  return result.rows.length > 0;
}

/**
 * Write a synthetic wasteland config file so subsequent `wl` commands
 * (claim, post, done, …) treat this container as already joined.
 *
 * Uses backend=remote, which instructs the CLI to route all reads/writes
 * through the DoltHub REST API rather than a local dolt clone. This means
 * we don't need to fork the upstream or materialize a local clone on disk
 * just to satisfy the CLI's "am I joined?" check.
 */
async function writeJoinedConfig(upstream: string, handle: string, email: string): Promise<void> {
  const parsed = parseUpstream(upstream);
  if (!parsed) {
    throw new Error(`writeJoinedConfig: invalid upstream ${upstream}`);
  }

  const configDir = pathJoin(homedir(), '.config', 'wasteland', 'wastelands', parsed.org);
  const configPath = pathJoin(configDir, `${parsed.db}.json`);

  const cfg = {
    upstream,
    provider_type: 'dolthub',
    upstream_url: `https://doltremoteapi.dolthub.com/${parsed.org}/${parsed.db}`,
    fork_org: handle,
    fork_db: parsed.db,
    local_dir: '',
    rig_handle: handle,
    hop_uri: `hop://${email}/${handle}/`,
    joined_at: new Date().toISOString(),
    mode: 'pr',
    backend: 'remote',
  };

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  log.info('wrote synthetic wasteland config', { configPath, handle });
}

async function joinUpstream(token: string, upstream: string): Promise<void> {
  if (joined) return;

  await configureDolt();

  const handle = process.env.DOLTHUB_ORG ?? '';
  // Pre-flight: if this rig is already registered on the upstream, skip the
  // full `wl join` flow (fork → clone → branch → registration PR). A fresh
  // container has no XDG config, so stock `wl join` would otherwise open a
  // redundant "Register rig" PR on every cold start.
  if (handle) {
    const alreadyRegistered = await isRigRegisteredOnUpstream(upstream, handle, token);
    if (alreadyRegistered) {
      const email = process.env.DOLT_USER_EMAIL || `${handle}@wasteland.kilo.ai`;
      try {
        await writeJoinedConfig(upstream, handle, email);
        joined = true;
        log.info('skipped wl join: rig already registered upstream', { upstream, handle });
        return;
      } catch (err) {
        log.warn('writeJoinedConfig failed — falling through to wl join', {
          upstream,
          handle,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

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

  // Defensive: if the configured upstream isn't on DoltHub yet (typo,
  // repo deleted, or selfInit racing ahead of `wl create`), don't run
  // `wl join` against it — it'll exit 1 with "Fork required" and crash
  // the container. We log loudly and return so the next explicit
  // `/wl/init` call (after the repo has been created) can retry.
  const upstreamReady = await upstreamExistsOnDolthub(upstream, token).catch(() => false);
  if (!upstreamReady) {
    log.warn('selfInit deferred: upstream not present on DoltHub yet', {
      upstream,
      hint: 'Will retry on next /wl/init request once the repo is created via /wl/create.',
    });
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

  // Query the upstream wanted board directly via DoltHub SQL API.
  // The wl CLI defaults to remote mode (DoltHub REST API) — there is no
  // local dolt clone to query, so we hit the API directly.
  const result = await dolthubSql(
    body.data.upstream,
    `SELECT id, title, description, project, type, priority, tags,
            posted_by, claimed_by, status, effort_level, evidence_url,
            sandbox_required, sandbox_scope, sandbox_min_tier,
            created_at, updated_at
     FROM wanted
     ORDER BY GREATEST(COALESCE(updated_at, created_at), COALESCE(created_at, updated_at)) DESC`,
    token
  );

  if (result.error) {
    log.error('dolthub sql browse failed', { error: result.error });
    return errorResponse(`Browse query failed: ${result.error}`, 502);
  }

  lastOperationTimestamp = new Date().toISOString();
  log.info('browse completed via dolthub api', { itemCount: result.rows.length });
  return jsonResponse({ items: result.rows });
}

/**
 * Parse the `PR: <url>` line emitted by `wl`'s renderMutationResult helper
 * when a mutation was pushed to a fork branch and a PR was opened. Returns
 * null when the output carries no PR line (e.g. direct mode, or upstream
 * provider that doesn't support PRs). We match on a URL prefix rather than
 * a full regex to stay resilient to DoltHub domain changes.
 */
function parsePrUrlFromWlOutput(stdout: string): string | null {
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('PR:')) continue;
    const rest = line.slice(3).trim();
    if (rest.startsWith('http://') || rest.startsWith('https://')) return rest;
  }
  return null;
}

async function handleClaim(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, ClaimBodySchema);
  if ('error' in body) return body.error;

  await ensureInit();

  await mutationMutex.acquire();
  try {
    warnIfDirectRequested('claim', body.data.direct);
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

    const prUrl = parsePrUrlFromWlOutput(result.stdout);
    lastOperationTimestamp = new Date().toISOString();
    log.info('wl claim completed', { itemId: body.data.itemId, prUrl });
    return jsonResponse({ success: true, pr_url: prUrl });
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
    warnIfDirectRequested('done', body.data.direct);
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
    warnIfDirectRequested('post', body.data.direct);
    const env = buildEnv(token, body.data.upstream);
    const rest: string[] = ['--title', body.data.title, '--description', body.data.description];
    if (body.data.bounty !== undefined) {
      rest.push('--bounty', String(body.data.bounty));
    }
    if (body.data.priority !== undefined) {
      rest.push('--priority', String(body.data.priority));
    }
    if (body.data.type !== undefined) {
      rest.push('--type', body.data.type);
    }
    const result = await execWl(['post', ...rest], env);

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

// Simple wrapper for `wl` commands that take an itemId and no body options.
async function runWlItemCmd(
  req: Request,
  schema: typeof UnclaimBodySchema | typeof CloseBodySchema,
  wlCmd: 'unclaim' | 'close'
): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, schema);
  if ('error' in body) return body.error;

  await ensureInit();

  await mutationMutex.acquire();
  try {
    warnIfDirectRequested(wlCmd, body.data.direct);
    const env = buildEnv(token, body.data.upstream);
    const result = await execWl([wlCmd, body.data.itemId], env);
    if (result.exitCode !== 0) {
      log.error(`wl ${wlCmd} failed`, { stderr: result.stderr, itemId: body.data.itemId });
      return errorResponse(`wl ${wlCmd} failed: ${result.stderr}`, 502);
    }
    lastOperationTimestamp = new Date().toISOString();
    log.info(`wl ${wlCmd} completed`, { itemId: body.data.itemId });
    return jsonResponse({ success: true });
  } finally {
    mutationMutex.release();
  }
}

async function handleUnclaim(req: Request): Promise<Response> {
  return runWlItemCmd(req, UnclaimBodySchema, 'unclaim');
}

async function handleClose(req: Request): Promise<Response> {
  return runWlItemCmd(req, CloseBodySchema, 'close');
}

async function handleAccept(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, AcceptBodySchema);
  if ('error' in body) return body.error;

  await ensureInit();

  await mutationMutex.acquire();
  try {
    warnIfDirectRequested('accept', body.data.direct);
    const env = buildEnv(token, body.data.upstream);
    const args = [
      'accept',
      body.data.itemId,
      '--quality',
      String(QUALITY_TO_INT[body.data.quality]),
    ];
    if (body.data.message) {
      args.push('--message', body.data.message);
    }
    const result = await execWl(args, env);
    if (result.exitCode !== 0) {
      log.error('wl accept failed', { stderr: result.stderr, itemId: body.data.itemId });
      return errorResponse(`wl accept failed: ${result.stderr}`, 502);
    }
    lastOperationTimestamp = new Date().toISOString();
    log.info('wl accept completed', { itemId: body.data.itemId });
    return jsonResponse({ success: true });
  } finally {
    mutationMutex.release();
  }
}

async function handleReject(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, RejectBodySchema);
  if ('error' in body) return body.error;

  await ensureInit();

  await mutationMutex.acquire();
  try {
    warnIfDirectRequested('reject', body.data.direct);
    const env = buildEnv(token, body.data.upstream);
    const result = await execWl(['reject', body.data.itemId, '--reason', body.data.reason], env);
    if (result.exitCode !== 0) {
      log.error('wl reject failed', { stderr: result.stderr, itemId: body.data.itemId });
      return errorResponse(`wl reject failed: ${result.stderr}`, 502);
    }
    lastOperationTimestamp = new Date().toISOString();
    log.info('wl reject completed', { itemId: body.data.itemId });
    return jsonResponse({ success: true });
  } finally {
    mutationMutex.release();
  }
}

async function handleAcceptUpstream(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, AcceptUpstreamBodySchema);
  if ('error' in body) return body.error;

  await ensureInit();

  await mutationMutex.acquire();
  try {
    const env = buildEnv(token, body.data.upstream);
    const args = [
      'accept-upstream',
      body.data.itemId,
      body.data.rigHandle,
      '--quality',
      String(QUALITY_TO_INT[body.data.quality]),
    ];
    if (body.data.message) {
      args.push('--message', body.data.message);
    }
    const result = await execWl(args, env);
    if (result.exitCode !== 0) {
      log.error('wl accept-upstream failed', {
        stderr: result.stderr,
        itemId: body.data.itemId,
        rigHandle: body.data.rigHandle,
      });
      return errorResponse(`wl accept-upstream failed: ${result.stderr}`, 502);
    }
    lastOperationTimestamp = new Date().toISOString();
    log.info('wl accept-upstream completed', {
      itemId: body.data.itemId,
      rigHandle: body.data.rigHandle,
    });
    return jsonResponse({ success: true });
  } finally {
    mutationMutex.release();
  }
}

async function handleRejectUpstream(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, RejectUpstreamBodySchema);
  if ('error' in body) return body.error;

  await ensureInit();

  await mutationMutex.acquire();
  try {
    const env = buildEnv(token, body.data.upstream);
    // reject-upstream takes no reason flag; the wl CLI just closes the fork PR.
    const result = await execWl(['reject-upstream', body.data.itemId, body.data.rigHandle], env);
    if (result.exitCode !== 0) {
      log.error('wl reject-upstream failed', {
        stderr: result.stderr,
        itemId: body.data.itemId,
        rigHandle: body.data.rigHandle,
      });
      return errorResponse(`wl reject-upstream failed: ${result.stderr}`, 502);
    }
    lastOperationTimestamp = new Date().toISOString();
    log.info('wl reject-upstream completed', {
      itemId: body.data.itemId,
      rigHandle: body.data.rigHandle,
    });
    return jsonResponse({ success: true });
  } finally {
    mutationMutex.release();
  }
}

async function handleCloseUpstream(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, CloseUpstreamBodySchema);
  if ('error' in body) return body.error;

  await ensureInit();

  await mutationMutex.acquire();
  try {
    const env = buildEnv(token, body.data.upstream);
    const result = await execWl(['close-upstream', body.data.itemId, body.data.rigHandle], env);
    if (result.exitCode !== 0) {
      log.error('wl close-upstream failed', {
        stderr: result.stderr,
        itemId: body.data.itemId,
        rigHandle: body.data.rigHandle,
      });
      return errorResponse(`wl close-upstream failed: ${result.stderr}`, 502);
    }
    lastOperationTimestamp = new Date().toISOString();
    log.info('wl close-upstream completed', {
      itemId: body.data.itemId,
      rigHandle: body.data.rigHandle,
    });
    return jsonResponse({ success: true });
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

async function handleCreate(req: Request): Promise<Response> {
  const token = extractToken(req);
  if (!token) return errorResponse('Missing DOLTHUB_TOKEN header', 401);

  const body = await parseBody(req, CreateBodySchema);
  if ('error' in body) return body.error;

  // Ensure dolt has a global identity before `wl create` invokes
  // `dolt init` — without it `dolt init` errors with "Author identity
  // unknown". `joinUpstream` runs the same setup; create-mode skips
  // that path so we have to call it here directly.
  await configureDolt();

  // `wl create` initializes a new DoltHub repo with the commons schema,
  // registers the creator as the first rig (trust_level 3), and pushes.
  // We do NOT pass --local-only — in hosted mode the container pushes
  // directly to DoltHub via the token.
  const env = buildEnv(token, body.data.upstream);
  const args: string[] = ['create', body.data.upstream];
  if (body.data.name) args.push('--name', body.data.name);
  if (body.data.displayName) args.push('--display-name', body.data.displayName);
  if (body.data.handle) args.push('--handle', body.data.handle);
  if (body.data.email) args.push('--email', body.data.email);

  // wl create needs longer than the default for the DoltHub push.
  const result = await execWl(args, env, 300_000);

  if (result.exitCode !== 0) {
    log.error('wl create failed', {
      stderr: result.stderr,
      stdout: result.stdout,
      upstream: body.data.upstream,
    });
    return errorResponse(`wl create failed: ${result.stderr || result.stdout}`, 502);
  }

  // After `wl create` succeeds, set up the same local state
  // `joinUpstream` writes after a successful `wl join`: synthetic
  // wasteland config + `joined` flag + `WL_UPSTREAM` env var. Without
  // this, every subsequent request would call `ensureInit` →
  // `selfInit`, which would either re-run `wl join` (now redundant
  // and slow) or skip with "missing env vars" (because we never set
  // WL_UPSTREAM from `storeCredential` for not-yet-existing repos).
  // Mirroring `joinUpstream`'s post-success state keeps the create
  // path's container in the exact shape downstream handlers expect.
  const handle = body.data.handle ?? process.env.DOLTHUB_ORG ?? '';
  const email =
    body.data.email || process.env.DOLT_USER_EMAIL || `${handle || 'wasteland'}@wasteland.kilo.ai`;
  if (handle) {
    try {
      await writeJoinedConfig(body.data.upstream, handle, email);
    } catch (err) {
      // Non-fatal — `wl create` already succeeded on DoltHub. Worst
      // case the next request triggers `joinUpstream` which writes
      // the config itself. Log so we notice if this becomes common.
      log.warn('post-create writeJoinedConfig failed', {
        upstream: body.data.upstream,
        handle,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  process.env.WL_UPSTREAM = body.data.upstream;
  joined = true;

  lastOperationTimestamp = new Date().toISOString();
  log.info('wl create completed', { upstream: body.data.upstream });
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
  const hasToken = hasInitToken || !!process.env.DOLTHUB_TOKEN;
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

  // Update process env so `buildEnv` and other readers pick up the org
  // and upstream. The token is NOT stored in process.env — it lives only
  // in the current request's closure (and the per-command `wl` subprocess
  // env that `buildEnv` constructs). Storing it at process scope would
  // mean any future background task reading DOLTHUB_TOKEN picks up the
  // last /wl/init caller's token.
  process.env.DOLTHUB_ORG = body.data.dolthubOrg;
  process.env.WL_UPSTREAM = body.data.upstream;
  hasInitToken = true;

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
  { method: 'POST', path: '/wl/unclaim', handler: handleUnclaim },
  { method: 'GET', path: '/wl/config', handler: handleConfig },
  { method: 'POST', path: '/wl/done', handler: handleDone },
  { method: 'POST', path: '/wl/init', handler: handleInit },
  { method: 'POST', path: '/wl/post', handler: handlePost },
  { method: 'POST', path: '/wl/sync', handler: handleSync },
  { method: 'POST', path: '/wl/join', handler: handleJoin },
  { method: 'POST', path: '/wl/create', handler: handleCreate },
  { method: 'POST', path: '/wl/status', handler: handleStatus },
  { method: 'POST', path: '/wl/accept', handler: handleAccept },
  { method: 'POST', path: '/wl/reject', handler: handleReject },
  { method: 'POST', path: '/wl/close', handler: handleClose },
  { method: 'POST', path: '/wl/accept-upstream', handler: handleAcceptUpstream },
  { method: 'POST', path: '/wl/reject-upstream', handler: handleRejectUpstream },
  { method: 'POST', path: '/wl/close-upstream', handler: handleCloseUpstream },
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
// We catch rejection here so a transient init failure doesn't surface as
// an unhandled promise rejection (which Bun terminates the process on by
// default, producing a crash-loop). The error has already been logged
// inside `selfInit`; subsequent /wl/init requests will retry.
ensureInit().catch(err => {
  log.error('boot-time ensureInit rejected (will retry on next /wl/init)', {
    error: err instanceof Error ? err.message : String(err),
  });
});

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
