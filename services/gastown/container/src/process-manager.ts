/**
 * Agent manager — tracks agents as SDK-managed kilo sessions.
 *
 * Uses @kilocode/sdk's createKilo() to start server instances in-process
 * and client.event.subscribe() for typed event streams. No subprocesses,
 * no SSE text parsing, no ring buffers.
 */

import { createKilo, type KiloClient } from '@kilocode/sdk';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import type { ManagedAgent, StartAgentRequest } from './types';
import { reportAgentCompleted, reportMayorWaiting } from './completion-reporter';
import { buildKiloConfigContent } from './agent-runner';
import {
  getCurrentTownConfig,
  getLastAppliedEnvVarKeys,
  RESERVED_ENV_KEYS,
} from './control-server';
import { log } from './logger';
import { refreshTokenIfNearExpiry } from './token-refresh';

const MANAGER_LOG = '[process-manager]';

// Validates the shape returned by client.session.create() so we fail fast
// if the SDK changes its return type.
const SessionResponse = z.object({ id: z.string().min(1) }).passthrough();

type SDKInstance = {
  client: KiloClient;
  server: { url: string; close(): void };
  sessionCount: number;
};

const agents = new Map<string, ManagedAgent>();
// One SDK server instance per workdir (shared by agents in the same worktree)
const sdkInstances = new Map<string, SDKInstance>();
// Tracks active event subscription abort controllers per agent
const eventAbortControllers = new Map<string, AbortController>();
// Event sinks for WebSocket forwarding
const eventSinks = new Set<(agentId: string, event: string, data: unknown) => void>();
// Per-agent idle timers — fires exit when no nudges arrive.
// Stores both the timer handle and the onExit callback so drainAll()
// can re-arm timers with a shorter timeout without duplicating exit logic.
const idleTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; onExit: () => void }>();

// Server-level lifecycle events that should NOT cancel an agent's idle
// timer. These fire periodically (heartbeat) or on connect and don't
// represent actual agent work. Includes runtime-only types that aren't
// in the SDK's TS union (e.g. 'server.heartbeat').
const IDLE_TIMER_IGNORE_EVENTS = new Set([
  'server.heartbeat',
  'server.connected',
  'server.instance.disposed',
]);

let nextPort = 4096;
const startTime = Date.now();

// Set to true when drainAll() starts — prevents new agent starts and
// lets the drain loop nudge agents that transition to running mid-drain.
let _draining = false;

export function isDraining(): boolean {
  return _draining;
}

// Mutex for ensureSDKServer — createKilo() reads process.cwd() and
// process.env during startup, so concurrent calls with different workdirs
// would corrupt each other's globals. This serializes server creation only;
// once created, the SDK instance is reused without locking.
let sdkServerLock: Promise<void> = Promise.resolve();

export function getUptime(): number {
  return Date.now() - startTime;
}

export function getStartTime(): string {
  return new Date(startTime).toISOString();
}

// Timestamp (ISO 8601) of the moment the first mayor agent in this container
// reached 'running' status. Used by /health so the Town DO can compute
// container-start-to-mayor-ready latency. Stays null until a mayor is up;
// survives subsequent mayor exits since the window is measured against the
// first mayor ready in the container's lifetime.
let mayorReadyAt: string | null = null;

export function getMayorReadyAt(): string | null {
  return mayorReadyAt;
}

function markMayorReadyOnce(): void {
  if (mayorReadyAt !== null) return;
  mayorReadyAt = new Date().toISOString();
  log.info('mayor.ready', {
    containerUptimeMs: getUptime(),
    mayorReadyAt,
  });
}

async function hydrateDbFromSnapshot(
  agentId: string,
  apiUrl: string,
  token: string,
  rigId: string,
  townId: string
): Promise<void> {
  const MANAGER_LOG = '[process-manager]';
  try {
    const resp = await fetch(
      `${apiUrl}/api/towns/${townId}/rigs/${rigId}/agents/${agentId}/db-snapshot`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!resp.ok) {
      if (resp.status === 404) {
        console.log(`${MANAGER_LOG} No DB snapshot found for agent ${agentId}, starting fresh`);
        return;
      }
      console.warn(`${MANAGER_LOG} Failed to fetch DB snapshot for ${agentId}: ${resp.status}`);
      return;
    }
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength === 0) {
      console.log(`${MANAGER_LOG} DB snapshot for ${agentId} is empty, skipping hydration`);
      return;
    }
    const dir = `/tmp/agent-home-${agentId}/.local/share/kilo`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/kilo.db`, Buffer.from(buffer));
    console.log(
      `${MANAGER_LOG} Hydrated DB snapshot for agent ${agentId} (${buffer.byteLength} bytes)`
    );
  } catch (err) {
    console.warn(`${MANAGER_LOG} DB hydration failed for agent ${agentId}:`, err);
  }
}

async function deleteLocalDb(agentId: string): Promise<void> {
  const dir = `/tmp/agent-home-${agentId}/.local/share/kilo`;
  for (const suffix of ['kilo.db', 'kilo.db-wal', 'kilo.db-shm']) {
    try {
      await fs.unlink(`${dir}/${suffix}`);
    } catch {
      // File may not exist — that's fine.
    }
  }
  console.log(`${MANAGER_LOG} Deleted local kilo.db for agent ${agentId}`);
}

async function deleteRemoteDbSnapshot(
  agentId: string,
  apiUrl: string,
  token: string,
  rigId: string,
  townId: string
): Promise<void> {
  try {
    const resp = await fetch(
      `${apiUrl}/api/towns/${townId}/rigs/${rigId}/agents/${agentId}/db-snapshot`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (resp.ok) {
      console.log(`${MANAGER_LOG} Deleted remote DB snapshot for agent ${agentId}`);
    } else {
      console.warn(
        `${MANAGER_LOG} Failed to delete remote DB snapshot for ${agentId}: ${resp.status}`
      );
    }
  } catch (err) {
    console.warn(`${MANAGER_LOG} deleteRemoteDbSnapshot failed for ${agentId}:`, err);
  }
}

/**
 * Try session.create; if it fails (e.g. stale kilo.db from an older CLI
 * version whose schema is incompatible), delete the local DB, tear down
 * the SDK server, restart it fresh, and retry once.
 */
async function createSessionWithStaleDbFallback(
  client: KiloClient,
  workdir: string,
  env: Record<string, string>,
  agentId: string,
  agent: ManagedAgent
): Promise<string> {
  const sessionResult = await client.session.create({ body: {} });
  const rawSession: unknown = sessionResult.data ?? sessionResult;
  const parsed = SessionResponse.safeParse(rawSession);
  if (parsed.success) {
    console.log(`${MANAGER_LOG} Created new session ${parsed.data.id}`);
    return parsed.data.id;
  }

  // session.create failed — likely a stale kilo.db migration error.
  const rawStr = JSON.stringify(rawSession).slice(0, 300);
  console.warn(
    `${MANAGER_LOG} session.create failed for ${agentId}, attempting stale DB recovery. Response: ${rawStr}`
  );

  // 1. Delete local kilo.db so the CLI starts with a fresh schema.
  await deleteLocalDb(agentId);

  // 2. Tear down the SDK server so ensureSDKServer creates a new one.
  const instance = sdkInstances.get(workdir);
  if (instance) {
    instance.server.close();
    sdkInstances.delete(workdir);
  }

  // 3. Delete the stale KV snapshot (fire-and-forget) so future container
  //    restarts don't re-hydrate the broken DB.
  const apiUrl = agent.gastownApiUrl;
  const token = agent.gastownContainerToken ?? process.env.GASTOWN_CONTAINER_TOKEN ?? null;
  if (apiUrl && token) {
    void deleteRemoteDbSnapshot(agentId, apiUrl, token, agent.rigId, agent.townId);
  }

  // 4. Restart SDK server and retry session.create.
  const { client: freshClient, port } = await ensureSDKServer(workdir, env);
  agent.serverPort = port;

  const retryResult = await freshClient.session.create({ body: {} });
  const retryRaw: unknown = retryResult.data ?? retryResult;
  const retryParsed = SessionResponse.safeParse(retryRaw);
  if (!retryParsed.success) {
    console.error(
      `${MANAGER_LOG} session.create still failing after DB reset:`,
      JSON.stringify(retryRaw).slice(0, 200),
      retryParsed.error.issues
    );
    throw new Error('SDK session.create failed even after stale DB recovery');
  }

  console.log(
    `${MANAGER_LOG} Stale DB recovery succeeded for ${agentId}, new session ${retryParsed.data.id}`
  );
  return retryParsed.data.id;
}

/**
 * Run `PRAGMA wal_checkpoint(TRUNCATE)` against kilo.db and return true
 * only if the WAL is fully drained into the main db file.
 *
 * The pragma returns `(busy, log, checkpointed)` as a row:
 *   busy=0 AND log == checkpointed  → WAL fully merged into main db
 *   anything else                    → main db is stale vs the WAL
 *
 * Returning true on an incomplete checkpoint would cause the caller to
 * upload a kilo.db that's missing recent writes (e.g. the just-accepted
 * mayor turn), overwriting the remote snapshot with stale state.
 */
async function runWalCheckpoint(dbPath: string, agentId: string): Promise<boolean> {
  try {
    const checkpoint = Bun.spawn(
      [
        'bun',
        '-e',
        `const db = new (require("bun:sqlite").Database)(process.argv[1]);
         const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
         process.stdout.write(JSON.stringify(row ?? null));`,
        dbPath,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const exitCode = await checkpoint.exited;
    const stdout = await new Response(checkpoint.stdout).text();
    const stderr = await new Response(checkpoint.stderr).text();

    if (exitCode !== 0) {
      console.warn(`${MANAGER_LOG} WAL checkpoint exited ${exitCode} for ${agentId}: ${stderr}`);
      return false;
    }

    // bun:sqlite returns the pragma row as an object. Accept snake_case,
    // camelCase, or bare positional keys (`0`, `1`, `2`) defensively.
    const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : null;
    if (!parsed || typeof parsed !== 'object') {
      console.warn(`${MANAGER_LOG} WAL checkpoint returned no row for ${agentId}: ${stdout}`);
      return false;
    }
    const row: Record<string, unknown> = { ...parsed };
    const busy = Number(row.busy ?? row['0'] ?? 0);
    const logFrames = Number(row.log ?? row['1'] ?? 0);
    const checkpointed = Number(row.checkpointed ?? row['2'] ?? 0);

    if (busy !== 0 || logFrames !== checkpointed) {
      console.warn(
        `${MANAGER_LOG} WAL checkpoint incomplete for ${agentId}: busy=${busy} log=${logFrames} checkpointed=${checkpointed}`
      );
      return false;
    }
    console.log(`${MANAGER_LOG} WAL checkpoint succeeded for ${agentId} (frames=${checkpointed})`);
    return true;
  } catch (err) {
    console.warn(`${MANAGER_LOG} WAL checkpoint failed for ${agentId}:`, err);
    return false;
  }
}

async function saveDbSnapshot(
  agentId: string,
  apiUrl: string,
  token: string,
  rigId: string,
  townId: string
): Promise<void> {
  const MANAGER_LOG = '[process-manager]';
  const t0 = Date.now();
  const role = agents.get(agentId)?.role ?? null;
  try {
    const dbDir = `/tmp/agent-home-${agentId}/.local/share/kilo`;
    const dbPath = `${dbDir}/kilo.db`;
    await fs.access(dbPath);

    // SQLite WAL mode stores recent writes in -wal/-shm files. We must
    // checkpoint the WAL into the main DB file before snapshotting so the
    // snapshot contains all data. Use bun's built-in SQLite to run PRAGMA
    // wal_checkpoint(TRUNCATE) which merges the WAL and truncates it.
    //
    // `PRAGMA wal_checkpoint(TRUNCATE)` returns a row `(busy, log, checkpointed)`:
    //   - busy=1 means another writer is holding the WAL and the checkpoint
    //     was blocked. The main kilo.db is then stale relative to the WAL.
    //   - log != checkpointed means the checkpoint only partially drained
    //     the WAL, so again the main db file is missing recent writes.
    //
    // Either case means uploading kilo.db would overwrite the remote
    // snapshot with a stale copy missing the messages this path is meant
    // to preserve. Skip the upload in that case.
    const checkpointOk = await runWalCheckpoint(dbPath, agentId);
    if (!checkpointOk) {
      console.warn(
        `${MANAGER_LOG} Skipping DB snapshot for ${agentId}: WAL not fully checkpointed`
      );
      log.error('mayor.snapshot_failed', {
        event: 'mayor.snapshot_failed',
        agentId,
        role,
        durationMs: Date.now() - t0,
        error: 'wal_checkpoint_incomplete',
        success: false,
      });
      return;
    }

    const buffer = await fs.readFile(dbPath);
    const resp = await fetch(
      `${apiUrl}/api/towns/${townId}/rigs/${rigId}/agents/${agentId}/db-snapshot`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: buffer,
      }
    );
    if (!resp.ok) {
      console.warn(`${MANAGER_LOG} Failed to save DB snapshot for ${agentId}: ${resp.status}`);
      log.error('mayor.snapshot_failed', {
        event: 'mayor.snapshot_failed',
        agentId,
        role,
        durationMs: Date.now() - t0,
        sizeBytes: buffer.byteLength,
        status: resp.status,
        success: false,
      });
      return;
    }
    console.log(
      `${MANAGER_LOG} Saved DB snapshot for agent ${agentId} (${buffer.byteLength} bytes)`
    );
    log.info('mayor.snapshot_saved', {
      event: 'mayor.snapshot_saved',
      agentId,
      role,
      durationMs: Date.now() - t0,
      sizeBytes: buffer.byteLength,
      success: true,
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      console.log(`${MANAGER_LOG} No kilo.db found for agent ${agentId}, skipping snapshot save`);
      return;
    }
    console.warn(`${MANAGER_LOG} DB snapshot save failed for agent ${agentId}:`, err);
    log.error('mayor.snapshot_failed', {
      event: 'mayor.snapshot_failed',
      agentId,
      role,
      durationMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      success: false,
    });
  }
}

/**
 * Sync the in-memory agents Map to the container registry so bootHydration
 * can resume agents after a container eviction. Only includes agents in
 * 'running' or 'starting' status (not exited/failed).
 *
 * Fire-and-forget — failures are logged but don't block the caller.
 */
function syncRegistry(): void {
  const apiUrl = process.env.GASTOWN_API_URL;
  const townId = process.env.GASTOWN_TOWN_ID;
  const token = process.env.GASTOWN_CONTAINER_TOKEN;
  if (!apiUrl || !townId || !token) return;

  const entries = [];
  for (const agent of agents.values()) {
    if (agent.status !== 'running' && agent.status !== 'starting') continue;
    entries.push({
      agentId: agent.agentId,
      request: agent.startupRequest,
      workdir: agent.workdir,
      env: agent.startupEnv,
    });
  }

  fetch(`${apiUrl}/api/towns/${townId}/container-registry`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(entries),
  }).catch(err => {
    console.warn(`${MANAGER_LOG} Failed to sync container registry:`, err);
  });
}

export function registerEventSink(
  sink: (agentId: string, event: string, data: unknown) => void
): void {
  eventSinks.add(sink);
}

export function unregisterEventSink(
  sink: (agentId: string, event: string, data: unknown) => void
): void {
  eventSinks.delete(sink);
}

// ── Event buffer for HTTP polling ─────────────────────────────────────
// The TownContainerDO polls GET /agents/:id/events?after=N to get events
// because containerFetch doesn't support WebSocket upgrades.
type BufferedEvent = {
  id: number;
  event: string;
  data: unknown;
  timestamp: string;
};
const MAX_BUFFERED_EVENTS = 2000;
const agentEventBuffers = new Map<string, BufferedEvent[]>();
let nextEventId = 1;

function bufferAgentEvent(agentId: string, event: string, data: unknown): void {
  let buf = agentEventBuffers.get(agentId);
  if (!buf) {
    buf = [];
    agentEventBuffers.set(agentId, buf);
  }
  buf.push({
    id: nextEventId++,
    event,
    data,
    timestamp: new Date().toISOString(),
  });
  if (buf.length > MAX_BUFFERED_EVENTS) {
    buf.splice(0, buf.length - MAX_BUFFERED_EVENTS);
  }
}

export function getAgentEvents(agentId: string, afterId = 0): BufferedEvent[] {
  const buf = agentEventBuffers.get(agentId);
  if (!buf) return [];
  return buf.filter(e => e.id > afterId);
}

function broadcastEvent(agentId: string, event: string, data: unknown): void {
  // Buffer in-memory for WebSocket backfill of late-joining clients
  bufferAgentEvent(agentId, event, data);

  // Send to WebSocket sinks (live streaming to browser)
  for (const sink of eventSinks) {
    try {
      sink(agentId, event, data);
    } catch (err) {
      console.warn(`${MANAGER_LOG} broadcastEvent: sink error`, err);
    }
  }

  // Persist to AgentDO via the worker (fire-and-forget)
  const agent = agents.get(agentId);
  // Prefer live container token (refreshed via POST /refresh-token),
  // then the per-agent cached token, then the legacy session token.
  const authToken =
    process.env.GASTOWN_CONTAINER_TOKEN ??
    agent?.gastownContainerToken ??
    agent?.gastownSessionToken;
  if (agent?.gastownApiUrl && authToken) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    };
    // When using a container JWT, send agent identity so the handler's
    // getEnforcedAgentId() ownership check still works.
    if (process.env.GASTOWN_CONTAINER_TOKEN || agent.gastownContainerToken) {
      headers['X-Gastown-Agent-Id'] = agentId;
      if (agent.rigId) headers['X-Gastown-Rig-Id'] = agent.rigId;
    }
    // POST to the worker's agent-events endpoint for persistent storage
    fetch(
      `${agent.gastownApiUrl}/api/towns/${agent.townId ?? '_'}/rigs/${agent.rigId ?? '_'}/agent-events`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agent_id: agentId,
          event_type: event,
          data,
        }),
      }
    ).catch(() => {
      // Best-effort persistence — don't block live streaming
    });
  }
}

/**
 * Get or create an SDK server instance for a workdir.
 *
 * createKilo() reads process.cwd() and process.env during startup, so
 * we must serialize server creation to prevent concurrent calls from
 * corrupting each other's globals. Once created, the SDK instance is
 * cached and returned without locking.
 */
async function ensureSDKServer(
  workdir: string,
  env: Record<string, string>
): Promise<{ client: KiloClient; port: number }> {
  // Fast path: reuse existing instance without locking.
  const existing = sdkInstances.get(workdir);
  if (existing) {
    return {
      client: existing.client,
      port: parseInt(new URL(existing.server.url).port),
    };
  }

  // Slow path: serialize server creation. createKilo() reads process.cwd()
  // and process.env, so concurrent calls with different workdirs must not
  // overlap. We capture the previous lock and install our own as the new
  // tail in the same synchronous microtask — no await between read and
  // write — so no concurrent caller can observe a stale sdkServerLock.
  const previousLock = sdkServerLock;
  let releaseLock!: () => void;
  sdkServerLock = new Promise<void>(resolve => {
    releaseLock = resolve;
  });

  await previousLock;

  try {
    // Re-check after acquiring lock — another caller may have created it.
    const cached = sdkInstances.get(workdir);
    if (cached) {
      return {
        client: cached.client,
        port: parseInt(new URL(cached.server.url).port),
      };
    }

    const port = nextPort++;
    console.log(`${MANAGER_LOG} Starting SDK server on port ${port} for ${workdir}`);

    // Keys that must persist on process.env after the SDK server starts.
    // KILO_CONFIG_CONTENT / OPENCODE_CONFIG_CONTENT carry the kilo provider
    // auth config (including organizationId) and must survive the snapshot
    // restore so extractOrganizationId() and subsequent model hot-swaps can
    // read them. GASTOWN_ORGANIZATION_ID is the standalone org ID env var.
    const PERSIST_ENV_KEYS = new Set([
      'KILO_CONFIG_CONTENT',
      'OPENCODE_CONFIG_CONTENT',
      'GASTOWN_ORGANIZATION_ID',
    ]);

    const envSnapshot: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
      envSnapshot[key] = process.env[key];
      process.env[key] = env[key];
    }

    const prevCwd = process.cwd();
    try {
      process.chdir(workdir);
      const { client, server } = await createKilo({
        hostname: '127.0.0.1',
        port,
        timeout: 30_000,
      });

      const instance: SDKInstance = { client, server, sessionCount: 0 };
      sdkInstances.set(workdir, instance);

      console.log(`${MANAGER_LOG} SDK server started: ${server.url}`);
      return { client, port };
    } finally {
      process.chdir(prevCwd);
      for (const [key, prev] of Object.entries(envSnapshot)) {
        // Never restore keys that must persist — keep the value we set above.
        if (PERSIST_ENV_KEYS.has(key)) continue;
        if (prev === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = prev;
        }
      }
    }
  } finally {
    releaseLock();
  }
}

/**
 * Zod schema for a single pending nudge returned by the gastown worker.
 */
const PendingNudge = z.object({
  nudge_id: z.string(),
  message: z.string(),
  mode: z.string(),
  priority: z.string(),
  source: z.string(),
});

const PendingNudgesResponse = z.object({
  success: z.boolean(),
  data: z.array(PendingNudge),
});

/**
 * Fetch pending nudges for an agent from the gastown worker.
 * Returns the array (may be empty), or null on error.
 */
async function fetchPendingNudges(
  agent: ManagedAgent
): Promise<z.infer<typeof PendingNudge>[] | null> {
  const authToken =
    process.env.GASTOWN_CONTAINER_TOKEN ?? agent.gastownContainerToken ?? agent.gastownSessionToken;
  if (!agent.gastownApiUrl || !authToken || !agent.townId || !agent.rigId) return null;

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${authToken}`,
      'X-Gastown-Agent-Id': agent.agentId,
      'X-Gastown-Rig-Id': agent.rigId,
    };
    const resp = await fetch(
      `${agent.gastownApiUrl}/api/towns/${agent.townId}/rigs/${agent.rigId}/agents/${agent.agentId}/pending-nudges`,
      { headers, signal: AbortSignal.timeout(10_000) }
    );
    if (!resp.ok) {
      console.warn(
        `${MANAGER_LOG} fetchPendingNudges: non-ok status ${resp.status} for agent ${agent.agentId}`
      );
      return null;
    }
    const raw: unknown = await resp.json();
    const parsed = PendingNudgesResponse.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `${MANAGER_LOG} fetchPendingNudges: unexpected response shape`,
        parsed.error.issues
      );
      return null;
    }
    return parsed.data.data;
  } catch (err) {
    console.warn(`${MANAGER_LOG} fetchPendingNudges: error for agent ${agent.agentId}:`, err);
    return null;
  }
}

/**
 * Mark a nudge as delivered via the gastown worker.
 */
async function markNudgeDelivered(agent: ManagedAgent, nudgeId: string): Promise<void> {
  const authToken =
    process.env.GASTOWN_CONTAINER_TOKEN ?? agent.gastownContainerToken ?? agent.gastownSessionToken;
  if (!agent.gastownApiUrl || !authToken || !agent.townId || !agent.rigId) return;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'X-Gastown-Agent-Id': agent.agentId,
      'X-Gastown-Rig-Id': agent.rigId,
    };
    await fetch(
      `${agent.gastownApiUrl}/api/towns/${agent.townId}/rigs/${agent.rigId}/agents/${agent.agentId}/nudge-delivered`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ nudge_id: nudgeId }),
      }
    );
  } catch (err) {
    console.warn(`${MANAGER_LOG} markNudgeDelivered: error for nudge ${nudgeId}:`, err);
  }
}

/**
 * Write eviction context on the agent's bead so the next agent dispatched
 * to it knows there is WIP code pushed to a branch. Appends a note to the
 * bead's body via the Gastown API.
 * Best-effort: errors are logged but never propagated.
 */
async function writeEvictionCheckpoint(
  agent: ManagedAgent,
  context: { branch: string; agent_name: string; saved_at: string }
): Promise<void> {
  const authToken =
    process.env.GASTOWN_CONTAINER_TOKEN ?? agent.gastownContainerToken ?? agent.gastownSessionToken;
  if (!agent.gastownApiUrl || !authToken || !agent.townId || !agent.rigId) {
    console.warn(
      `${MANAGER_LOG} writeEvictionCheckpoint: missing API credentials for ${agent.agentId}`
    );
    return;
  }

  try {
    const resp = await fetch(
      `${agent.gastownApiUrl}/api/towns/${agent.townId}/rigs/${agent.rigId}/agents/${agent.agentId}/eviction-context`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          'X-Gastown-Agent-Id': agent.agentId,
          'X-Gastown-Rig-Id': agent.rigId,
        },
        body: JSON.stringify(context),
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!resp.ok) {
      console.warn(`${MANAGER_LOG} writeEvictionCheckpoint: ${resp.status} for ${agent.agentId}`);
    }
  } catch (err) {
    console.warn(`${MANAGER_LOG} writeEvictionCheckpoint: error for ${agent.agentId}:`, err);
  }
}

/**
 * Clear the idle timer for an agent (if any).
 */
function clearIdleTimer(agentId: string): void {
  const entry = idleTimers.get(agentId);
  if (entry !== undefined) {
    clearTimeout(entry.timer);
    idleTimers.delete(agentId);
  }
}

/**
 * Handle a session.idle event for a non-mayor agent.
 *
 * - Checks for pending nudges and injects the highest-priority one if found.
 * - If no nudges are pending, starts (or restarts) an idle timeout that will
 *   exit the agent after AGENT_IDLE_TIMEOUT_MS (default 2 min).
 *
 * Returns true if the agent should continue (nudge injected or timer started),
 * false if the agent should exit immediately (injection failed unrecoverably).
 */
async function handleIdleEvent(agent: ManagedAgent, onExit: () => void): Promise<void> {
  const agentId = agent.agentId;
  console.log(`${MANAGER_LOG} handleIdleEvent: checking nudges for agent ${agentId}`);

  // During drain, skip the nudge fetch — it can hang if the container
  // runtime's outbound networking is degraded after SIGTERM. The agent
  // finished its work; just start the idle timer so it exits promptly.
  const nudges = _draining ? null : await fetchPendingNudges(agent);

  if (nudges === null) {
    // Error fetching — treat as no nudges, start idle timer
    console.warn(
      `${MANAGER_LOG} handleIdleEvent: could not fetch nudges for ${agentId}, starting idle timer`
    );
  } else if (nudges.length > 0 && agent.status === 'running') {
    // There is at least one pending nudge — inject the first (highest priority)
    const nudge = nudges[0];
    console.log(
      `${MANAGER_LOG} handleIdleEvent: injecting nudge ${nudge.nudge_id} (priority=${nudge.priority}) for agent ${agentId}`
    );
    // Cancel any existing idle timer since the agent will keep working
    clearIdleTimer(agentId);
    try {
      await sendMessage(agentId, nudge.message);
      // Mark delivered (fire-and-forget is fine — best effort)
      void markNudgeDelivered(agent, nudge.nudge_id);
    } catch (err) {
      console.warn(
        `${MANAGER_LOG} handleIdleEvent: sendMessage failed for agent ${agentId} (status=${agent.status}), exiting:`,
        err
      );
      onExit();
    }
    return;
  }

  // No nudges (or fetch error) — (re)start the idle timeout.
  // During drain, use a short idle timeout. Agents aren't nudged — they
  // complete naturally — so this idle means the agent is done with its
  // current work and can exit promptly.
  clearIdleTimer(agentId);
  let timeoutMs: number;
  if (_draining) {
    timeoutMs = 10_000;
  } else {
    timeoutMs =
      agent.role === 'refinery'
        ? process.env.REFINERY_IDLE_TIMEOUT_MS !== undefined
          ? Number(process.env.REFINERY_IDLE_TIMEOUT_MS)
          : 600_000
        : process.env.AGENT_IDLE_TIMEOUT_MS !== undefined
          ? Number(process.env.AGENT_IDLE_TIMEOUT_MS)
          : 120_000;
  }

  console.log(
    `${MANAGER_LOG} handleIdleEvent: no nudges for ${agentId}, idle timeout in ${timeoutMs}ms`
  );

  idleTimers.set(agentId, {
    onExit,
    timer: setTimeout(() => {
      idleTimers.delete(agentId);
      if (agent.status === 'running') {
        console.log(
          `${MANAGER_LOG} handleIdleEvent: idle timeout fired for agent ${agentId}, exiting`
        );
        onExit();
      }
    }, timeoutMs),
  });
}

/**
 * Subscribe to SDK events for an agent's session and forward them.
 */
async function subscribeToEvents(
  client: KiloClient,
  agent: ManagedAgent,
  request: StartAgentRequest
): Promise<void> {
  const controller = new AbortController();
  eventAbortControllers.set(agent.agentId, controller);

  // Called when the agent should exit cleanly after idle timeout or nudge failure.
  const exitAgent = () => {
    if (agent.status !== 'running') return;
    log.info('agent.exit', {
      agentId: agent.agentId,
      name: agent.name,
      reason: 'completed',
      exitReason: 'completed',
    });
    agent.status = 'exited';
    agent.exitReason = 'completed';
    broadcastEvent(agent.agentId, 'agent.exited', { reason: 'completed' });
    void reportAgentCompleted(agent, 'completed');
    syncRegistry();

    // Release SDK session so the server can shut down when idle
    const inst = sdkInstances.get(agent.workdir);
    if (inst) {
      inst.sessionCount--;
      if (inst.sessionCount <= 0) {
        inst.server.close();
        sdkInstances.delete(agent.workdir);
      }
    }

    // Save DB snapshot before completing exit
    const apiUrl = agent.gastownApiUrl;
    const token = agent.gastownContainerToken ?? process.env.GASTOWN_CONTAINER_TOKEN ?? null;
    if (apiUrl && token) {
      void saveDbSnapshot(agent.agentId, apiUrl, token, agent.rigId, agent.townId);
    }

    controller.abort();
  };

  try {
    console.log(`${MANAGER_LOG} Subscribing to events for agent ${agent.agentId}...`);
    const result = await client.event.subscribe();
    console.log(
      `${MANAGER_LOG} event.subscribe() returned: hasStream=${!!result.stream} keys=${Object.keys(result).join(',')}`
    );
    if (!result.stream) {
      console.warn(`${MANAGER_LOG} No event stream returned for agent ${agent.agentId}`);
      return;
    }

    let eventCount = 0;
    for await (const event of result.stream) {
      eventCount++;
      if (eventCount <= 3 || eventCount % 50 === 0) {
        console.log(
          `${MANAGER_LOG} Event #${eventCount} for agent ${agent.agentId}: type=${event.type}`
        );
      }
      if (controller.signal.aborted) break;

      // Filter by session
      const sessionID =
        event.properties && 'sessionID' in event.properties
          ? String(event.properties.sessionID)
          : undefined;
      if (sessionID && sessionID !== agent.sessionId) continue;

      agent.lastActivityAt = new Date().toISOString();
      agent.lastEventType = event.type ?? 'unknown';
      agent.lastEventAt = new Date().toISOString();

      // Track active tool calls
      if (event.properties && 'activeTools' in event.properties) {
        const tools = event.properties.activeTools;
        if (Array.isArray(tools)) {
          agent.activeTools = tools.filter((t): t is string => typeof t === 'string');
        }
      }

      // Broadcast to WebSocket sinks
      broadcastEvent(agent.agentId, event.type ?? 'unknown', event.properties ?? {});

      if (event.type === 'session.idle') {
        if (request.role === 'mayor') {
          // Mayor agents are persistent — session.idle means "turn done", not exit.
          // Notify the TownDO so it can transition the mayor to "waiting"
          // (alive in container, not doing LLM work). This lets the alarm
          // drop to the idle cadence and stops health-check pings that
          // would reset the container's sleepAfter timer.
          void reportMayorWaiting(agent);
          continue;
        }
        // Non-mayor: check for pending nudges before deciding to exit.
        // handleIdleEvent is async; we run it in the background so the event
        // loop continues. The exitAgent callback will abort the stream if needed.
        void handleIdleEvent(agent, exitAgent);
      } else if (!IDLE_TIMER_IGNORE_EVENTS.has(event.type ?? '')) {
        // Non-idle event means the agent resumed work — cancel any pending
        // idle timer. But skip server-level lifecycle events (heartbeats,
        // connections) that don't represent actual agent activity.
        clearIdleTimer(agent.agentId);
      }

      if (controller.signal.aborted) break;
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      log.error('agent.stream_error', {
        agentId: agent.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (agent.status === 'running') {
        clearIdleTimer(agent.agentId);
        agent.status = 'failed';
        agent.exitReason = 'Event stream error';
        broadcastEvent(agent.agentId, 'agent.exited', {
          reason: 'stream error',
        });
        void reportAgentCompleted(agent, 'failed', 'Event stream error');

        // Release SDK session on stream error (same cleanup as normal completion)
        const inst = sdkInstances.get(agent.workdir);
        if (inst) {
          inst.sessionCount--;
          if (inst.sessionCount <= 0) {
            inst.server.close();
            sdkInstances.delete(agent.workdir);
          }
        }
      }
    }
  } finally {
    clearIdleTimer(agent.agentId);
    // Only clear the map entry if it still points at *our* controller.
    // A concurrent refresh/model-swap may have already stored a fresh
    // controller for a new subscription; an unconditional delete here
    // would strand that stream with no way to abort it on future
    // stops or refreshes.
    const current = eventAbortControllers.get(agent.agentId);
    if (current === controller) {
      eventAbortControllers.delete(agent.agentId);
    }
  }
}

/**
 * Start an agent: ensure SDK server, create session, subscribe to events,
 * send initial prompt.
 */
export async function startAgent(
  request: StartAgentRequest,
  workdir: string,
  env: Record<string, string>
): Promise<ManagedAgent> {
  const existing = agents.get(request.agentId);
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    // Agent has a live session (probably idle after gt_done, waiting for
    // the idle timer). Stop it so the new dispatch can proceed.
    console.log(
      `${MANAGER_LOG} startAgent: stopping existing session for ${request.agentId} (status=${existing.status})`
    );

    // If the agent is still starting, abort the in-flight startup to prevent
    // an orphaned session from being created after stopAgent returns.
    if (existing.status === 'starting' && existing.startupAbortController) {
      console.log(`${MANAGER_LOG} startAgent: aborting in-flight startup for ${request.agentId}`);
      existing.startupAbortController.abort();
    }

    await stopAgent(request.agentId).catch(err => {
      console.warn(
        `${MANAGER_LOG} startAgent: failed to stop existing session for ${request.agentId}`,
        err
      );
    });
  }

  const now = new Date().toISOString();
  const startupAbortController = new AbortController();
  const agent: ManagedAgent = {
    agentId: request.agentId,
    rigId: request.rigId,
    townId: request.townId,
    role: request.role,
    name: request.name,
    status: 'starting',
    serverPort: 0,
    sessionId: '',
    workdir,
    startedAt: now,
    lastActivityAt: now,
    lastEventType: null,
    lastEventAt: null,
    activeTools: [],
    messageCount: 0,
    exitReason: null,
    gastownApiUrl: request.envVars?.GASTOWN_API_URL ?? process.env.GASTOWN_API_URL ?? null,
    gastownContainerToken:
      request.envVars?.GASTOWN_CONTAINER_TOKEN ?? process.env.GASTOWN_CONTAINER_TOKEN ?? null,
    gastownSessionToken: request.envVars?.GASTOWN_SESSION_TOKEN ?? null,
    completionCallbackUrl: request.envVars?.GASTOWN_COMPLETION_CALLBACK_URL ?? null,
    model: request.model ?? null,
    organizationId: request.organizationId ?? null,
    startupEnv: env,
    startupRequest: request,
    startupAbortController,
  };
  agents.set(request.agentId, agent);

  const { signal } = startupAbortController;
  let sessionCounted = false;
  const t0 = Date.now();
  try {
    // 0. Hydrate agent DB from KV snapshot before starting the SDK server
    const apiUrl = agent.gastownApiUrl;
    const token = agent.gastownContainerToken ?? process.env.GASTOWN_CONTAINER_TOKEN ?? null;
    if (apiUrl && token) {
      await hydrateDbFromSnapshot(request.agentId, apiUrl, token, request.rigId, request.townId);
    }
    const tDbDone = Date.now();
    log.info('agent.startup_phase', {
      agentId: request.agentId,
      phase: 'db_hydrated',
      elapsedMs: tDbDone - t0,
    });

    // 1. Ensure SDK server is running for this workdir
    const { client, port } = await ensureSDKServer(workdir, env);
    agent.serverPort = port;
    const tSdkDone = Date.now();
    log.info('agent.startup_phase', {
      agentId: request.agentId,
      phase: 'sdk_ready',
      elapsedMs: tSdkDone - t0,
      phaseMs: tSdkDone - tDbDone,
    });

    // Check if startup was cancelled while waiting for the SDK server
    if (signal.aborted) {
      throw new StartupAbortedError(request.agentId);
    }

    // Track session count on the SDK instance
    const instance = sdkInstances.get(workdir);
    if (instance) {
      instance.sessionCount++;
      sessionCounted = true;
    }

    // 2. Resume an existing session or create a new one.
    // Only the mayor resumes — it's a persistent conversational agent whose
    // session history should survive container evictions. Non-mayor agents
    // (polecats, refineries, triage) always get fresh sessions since they
    // work on a new bead each dispatch.
    let sessionId = '';
    let resumed = false;
    if (request.role === 'mayor') {
      const existingSessions = await client.session.list();
      const sessions = (existingSessions.data ?? []) as Array<{
        id: string;
        time?: { updated?: number };
      }>;
      if (sessions.length > 0) {
        const sorted = [...sessions].sort(
          (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
        );
        sessionId = sorted[0].id;
        resumed = true;
        console.log(
          `${MANAGER_LOG} Resuming existing mayor session ${sessionId} (${sessions.length} session(s) found)`
        );
      }
    }
    if (!resumed) {
      sessionId = await createSessionWithStaleDbFallback(
        client,
        workdir,
        env,
        request.agentId,
        agent
      );
    }
    agent.sessionId = sessionId;
    const tSessionDone = Date.now();
    log.info('agent.startup_phase', {
      agentId: request.agentId,
      phase: 'session_created',
      elapsedMs: tSessionDone - t0,
      phaseMs: tSessionDone - tSdkDone,
      resumed,
    });

    // Now check if startup was cancelled while creating the session.
    // agent.sessionId is already set, so the catch block will abort it.
    if (signal.aborted) {
      throw new StartupAbortedError(request.agentId);
    }

    // 3. Subscribe to events (async, runs in background)
    void subscribeToEvents(client, agent, request);

    // Mark as running BEFORE the initial prompt. The event subscription
    // is already active and events may be flowing (the agent is
    // functionally running). session.prompt() can block if the SDK
    // server is busy, which would leave the agent stuck in 'starting'
    // despite being active — causing the drain to wait indefinitely.
    if (agent.status === 'starting') {
      agent.status = 'running';
      if (request.role === 'mayor') {
        markMayorReadyOnce();
      }
    }

    // 4. Send the initial prompt
    // The model string is an OpenRouter-style ID like "anthropic/claude-sonnet-4.6".
    // The kilo provider (which wraps OpenRouter) takes the FULL model string as modelID.
    // providerID is always 'kilo' since we route through the Kilo gateway.
    let modelParam: { providerID: string; modelID: string } | undefined;
    if (request.model) {
      modelParam = { providerID: 'kilo', modelID: request.model };
    }

    // Final abort check before sending the prompt
    if (signal.aborted) {
      throw new StartupAbortedError(request.agentId);
    }

    // Skip the initial prompt for resumed sessions — the conversation
    // history is already in kilo.db and re-sending the startup prompt
    // would create a duplicate turn.
    if (!resumed) {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: request.prompt }],
          ...(modelParam ? { model: modelParam } : {}),
          ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        },
      });

      // If the event stream errored while we were awaiting the prompt,
      // the stream-error handler already set the agent to 'failed',
      // reported completion, and decremented sessionCount. Mark
      // sessionCounted false so the catch block doesn't double-decrement.
      if (agent.status === 'failed') {
        sessionCounted = false;
        throw new Error('Event stream failed during initial prompt');
      }
    }
    agent.startupAbortController = null;

    agent.messageCount = 1;

    log.info('agent.start', {
      agentId: request.agentId,
      role: request.role,
      name: request.name,
      sessionId,
      port,
    });

    log.info('agent.startup_complete', {
      agentId: request.agentId,
      totalMs: Date.now() - t0,
      containerUptimeMs: getUptime(),
    });

    syncRegistry();
    return agent;
  } catch (err) {
    // On abort, clean up silently — the new startAgent invocation will
    // proceed with a fresh entry.
    if (err instanceof StartupAbortedError) {
      console.log(`${MANAGER_LOG} startAgent: startup aborted for ${request.agentId}, cleaning up`);
      if (sessionCounted) {
        const instance = sdkInstances.get(workdir);
        if (instance) {
          // Abort the orphaned session if one was created before the abort
          if (agent.sessionId) {
            try {
              await instance.client.session.abort({ path: { id: agent.sessionId } });
            } catch (abortErr) {
              console.error(
                `${MANAGER_LOG} startAgent: failed to abort orphaned session ${agent.sessionId}:`,
                abortErr
              );
            }
          }
          instance.sessionCount--;
          if (instance.sessionCount <= 0) {
            instance.server.close();
            sdkInstances.delete(workdir);
          }
        }
      }
      if (agents.get(request.agentId) === agent) {
        agents.delete(request.agentId);
        syncRegistry();
      }
      throw err;
    }

    agent.status = 'failed';
    agent.startupAbortController = null;
    agent.exitReason = err instanceof Error ? err.message : String(err);
    syncRegistry();
    if (sessionCounted) {
      const instance = sdkInstances.get(workdir);
      if (instance) instance.sessionCount--;
    }
    throw err;
  }
}

/**
 * Thrown when a startup sequence is cancelled via AbortController.
 * Distinct from other errors so the catch block can clean up without
 * marking the agent as failed (a new startup is taking over).
 */
class StartupAbortedError extends Error {
  constructor(agentId: string) {
    super(`Startup aborted for agent ${agentId}`);
    this.name = 'StartupAbortedError';
  }
}

/**
 * Stop an agent by aborting its session.
 */
export async function stopAgent(agentId: string): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (agent.status !== 'running' && agent.status !== 'starting') return;

  // If still starting, abort the in-flight startup so session.create()
  // doesn't produce an orphaned session after we return.
  if (agent.startupAbortController) {
    agent.startupAbortController.abort();
    agent.startupAbortController = null;
  }

  agent.status = 'stopping';

  // Cancel any pending idle timer
  clearIdleTimer(agentId);

  // Abort event subscription
  const controller = eventAbortControllers.get(agentId);
  if (controller) controller.abort();

  // Abort the session via SDK
  try {
    const instance = sdkInstances.get(agent.workdir);
    if (instance) {
      await instance.client.session.abort({ path: { id: agent.sessionId } });
      instance.sessionCount--;
      // Stop server if no sessions left
      if (instance.sessionCount <= 0) {
        instance.server.close();
        sdkInstances.delete(agent.workdir);
      }
    }
  } catch (err) {
    log.warn('agent.stop_failed', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  agent.status = 'exited';
  agent.exitReason = 'stopped';
  log.info('agent.exit', { agentId, reason: 'stopped', exitReason: 'stopped' });
  broadcastEvent(agentId, 'agent.exited', { reason: 'stopped' });
  syncRegistry();

  // Save DB snapshot before completing stop
  const apiUrl = agent.gastownApiUrl;
  const token = agent.gastownContainerToken ?? process.env.GASTOWN_CONTAINER_TOKEN ?? null;
  if (apiUrl && token) {
    void saveDbSnapshot(agentId, apiUrl, token, agent.rigId, agent.townId);
  }
}

/**
 * Send a follow-up message to an agent.
 */
export async function sendMessage(agentId: string, prompt: string): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (agent.status !== 'running') {
    throw new Error(`Agent ${agentId} is not running (status: ${agent.status})`);
  }

  const instance = sdkInstances.get(agent.workdir);
  if (!instance) throw new Error(`No SDK instance for agent ${agentId}`);

  try {
    await instance.client.session.prompt({
      path: { id: agent.sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(agent.model ? { model: { providerID: 'kilo', modelID: agent.model } } : {}),
      },
    });
  } catch (err) {
    log.error('agent.send_failed', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  agent.messageCount++;
  agent.lastActivityAt = new Date().toISOString();

  // Mayor-only: snapshot kilo.db immediately after the user message is
  // accepted so the message survives a container crash mid-response.
  // Polecats/refineries/triage have different session semantics (fresh
  // session per dispatch) and rely on exit/drain snapshots.
  //
  // Prefer process.env.GASTOWN_CONTAINER_TOKEN over agent.gastownContainerToken:
  // /refresh-token updates the env var first (process.env.GASTOWN_CONTAINER_TOKEN
  // = body.token) and only then restarts agents, so the live env token is
  // always at least as fresh as the cached field. Using the cached field
  // first would 401 the snapshot upload after rotation and lose the turn
  // we are trying to preserve.
  if (agent.role === 'mayor') {
    const apiUrl = agent.gastownApiUrl;
    const token = process.env.GASTOWN_CONTAINER_TOKEN ?? agent.gastownContainerToken ?? null;
    if (apiUrl && token) {
      void saveDbSnapshot(agentId, apiUrl, token, agent.rigId, agent.townId);
    }
  }
}

/**
 * Extract the organizationId from durable agent state or process.env.
 *
 * Resolution order (most → least reliable):
 * 1. Agent's `organizationId` field — set at startup from StartAgentRequest,
 *    survives process.env restores and model hot-swaps.
 * 2. GASTOWN_ORGANIZATION_ID env var — set by control-server on /agents/start
 *    and updated on every PATCH /model via X-Town-Config.
 * 3. KILO_CONFIG_CONTENT — legacy fallback, may be absent after env restore.
 */
function extractOrganizationId(agent?: ManagedAgent): string | undefined {
  // Primary source: durable field on the agent object
  if (agent?.organizationId) return agent.organizationId;

  // Secondary: standalone env var
  const envOrgId = process.env.GASTOWN_ORGANIZATION_ID;
  if (envOrgId) return envOrgId;

  // Fallback: extract from KILO_CONFIG_CONTENT (legacy path)
  const raw = process.env.KILO_CONFIG_CONTENT;
  if (!raw) return undefined;
  try {
    const config = JSON.parse(raw) as Record<string, unknown>;
    const provider = config.provider as Record<string, unknown> | undefined;
    const kilo = provider?.kilo as Record<string, unknown> | undefined;
    const options = kilo?.options as Record<string, unknown> | undefined;
    const orgId = options?.kilocodeOrganizationId;
    return typeof orgId === 'string' ? orgId : undefined;
  } catch {
    return undefined;
  }
}

const MAYOR_STARTUP_PROMPT = 'Mayor ready. Waiting for instructions.';

/**
 * Env keys that may be refreshed at runtime by `POST /sync-config` or
 * `POST /refresh-token`. When rebuilding an agent's env for a live SDK
 * server restart, these are read from `process.env` (freshest source)
 * rather than `agent.startupEnv` (captured once at agent start).
 */
const LIVE_ENV_KEYS = new Set([
  'GASTOWN_CONTAINER_TOKEN',
  'GIT_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_INSTANCE_URL',
  'GITHUB_CLI_PAT',
  'GASTOWN_GIT_AUTHOR_NAME',
  'GASTOWN_GIT_AUTHOR_EMAIL',
  'GASTOWN_DISABLE_AI_COAUTHOR',
  'KILOCODE_TOKEN',
  'GASTOWN_ORGANIZATION_ID',
]);

/**
 * Build the env for a fresh `kilo serve` process that replaces an
 * agent's current SDK server. Used by both model hot-swap and
 * token-refresh hot-swap.
 *
 * Rules:
 * - Start from `agent.startupEnv` (original dispatch env).
 * - For every key in `LIVE_ENV_KEYS`, read from `process.env` so live
 *   updates (container-token refresh, config sync) are picked up.
 * - `KILO_CONFIG_CONTENT` / `OPENCODE_CONFIG_CONTENT` handling:
 *     - Model hot-swap (`updateAgentModel`) rebuilds these for the new
 *       model and writes them to `agent.startupEnv` before calling this
 *       helper, so picking them up from `startupEnv` keeps the hot-swap
 *       agent-specific.
 *     - Token refresh does not touch the model, so `startupEnv` already
 *       carries the correct per-agent config. Pulling it in here
 *       guarantees each agent restart sets its own config on
 *       `process.env` before `ensureSDKServer` spawns, even when a
 *       different agent's config was last left in the global env by a
 *       previous model swap or refresh.
 * - Overlay town-config custom `env_vars` so values added/changed
 *   after the initial dispatch are honoured. Infra keys in
 *   `LIVE_ENV_KEYS` and `RESERVED_ENV_KEYS` always win.
 * - Remove custom keys that were previously applied but have been
 *   dropped from the town config.
 * - Re-derive `GH_TOKEN` from the live `GITHUB_CLI_PAT` > `GIT_TOKEN`
 *   > `GITHUB_TOKEN` chain so a rotated token takes effect.
 */
function buildLiveHotSwapEnv(agent: ManagedAgent): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(agent.startupEnv)) {
    if (LIVE_ENV_KEYS.has(key)) {
      const live = process.env[key];
      if (live) env[key] = live;
      continue;
    }
    env[key] = value;
  }
  // Inject live values for LIVE_ENV_KEYS that were absent from startupEnv
  // (e.g. GASTOWN_ORGANIZATION_ID added after initial dispatch).
  for (const key of LIVE_ENV_KEYS) {
    if (key in env) continue;
    const live = process.env[key];
    if (live) env[key] = live;
  }

  // Overlay custom env_vars from the town config so hot-swap picks up
  // values that were added/changed after the initial dispatch. Infra
  // keys in LIVE_ENV_KEYS and RESERVED_ENV_KEYS always take precedence.
  const freshConfig = getCurrentTownConfig();
  const freshEnvVars = freshConfig?.env_vars;
  const freshCustomKeySet = new Set<string>();
  if (freshEnvVars !== null && typeof freshEnvVars === 'object' && !Array.isArray(freshEnvVars)) {
    for (const [key, value] of Object.entries(freshEnvVars as Record<string, unknown>)) {
      if (LIVE_ENV_KEYS.has(key)) continue;
      if (RESERVED_ENV_KEYS.has(key)) continue;
      freshCustomKeySet.add(key);
      if (value !== undefined && value !== null) {
        env[key] = typeof value === 'string' ? value : JSON.stringify(value);
      } else {
        delete env[key];
      }
    }
  }
  // Remove stale custom env vars that the town config no longer carries.
  for (const key of getLastAppliedEnvVarKeys()) {
    if (!freshCustomKeySet.has(key) && !LIVE_ENV_KEYS.has(key)) {
      delete env[key];
    }
  }

  // Re-derive GH_TOKEN from live values using the same priority chain
  // as buildAgentEnv: GITHUB_CLI_PAT > GIT_TOKEN > GITHUB_TOKEN.
  const liveGhToken =
    process.env.GITHUB_CLI_PAT ?? process.env.GIT_TOKEN ?? process.env.GITHUB_TOKEN;
  if (liveGhToken) {
    env.GH_TOKEN = liveGhToken;
  } else {
    delete env.GH_TOKEN;
  }

  return env;
}

// Per-agent timeout for the `ensureSDKServer` step of a token refresh.
// Server startup normally takes ~1-2s; anything beyond 6s means the
// spawn is stuck and we'd rather fall back to the old instance than
// block the caller. The TownDO alarm path has a 10s outer timeout, so
// each agent must finish well under that even with queuing effects
// from the sdkServerLock.
const REFRESH_AGENT_TIMEOUT_MS = 6_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      value => {
        clearTimeout(handle);
        resolve(value);
      },
      err => {
        clearTimeout(handle);
        reject(err);
      }
    );
  });
}

/**
 * Restart every running agent's SDK server so a newly-refreshed
 * `GASTOWN_CONTAINER_TOKEN` (or any other LIVE_ENV_KEYS value in
 * `process.env`) is inherited by the fresh `kilo serve` child process.
 *
 * The agent's session is preserved: the mayor resumes its existing
 * session (conversation history intact); other agents keep their
 * current session id, since kilo.db persists across the restart.
 *
 * Each agent is restarted independently; a failure to restart one
 * agent never blocks the others. Returns a per-agent summary so the
 * caller can log telemetry.
 */
export async function refreshTokenForAllAgents(): Promise<
  Array<{ agentId: string; success: boolean; durationMs: number; error?: string }>
> {
  // Only restart fully-running agents. A `starting` agent may not yet
  // have a `sessionId` or an `sdkInstances` entry (still hydrating the
  // DB or waiting on ensureSDKServer), and racing the startup path
  // would leave duplicate subscriptions, an over-counted sessionCount,
  // or an orphan server that never closes. `startAgent()` already
  // reads `process.env.GASTOWN_CONTAINER_TOKEN` when it spawns the
  // SDK server, so an agent that is still starting will pick up the
  // fresh token on its own as part of normal startup — no restart
  // needed. Agents in any terminal state (`exited`, `failed`, etc.)
  // are also skipped: restarting them would revive a process that the
  // completion/exit path already tore down.
  const snapshot = [...agents.values()].filter(a => a.status === 'running');

  // Restart agents in parallel. Each agent has its own workdir (and
  // therefore its own sdkInstances key), so the Map mutations don't
  // collide. Running serially would easily blow past the caller's
  // 10s timeout once we have more than a couple of agents.
  const restartAgent = async (
    agent: ManagedAgent
  ): Promise<{ agentId: string; success: boolean; durationMs: number; error?: string }> => {
    const t0 = Date.now();
    const oldInstance = sdkInstances.get(agent.workdir);
    const oldSessionId = agent.sessionId;
    const oldPort = agent.serverPort;
    // Track the pending ensureSDKServer promise separately so the timeout
    // path can clean up an orphan server if the spawn eventually resolves
    // after we've already given up. withTimeout races the promise with a
    // timer but cannot cancel the underlying spawn — the serialised SDK
    // server creation may still install an instance into sdkInstances
    // after we've restored the old one, leaking the fresh kilo serve child.
    let pendingEnsure: Promise<{ client: KiloClient; port: number }> | null = null;
    try {
      const hotSwapEnv = buildLiveHotSwapEnv(agent);

      // Tear down the existing SDK server so ensureSDKServer spawns
      // a fresh kilo serve child with the updated env. We don't close
      // it until after ensureSDKServer returns so fetch() during the
      // window still has somewhere to land — but process.env changes
      // are only visible to *new* child processes, so restarting the
      // server is the only way to propagate the fresh token.
      sdkInstances.delete(agent.workdir);

      pendingEnsure = ensureSDKServer(agent.workdir, hotSwapEnv);
      const { client, port } = await withTimeout(
        pendingEnsure,
        REFRESH_AGENT_TIMEOUT_MS,
        `ensureSDKServer for ${agent.agentId}`
      );
      // Spawn completed within the timeout — no orphan to clean up.
      pendingEnsure = null;
      agent.serverPort = port;

      // Resume the existing session. kilo.db is on disk and survives
      // the restart, so session.list returns the prior session(s).
      let newSessionId = oldSessionId;
      let resumed = false;
      try {
        const existing = await withTimeout(
          client.session.list(),
          2_000,
          `session.list for ${agent.agentId}`
        );
        const sessions = (existing.data ?? []) as Array<{
          id: string;
          time?: { updated?: number };
        }>;
        // Prefer the session we were already on; fall back to the most
        // recently updated one if that id is no longer present.
        const preferred = sessions.find(s => s.id === oldSessionId);
        if (preferred) {
          newSessionId = preferred.id;
          resumed = true;
        } else if (sessions.length > 0) {
          const sorted = [...sessions].sort(
            (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
          );
          newSessionId = sorted[0].id;
          resumed = true;
        }
      } catch (err) {
        log.warn('refresh_token.session_list_failed', {
          agentId: agent.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      agent.sessionId = newSessionId;
      const newInstance = sdkInstances.get(agent.workdir);
      if (newInstance) newInstance.sessionCount++;

      // New server is healthy — tear down the old one and its subscription.
      if (oldInstance) {
        const oldController = eventAbortControllers.get(agent.agentId);
        if (oldController) oldController.abort();
        try {
          oldInstance.server.close();
        } catch (err) {
          log.warn('refresh_token.old_server_close_failed', {
            agentId: agent.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Re-subscribe to events on the new server so the agent keeps
      // reporting activity after the swap.
      void subscribeToEvents(client, agent, {
        agentId: agent.agentId,
        role: agent.role,
        name: agent.name,
        model: agent.model ?? '',
        prompt: '',
        rigId: agent.rigId,
        townId: agent.townId,
        identity: '',
        gitUrl: '',
        branch: '',
        defaultBranch: '',
      });

      const durationMs = Date.now() - t0;
      log.info('refresh_token.agent_restarted', {
        agentId: agent.agentId,
        role: agent.role,
        name: agent.name,
        oldPort,
        newPort: port,
        oldSessionId,
        newSessionId,
        resumed,
        success: true,
        durationMs,
      });
      return { agentId: agent.agentId, success: true, durationMs };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      // Three failure shapes to unwind, distinguished by what's in
      // sdkInstances[workdir] and whether pendingEnsure is still set:
      //
      //   A. ensureSDKServer not yet resolved (pendingEnsure != null):
      //      the map is empty (we deleted at 1619 and nothing was put
      //      back yet). Restore old now; attach a reaper for the
      //      eventual orphan that ensureSDKServer will install when
      //      it finally resolves.
      //
      //   B. ensureSDKServer resolved, failure happened before or
      //      inside the block that installs the new instance:
      //      the map is empty. Restore old.
      //
      //   C. ensureSDKServer resolved AND new instance installed, but
      //      a post-start step threw (e.g. an added future check, or
      //      a throw from one of the already-caught calls if its
      //      handler is ever changed). The map contains the fresh
      //      instance. Close it, remove it, restore old, and point
      //      the agent back at the old port/session.
      const current = sdkInstances.get(agent.workdir);
      if (current && current !== oldInstance) {
        // Case C — fresh instance is installed. Tear it down and
        // restore the old one so we don't leak a kilo serve process
        // or leave the agent pointing at a partially-configured
        // server (no event subscription, no session count bump, old
        // server still alive on oldPort).
        sdkInstances.delete(agent.workdir);
        try {
          current.server.close();
        } catch (closeErr) {
          log.warn('refresh_token.fresh_close_failed', {
            agentId: agent.agentId,
            error: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        }
        if (oldInstance) {
          sdkInstances.set(agent.workdir, oldInstance);
          agent.serverPort = oldPort;
          agent.sessionId = oldSessionId;
        }
        log.warn('refresh_token.fresh_rolled_back', {
          agentId: agent.agentId,
          oldPort,
          error: message,
        });
      } else if (oldInstance && !sdkInstances.has(agent.workdir)) {
        // Case A/B — map is empty. Restore the old SDK instance in
        // the map so the agent keeps pointing at a tracked server.
        // The old kilo serve child still has the stale token, but
        // having SOME server is strictly better than having none:
        // session.prompt still works, and the next refresh / model
        // swap will pick it up again.
        sdkInstances.set(agent.workdir, oldInstance);
        agent.serverPort = oldPort;
        agent.sessionId = oldSessionId;
      }
      // If ensureSDKServer is still in flight, attach a reaper: when it
      // finally resolves it will have registered a fresh SDK instance
      // under agent.workdir, clobbering the restored old one. We evict
      // and close that orphan so we don't leak a kilo serve process or
      // leave the agent pointing at an un-subscribed server.
      if (pendingEnsure) {
        const reapWorkdir = agent.workdir;
        const reapAgentId = agent.agentId;
        const reapOldInstance = oldInstance;
        pendingEnsure.then(
          ({ port: orphanPort }) => {
            const orphan = sdkInstances.get(reapWorkdir);
            if (!orphan || orphan === reapOldInstance) return;
            sdkInstances.delete(reapWorkdir);
            if (reapOldInstance) {
              sdkInstances.set(reapWorkdir, reapOldInstance);
            }
            try {
              orphan.server.close();
            } catch (closeErr) {
              log.warn('refresh_token.orphan_close_failed', {
                agentId: reapAgentId,
                error: closeErr instanceof Error ? closeErr.message : String(closeErr),
              });
            }
            log.warn('refresh_token.orphan_reaped', {
              agentId: reapAgentId,
              orphanPort,
            });
          },
          () => {
            // ensureSDKServer itself rejected — nothing was installed, so
            // nothing to reap. The original timeout error already logged.
          }
        );
      }
      log.error('refresh_token.agent_restarted', {
        agentId: agent.agentId,
        role: agent.role,
        name: agent.name,
        success: false,
        durationMs,
        error: message,
      });
      return { agentId: agent.agentId, success: false, durationMs, error: message };
    }
  };

  return Promise.all(snapshot.map(restartAgent));
}

/**
 * Update the model for a running agent by restarting its SDK server with
 * new KILO_CONFIG_CONTENT. The kilo serve child process reads the model
 * from KILO_CONFIG_CONTENT at startup (highest config precedence after
 * enterprise managed config), so the only reliable way to change it is
 * to restart the server process.
 *
 * The agent's session is re-created on the new server and given the
 * startup prompt so the mayor is ready for instructions.
 *
 * @param model OpenRouter-style model ID (e.g. "anthropic/claude-sonnet-4.6")
 * @param smallModel Optional small model in the same format
 */
export async function updateAgentModel(
  agentId: string,
  model: string,
  smallModel?: string,
  conversationHistory?: string
): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (agent.status !== 'running' && agent.status !== 'starting') {
    throw new Error(`Agent ${agentId} is not running (status: ${agent.status})`);
  }

  const oldInstance = sdkInstances.get(agent.workdir);
  if (!oldInstance) throw new Error(`No SDK instance for agent ${agentId}`);

  const oldSessionId = agent.sessionId;
  const oldPort = agent.serverPort;
  const oldModel = agent.model;
  const prevConfigContent = process.env.KILO_CONFIG_CONTENT;
  const prevOpenCodeContent = process.env.OPENCODE_CONFIG_CONTENT;
  const prevStartupConfig = agent.startupEnv.KILO_CONFIG_CONTENT;
  const prevStartupOpenCode = agent.startupEnv.OPENCODE_CONFIG_CONTENT;

  console.log(
    `${MANAGER_LOG} updateAgentModel: restarting SDK server for agent ${agentId} with model=${model}`
  );

  // 1. Resolve the organizationId, preferring the freshly-updated process.env
  //    value over the cached agent field. The PATCH /model handler sets
  //    process.env.GASTOWN_ORGANIZATION_ID before calling updateAgentModel, so
  //    the env var is always at least as current as agent.organizationId and
  //    may carry a brand-new org context that hasn't been written to the agent
  //    record yet.
  const organizationId =
    process.env.GASTOWN_ORGANIZATION_ID || agent.organizationId || extractOrganizationId();

  // Keep both the agent's durable field and the startupEnv snapshot in sync
  // so that (a) future hot-swaps see the new value and (b) syncRegistry()
  // serialises the updated org context, preventing boot hydration from
  // reviving agents with the stale org after a container restart.
  if (organizationId) {
    agent.organizationId = organizationId;
    agent.startupEnv = { ...agent.startupEnv, GASTOWN_ORGANIZATION_ID: organizationId };
  }

  // 2. Rebuild KILO_CONFIG_CONTENT with the new model and persist it on
  //    `agent.startupEnv` so subsequent hot-swaps (including token
  //    refreshes performed by another code path) pick up the new model
  //    instead of replaying the stale dispatch-time config. We also set
  //    process.env as a secondary signal for any callers that read it
  //    directly, but buildLiveHotSwapEnv is the authoritative source
  //    now that it pulls KILO_CONFIG_CONTENT from startupEnv.
  const kilocodeToken = process.env.KILOCODE_TOKEN;
  if (kilocodeToken) {
    const configJson = buildKiloConfigContent(
      kilocodeToken,
      model,
      smallModel ?? 'anthropic/claude-haiku-4.5',
      organizationId
    );
    process.env.KILO_CONFIG_CONTENT = configJson;
    process.env.OPENCODE_CONFIG_CONTENT = configJson;
    agent.startupEnv = {
      ...agent.startupEnv,
      KILO_CONFIG_CONTENT: configJson,
      OPENCODE_CONFIG_CONTENT: configJson,
    };
  }

  // 3. Remove the old instance from the map so ensureSDKServer creates a
  //    new one — but DON'T close the old server yet. If the new server
  //    fails to start we can restore the old one.
  sdkInstances.delete(agent.workdir);
  agent.model = model;

  // Replay the full env from the initial dispatch so the new SDK server
  // gets the same git identity, auth tokens, and plugin vars.
  // KILO_CONFIG_CONTENT is now pulled from startupEnv (which we just
  // updated above), making this hot-swap agent-specific even when
  // process.env carries another agent's config.
  const hotSwapEnv = buildLiveHotSwapEnv(agent);

  try {
    // 4. Create a new SDK server (spawns a fresh kilo serve with updated env)
    const { client, port } = await ensureSDKServer(agent.workdir, hotSwapEnv);
    agent.serverPort = port;

    // 5. Resume the existing session or create a new one.
    //    The kilo.db on disk still has the prior session data, and the new
    //    kilo serve process reads it. For the mayor, resume so model swaps
    //    don't lose conversation history.
    let newSessionId = '';
    let resumedSession = false;
    if (agent.role === 'mayor') {
      const existing = await client.session.list();
      const sessions = (existing.data ?? []) as Array<{
        id: string;
        time?: { updated?: number };
      }>;
      if (sessions.length > 0) {
        const sorted = [...sessions].sort(
          (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
        );
        newSessionId = sorted[0].id;
        resumedSession = true;
        console.log(`${MANAGER_LOG} updateAgentModel: resuming existing session ${newSessionId}`);
      }
    }
    if (!resumedSession) {
      newSessionId = await createSessionWithStaleDbFallback(
        client,
        agent.workdir,
        hotSwapEnv,
        agentId,
        agent
      );
    }
    agent.sessionId = newSessionId;

    const newInstance = sdkInstances.get(agent.workdir);
    if (newInstance) {
      newInstance.sessionCount++;
    }

    // Only send the startup prompt for new sessions. Resumed sessions
    // already have conversation history in kilo.db — re-sending the
    // prompt would create a duplicate/synthetic turn.
    const prompt = conversationHistory
      ? `${conversationHistory}\n\n${MAYOR_STARTUP_PROMPT}`
      : MAYOR_STARTUP_PROMPT;
    if (!resumedSession) {
      const modelParam = { providerID: 'kilo', modelID: model };
      await client.session.prompt({
        path: { id: agent.sessionId },
        body: {
          parts: [{ type: 'text', text: prompt }],
          model: modelParam,
        },
      });
    }
    agent.messageCount = 1;

    // 6. New server is healthy — now tear down the old one.
    const oldController = eventAbortControllers.get(agentId);
    if (oldController) oldController.abort();
    oldInstance.server.close();

    // 7. Re-subscribe to events on the new session
    void subscribeToEvents(client, agent, {
      agentId: agent.agentId,
      role: agent.role,
      name: agent.name,
      model,
      prompt,
      rigId: agent.rigId,
      townId: agent.townId,
      identity: '',
      gitUrl: '',
      branch: '',
      defaultBranch: '',
    });

    console.log(
      `${MANAGER_LOG} updateAgentModel: SDK server restarted for agent ${agentId}, ` +
        `old session=${oldSessionId} new session=${agent.sessionId} model=${model}`
    );
  } catch (err) {
    // Restore the old server so the mayor keeps running on the previous model
    console.warn(
      `${MANAGER_LOG} updateAgentModel: failed for ${agentId}, restoring old server:`,
      err
    );
    sdkInstances.set(agent.workdir, oldInstance);
    agent.model = oldModel;
    agent.sessionId = oldSessionId;
    agent.serverPort = oldPort;
    if (prevConfigContent !== undefined) process.env.KILO_CONFIG_CONTENT = prevConfigContent;
    if (prevOpenCodeContent !== undefined)
      process.env.OPENCODE_CONFIG_CONTENT = prevOpenCodeContent;
    // Also restore the startupEnv copy; buildLiveHotSwapEnv now reads
    // from startupEnv, so a stale forward-config could carry over into
    // the next hot-swap otherwise.
    const restoredStartup = { ...agent.startupEnv };
    if (prevStartupConfig === undefined) {
      delete restoredStartup.KILO_CONFIG_CONTENT;
    } else {
      restoredStartup.KILO_CONFIG_CONTENT = prevStartupConfig;
    }
    if (prevStartupOpenCode === undefined) {
      delete restoredStartup.OPENCODE_CONFIG_CONTENT;
    } else {
      restoredStartup.OPENCODE_CONFIG_CONTENT = prevStartupOpenCode;
    }
    agent.startupEnv = restoredStartup;
    throw err;
  }
}

export function getAgentStatus(agentId: string): ManagedAgent | null {
  return agents.get(agentId) ?? null;
}

/** Return the SDK server port for an agent, or null if not running. */
export function getAgentServerPort(agentId: string): number | null {
  const agent = agents.get(agentId);
  if (!agent || !agent.serverPort) return null;
  return agent.serverPort;
}

export function listAgents(): ManagedAgent[] {
  return [...agents.values()];
}

export function activeAgentCount(): number {
  let count = 0;
  for (const a of agents.values()) {
    if (a.status === 'running' || a.status === 'starting') count++;
  }
  return count;
}

export function activeServerCount(): number {
  return sdkInstances.size;
}

/**
 * Gracefully drain all running agents before container eviction.
 *
 * 3-phase sequence:
 *   1. Notify TownDO of the eviction (blocks new dispatch)
 *   2. Wait up to 5 min for non-mayor agents to finish naturally
 *   3. Force-save any stragglers via WIP git commit + push
 *
 * No nudging — agents complete their current work via gt_done and
 * exit through the normal idle timeout path. The TownDO's draining
 * flag prevents new work from being dispatched.
 *
 * Never throws — all errors are logged and swallowed so the caller
 * can always proceed to stopAll() + process.exit().
 */
export async function drainAll(): Promise<void> {
  const DRAIN_LOG = '[drain]';
  _draining = true;

  // ── Phase 1: Notify TownDO ──────────────────────────────────────────
  try {
    const apiUrl = process.env.GASTOWN_API_URL;
    const token = process.env.GASTOWN_CONTAINER_TOKEN;
    // Grab townId from any registered agent — all agents in a container
    // belong to the same town.
    const anyAgent = [...agents.values()][0];
    const townId = anyAgent?.townId;

    if (apiUrl && token && townId) {
      console.log(`${DRAIN_LOG} Phase 1: notifying TownDO of container eviction`);
      const resp = await fetch(`${apiUrl}/api/towns/${townId}/container-eviction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      console.log(`${DRAIN_LOG} Phase 1: TownDO responded ${resp.status}`);
    } else {
      console.warn(
        `${DRAIN_LOG} Phase 1: skipping TownDO notification (missing apiUrl=${!!apiUrl} token=${!!token} townId=${!!townId})`
      );
    }
  } catch (err) {
    console.warn(`${DRAIN_LOG} Phase 1: TownDO notification failed, continuing:`, err);
  }

  // ── Phase 1b: Shorten idle timers ──────────────────────────────────────
  // Agents that are already idle (have a pending idle timer from a
  // session.idle event before drain started) are sitting in 120s/600s
  // timers. Replace them with short 10s timers so they exit promptly.
  // We can re-use the stored onExit callback from the original timer.
  for (const agent of agents.values()) {
    if (agent.role === 'mayor') continue;
    const entry = idleTimers.get(agent.agentId);
    if (entry) {
      console.log(
        `${DRAIN_LOG} Shortening idle timer for ${agent.role}:${agent.agentId.slice(0, 8)}`
      );
      clearTimeout(entry.timer);
      const { onExit } = entry;
      idleTimers.set(agent.agentId, {
        onExit,
        timer: setTimeout(() => {
          idleTimers.delete(agent.agentId);
          if (agent.status === 'running') {
            console.log(`${DRAIN_LOG} Shortened idle timer fired for ${agent.agentId.slice(0, 8)}`);
            onExit();
          }
        }, 10_000),
      });
    }
  }

  // ── Phase 2: Wait for agents to finish their current work ─────────────
  // No nudging — agents complete naturally (call gt_done, go idle, etc.).
  // The TownDO's draining flag blocks new dispatch so no new work starts.
  // We just give them time to wrap up, then Phase 3 force-saves stragglers.
  const DRAIN_WAIT_MS = 5 * 60 * 1000;
  const pollInterval = 5000;
  const start = Date.now();

  const allAgents = [...agents.values()];
  console.log(
    `${DRAIN_LOG} Phase 2: waiting up to ${DRAIN_WAIT_MS / 1000}s for non-mayor agents to finish. ` +
      `Statuses: ${allAgents.map(a => `${a.role}:${a.agentId.slice(0, 8)}=${a.status}`).join(', ')}`
  );

  while (Date.now() - start < DRAIN_WAIT_MS) {
    const active = [...agents.values()].filter(
      a => (a.status === 'running' || a.status === 'starting') && a.role !== 'mayor'
    );
    if (active.length === 0) break;

    // If every active agent already has an idle timer running, they've
    // finished their work and are just waiting for the 10s timer to
    // fire via the normal completion path (exitAgent → reportAgentCompleted).
    // Poll more frequently so we notice the exit promptly, but don't
    // break to Phase 3 — that would force-save WIP commits on agents
    // that already called gt_done and are about to exit cleanly.
    if (active.every(a => idleTimers.has(a.agentId))) {
      console.log(
        `${DRAIN_LOG} All ${active.length} non-mayor agents are idle (timers pending), waiting for clean exit`
      );
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    console.log(
      `${DRAIN_LOG} Waiting for ${active.length} non-mayor agents: ` +
        active.map(a => `${a.role}:${a.agentId.slice(0, 8)}=${a.status}`).join(', ')
    );
    await new Promise(r => setTimeout(r, pollInterval));
  }

  // ── Phase 3: Force-save remaining agents ────────────────────────────
  // Two sub-steps: first freeze all stragglers (cancel idle timers,
  // abort event subscriptions and SDK sessions), then snapshot each
  // worktree. Freezing first prevents the normal completion path
  // (idle timer → onExit → bead completion) from racing with the WIP
  // git save, and avoids .git/index.lock collisions with agent git ops.
  const stragglers = [...agents.values()].filter(
    a => a.status === 'running' || a.status === 'starting'
  );
  if (stragglers.length > 0) {
    console.log(`${DRAIN_LOG} Phase 3: freezing ${stragglers.length} straggler(s)`);
  } else {
    console.log(`${DRAIN_LOG} Phase 3: all agents finished, no force-save needed`);
  }

  // 4a: Freeze — cancel idle timers and abort sessions so no
  // completion/exit callbacks can fire during the git snapshot.
  // Only agents that freeze successfully are safe to snapshot.
  const frozen: typeof stragglers = [];
  for (const agent of stragglers) {
    try {
      // Cancel idle timer FIRST — prevents the timer from firing and
      // marking the agent as completed via onExit() while we abort.
      clearIdleTimer(agent.agentId);

      // Abort event subscription
      const controller = eventAbortControllers.get(agent.agentId);
      if (controller) {
        controller.abort();
        eventAbortControllers.delete(agent.agentId);
      }

      // Abort the SDK session
      const instance = sdkInstances.get(agent.workdir);
      if (instance) {
        await instance.client.session.abort({
          path: { id: agent.sessionId },
        });
      }

      agent.status = 'exited';
      agent.exitReason = 'container eviction';
      frozen.push(agent);
      console.log(`${DRAIN_LOG} Phase 3: froze agent ${agent.agentId}`);
    } catch (err) {
      // Freeze failed — the session may still be writing to the
      // worktree. Skip this agent in 4b to avoid .git/index.lock
      // races and partial snapshots.
      console.warn(
        `${DRAIN_LOG} Phase 3: failed to freeze agent ${agent.agentId}, skipping snapshot:`,
        err
      );
    }
  }

  // 4b: Snapshot — git add/commit/push each worktree now that
  // all sessions are frozen. Only iterate agents that froze
  // successfully; unfrozen agents are skipped to avoid racing
  // with a still-active SDK session.
  for (const agent of frozen) {
    try {
      console.log(`${DRAIN_LOG} Phase 3: force-saving agent ${agent.agentId} in ${agent.workdir}`);

      // Check whether a remote named "origin" exists. Lightweight
      // workspaces (mayor/triage) are created with `git init` and
      // never add a remote, so pushing would fail with
      // "fatal: 'origin' does not appear to be a git repository".
      const remoteCheck = Bun.spawn(['git', 'remote', 'get-url', 'origin'], {
        cwd: agent.workdir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const hasOrigin = (await remoteCheck.exited) === 0;

      const gitCmd = hasOrigin
        ? "git add -A && git commit --allow-empty -m 'WIP: container eviction save' && git push --set-upstream origin HEAD"
        : "git add -A && git commit --allow-empty -m 'WIP: container eviction save'";

      if (!hasOrigin && agent.role !== 'mayor' && agent.role !== 'triage') {
        console.warn(
          `${DRAIN_LOG} Phase 3: no origin remote for ${agent.role} agent ${agent.agentId}, committing locally only (push skipped)`
        );
      }

      // Use the agent's startup env for git author/committer identity.
      const gitEnv: Record<string, string | undefined> = { ...process.env };
      const authorName =
        agent.startupEnv?.GIT_AUTHOR_NAME ?? process.env.GASTOWN_GIT_AUTHOR_NAME ?? 'Gastown';
      const authorEmail =
        agent.startupEnv?.GIT_AUTHOR_EMAIL ??
        process.env.GASTOWN_GIT_AUTHOR_EMAIL ??
        'gastown@kilo.ai';
      gitEnv.GIT_AUTHOR_NAME = authorName;
      gitEnv.GIT_COMMITTER_NAME = authorName;
      gitEnv.GIT_AUTHOR_EMAIL = authorEmail;
      gitEnv.GIT_COMMITTER_EMAIL = authorEmail;

      const proc = Bun.spawn(['bash', '-c', gitCmd], {
        cwd: agent.workdir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: gitEnv,
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      console.log(
        `${DRAIN_LOG} Phase 3: agent ${agent.agentId} git save exited ${exitCode}` +
          (stdout ? ` stdout=${stdout.trim()}` : '') +
          (stderr ? ` stderr=${stderr.trim()}` : '')
      );

      // 4c: Write eviction context on the bead so the next agent
      // dispatched to it knows there is WIP code on the branch.
      // Must happen BEFORE reportAgentCompleted (which unhooks the agent).
      if (hasOrigin && exitCode === 0 && agent.role === 'polecat') {
        const branchProc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: agent.workdir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const branchName = (await new Response(branchProc.stdout).text()).trim();
        await branchProc.exited;

        console.log(
          `${DRAIN_LOG} Phase 3: writing eviction context for agent ${agent.agentId}: branch=${branchName}`
        );
        await writeEvictionCheckpoint(agent, {
          branch: branchName,
          agent_name: agent.name,
          saved_at: new Date().toISOString(),
        });
      }

      // 4d: Save DB snapshot — await with a 10s timeout so a slow KV
      // write doesn't block container exit, but log loudly if it times out.
      // withTimeout clears the timer on success so we don't leave a ref'd
      // setTimeout keeping the process alive after drain finishes.
      //
      // Prefer process.env.GASTOWN_CONTAINER_TOKEN over the per-agent
      // cached token for the same reason as the mayor sendMessage
      // snapshot path: /refresh-token rotates the env var first, so a
      // cached token captured at dispatch time may already be expired
      // and would 401 the snapshot upload, silently dropping the latest
      // kilo.db state on eviction.
      const apiUrl = agent.gastownApiUrl;
      const token = process.env.GASTOWN_CONTAINER_TOKEN ?? agent.gastownContainerToken ?? null;
      if (apiUrl && token) {
        await withTimeout(
          saveDbSnapshot(agent.agentId, apiUrl, token, agent.rigId, agent.townId),
          10_000,
          'drain snapshot'
        ).catch(err => {
          console.error(`${DRAIN_LOG} snapshot timeout/failure for ${agent.agentId}:`, err);
          log.error('mayor.snapshot_failed', {
            event: 'mayor.snapshot_failed',
            agentId: agent.agentId,
            role: agent.role,
            error: err instanceof Error ? err.message : String(err),
            phase: 'drain',
            success: false,
          });
        });
      }

      // 4e: Report the agent as completed so the TownDO can unhook it
      // and transition the bead. Without this, the bead stays in_progress
      // and the agent stays working until stale-bead recovery kicks in.
      if (agent.role !== 'mayor' && agent.role !== 'triage') {
        await reportAgentCompleted(agent, 'completed', 'container eviction');
      }
    } catch (err) {
      console.warn(`${DRAIN_LOG} Phase 3: force-save failed for agent ${agent.agentId}:`, err);
    }
  }

  // Clear the container registry so bootHydration on the next container
  // doesn't resurrect agents that were already force-saved during eviction.
  syncRegistry();

  console.log(`${DRAIN_LOG} Drain complete`);
}

export async function stopAll(): Promise<void> {
  // Cancel all idle timers
  for (const [, entry] of idleTimers) {
    clearTimeout(entry.timer);
  }
  idleTimers.clear();

  // Abort all event subscriptions
  for (const [, controller] of eventAbortControllers) {
    controller.abort();
  }
  eventAbortControllers.clear();

  // Abort all running sessions and save DB snapshots
  for (const agent of agents.values()) {
    if (agent.status === 'running' || agent.status === 'starting') {
      try {
        const instance = sdkInstances.get(agent.workdir);
        if (instance) {
          await instance.client.session.abort({
            path: { id: agent.sessionId },
          });
        }
      } catch {
        // Best-effort
      }
      agent.status = 'exited';
      agent.exitReason = 'container shutdown';

      // Save DB snapshot before completing shutdown. Await with a 10s
      // timeout so the container can exit promptly on a stuck KV write,
      // but a loud error is emitted so we can observe snapshot drops.
      // withTimeout clears the timer on success so stopAll doesn't return
      // with a still-ref'd setTimeout delaying container exit.
      //
      // Prefer the live env token over the per-agent cached token —
      // /refresh-token rotates process.env first so the cached field
      // can be expired after a rotation, 401'ing the final snapshot.
      const apiUrl = agent.gastownApiUrl;
      const token = process.env.GASTOWN_CONTAINER_TOKEN ?? agent.gastownContainerToken ?? null;
      if (apiUrl && token) {
        await withTimeout(
          saveDbSnapshot(agent.agentId, apiUrl, token, agent.rigId, agent.townId),
          10_000,
          'stopAll snapshot'
        ).catch(err => {
          console.error(`[stop-all] snapshot timeout/failure for ${agent.agentId}:`, err);
          log.error('mayor.snapshot_failed', {
            event: 'mayor.snapshot_failed',
            agentId: agent.agentId,
            role: agent.role,
            error: err instanceof Error ? err.message : String(err),
            phase: 'stopAll',
            success: false,
          });
        });
      }
    }
  }

  // Close all SDK servers
  for (const [, instance] of sdkInstances) {
    instance.server.close();
  }
  sdkInstances.clear();
}

/**
 * Boot-time agent hydration — fetches the container registry from the
 * Gastown worker and resumes all registered agents.
 *
 * Called from main.ts when GASTOWN_TOWN_ID and GASTOWN_API_URL are set.
 */
export async function bootHydration(): Promise<void> {
  const LOG = '[boot-hydration]';
  const apiUrl = process.env.GASTOWN_API_URL;
  const townId = process.env.GASTOWN_TOWN_ID;
  const initialToken = process.env.GASTOWN_CONTAINER_TOKEN;

  if (!apiUrl || !townId || !initialToken) {
    console.log(
      `${LOG} Missing GASTOWN_API_URL, GASTOWN_TOWN_ID, or GASTOWN_CONTAINER_TOKEN — skipping boot hydration`
    );
    return;
  }

  // Proactively refresh the container token if it's near expiry. A cold
  // container that was last stopped close to the 8h JWT TTL would
  // otherwise boot with a token about to expire and fail on the first
  // worker call. The refresh endpoint tolerates tokens that have just
  // expired so this covers the cold-restart case too.
  await refreshTokenIfNearExpiry();

  // Re-read the token AFTER the potential refresh so subsequent calls
  // (registry fetch, and the env maps we hand to hydrated agents) use
  // the fresh value.
  const token = process.env.GASTOWN_CONTAINER_TOKEN ?? initialToken;

  console.log(`${LOG} Fetching container registry for town=${townId}`);
  let registry: unknown;
  try {
    const resp = await fetch(`${apiUrl}/api/towns/${townId}/container-registry`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      console.warn(`${LOG} Failed to fetch registry: ${resp.status}`);
      return;
    }
    const json = (await resp.json()) as { data: unknown };
    registry = json.data;
  } catch (err) {
    console.warn(`${LOG} Registry fetch failed:`, err);
    return;
  }

  if (!Array.isArray(registry) || registry.length === 0) {
    console.log(`${LOG} No agents in registry — nothing to hydrate`);
    return;
  }

  console.log(`${LOG} Resuming ${registry.length} agent(s) from registry`);

  for (const entry of registry as Record<string, unknown>[]) {
    const agentId = entry.agentId as string | undefined;
    const agentRequest = entry.request as StartAgentRequest | undefined;
    const workdir = entry.workdir as string | undefined;
    const env = entry.env as Record<string, string> | undefined;

    if (!agentId || !agentRequest || !workdir || !env) {
      console.warn(`${LOG} Skipping malformed registry entry:`, entry);
      continue;
    }

    // Registry entries were written with the token snapshot at dispatch
    // time. If we just refreshed, overlay the fresh value so the hydrated
    // kilo serve child inherits the current token.
    const hydratedEnv = { ...env, GASTOWN_CONTAINER_TOKEN: token };

    console.log(`${LOG} Resuming agent ${agentId} in ${workdir}`);
    try {
      await startAgent(agentRequest, workdir, hydratedEnv);
      console.log(`${LOG} Agent ${agentId} resumed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG} Failed to resume agent ${agentId}:`, msg);
    }
  }
}
