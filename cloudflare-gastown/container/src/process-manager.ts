/**
 * Agent manager — tracks agents as SDK-managed kilo sessions.
 *
 * Uses @kilocode/sdk's createKilo() to start server instances in-process
 * and client.event.subscribe() for typed event streams. No subprocesses,
 * no SSE text parsing, no ring buffers.
 */

import { createKilo, type KiloClient } from '@kilocode/sdk';
import { z } from 'zod';
import type { ManagedAgent, StartAgentRequest } from './types';
import { reportAgentCompleted, reportMayorWaiting } from './completion-reporter';
import { buildKiloConfigContent } from './agent-runner';
import { log } from './logger';

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
// Per-agent idle timers — fires exit when no nudges arrive
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  const timer = idleTimers.get(agentId);
  if (timer !== undefined) {
    clearTimeout(timer);
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

  idleTimers.set(
    agentId,
    setTimeout(() => {
      idleTimers.delete(agentId);
      if (agent.status === 'running') {
        console.log(
          `${MANAGER_LOG} handleIdleEvent: idle timeout fired for agent ${agentId}, exiting`
        );
        onExit();
      }
    }, timeoutMs)
  );
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

    // Release SDK session so the server can shut down when idle
    const inst = sdkInstances.get(agent.workdir);
    if (inst) {
      inst.sessionCount--;
      if (inst.sessionCount <= 0) {
        inst.server.close();
        sdkInstances.delete(agent.workdir);
      }
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
    eventAbortControllers.delete(agent.agentId);
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
    await stopAgent(request.agentId).catch(err => {
      console.warn(
        `${MANAGER_LOG} startAgent: failed to stop existing session for ${request.agentId}`,
        err
      );
    });
  }

  const now = new Date().toISOString();
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
    startupEnv: env,
  };
  agents.set(request.agentId, agent);

  let sessionCounted = false;
  try {
    // 1. Ensure SDK server is running for this workdir
    const { client, port } = await ensureSDKServer(workdir, env);
    agent.serverPort = port;

    // Track session count on the SDK instance
    const instance = sdkInstances.get(workdir);
    if (instance) {
      instance.sessionCount++;
      sessionCounted = true;
    }

    // 2. Create a session
    const sessionResult = await client.session.create({ body: {} });
    const rawSession: unknown = sessionResult.data ?? sessionResult;
    const parsed = SessionResponse.safeParse(rawSession);
    if (!parsed.success) {
      console.error(
        `${MANAGER_LOG} SDK session.create returned unexpected shape:`,
        JSON.stringify(rawSession).slice(0, 200),
        parsed.error.issues
      );
      throw new Error('SDK session.create response missing required "id" field');
    }
    const sessionId = parsed.data.id;
    agent.sessionId = sessionId;

    // 3. Subscribe to events (async, runs in background)
    void subscribeToEvents(client, agent, request);

    // Mark as running BEFORE the initial prompt. The event subscription
    // is already active and events may be flowing (the agent is
    // functionally running). session.prompt() can block if the SDK
    // server is busy, which would leave the agent stuck in 'starting'
    // despite being active — causing the drain to wait indefinitely.
    if (agent.status === 'starting') {
      agent.status = 'running';
    }

    // 4. Send the initial prompt
    // The model string is an OpenRouter-style ID like "anthropic/claude-sonnet-4.6".
    // The kilo provider (which wraps OpenRouter) takes the FULL model string as modelID.
    // providerID is always 'kilo' since we route through the Kilo gateway.
    let modelParam: { providerID: string; modelID: string } | undefined;
    if (request.model) {
      modelParam = { providerID: 'kilo', modelID: request.model };
    }

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

    agent.messageCount = 1;

    log.info('agent.start', {
      agentId: request.agentId,
      role: request.role,
      name: request.name,
      sessionId,
      port,
    });

    return agent;
  } catch (err) {
    agent.status = 'failed';
    agent.exitReason = err instanceof Error ? err.message : String(err);
    if (sessionCounted) {
      const instance = sdkInstances.get(workdir);
      if (instance) instance.sessionCount--;
    }
    throw err;
  }
}

/**
 * Stop an agent by aborting its session.
 */
export async function stopAgent(agentId: string): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (agent.status !== 'running' && agent.status !== 'starting') return;

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
}

/**
 * Update the model for a running agent by restarting its SDK server with
 * new KILO_CONFIG_CONTENT. The kilo serve child process reads the model
 * from KILO_CONFIG_CONTENT at startup (highest config precedence after
 * enterprise managed config), so the only reliable way to change it is
 * to restart the server process.
 *
 * The agent's session is re-created on the new server. The session history
 * is persisted on disk by kilo serve, so it survives the restart.
 *
 * @param model OpenRouter-style model ID (e.g. "anthropic/claude-sonnet-4.6")
 * @param smallModel Optional small model in the same format
 */
/**
 * Extract the organizationId from the current KILO_CONFIG_CONTENT env var.
 * The org ID is embedded as `provider.kilo.options.kilocodeOrganizationId`
 * by `buildKiloConfigContent` at agent startup.
 */
function extractOrganizationId(): string | undefined {
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

  console.log(
    `${MANAGER_LOG} updateAgentModel: restarting SDK server for agent ${agentId} with model=${model}`
  );

  // 1. Preserve organizationId from the current config before we replace it
  const organizationId = extractOrganizationId();

  // 2. Rebuild KILO_CONFIG_CONTENT with the new model and update process.env
  //    so the next createKilo() spawns kilo serve with fresh config.
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
  }

  // 3. Remove the old instance from the map so ensureSDKServer creates a
  //    new one — but DON'T close the old server yet. If the new server
  //    fails to start we can restore the old one.
  sdkInstances.delete(agent.workdir);
  agent.model = model;

  // Replay the full env from the initial dispatch so the new SDK server
  // gets the same git identity, auth tokens, and plugin vars. Exclude
  // KILO_CONFIG_CONTENT / OPENCODE_CONFIG_CONTENT — those were already
  // rebuilt above with the new model and set on process.env.
  //
  // For env vars that syncConfigToContainer can update at runtime, prefer
  // the live process.env value over the stale startupEnv snapshot.
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
  ]);
  const hotSwapEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(agent.startupEnv)) {
    if (key === 'KILO_CONFIG_CONTENT' || key === 'OPENCODE_CONFIG_CONTENT') continue;
    if (LIVE_ENV_KEYS.has(key)) {
      const live = process.env[key];
      if (live) hotSwapEnv[key] = live;
      continue;
    }
    hotSwapEnv[key] = value;
  }

  // Re-derive GH_TOKEN from live values using the same priority chain
  // as buildAgentEnv: GITHUB_CLI_PAT > GIT_TOKEN > GITHUB_TOKEN.
  // syncConfigToContainer updates these on process.env, but buildAgentEnv
  // only ran once at initial dispatch. When all sources are cleared,
  // remove GH_TOKEN so the SDK server doesn't retain stale credentials.
  const liveGhCliPat = process.env.GITHUB_CLI_PAT;
  const liveGhToken = liveGhCliPat ?? process.env.GIT_TOKEN ?? process.env.GITHUB_TOKEN;
  if (liveGhToken) {
    hotSwapEnv.GH_TOKEN = liveGhToken;
  } else {
    delete hotSwapEnv.GH_TOKEN;
  }

  try {
    // 4. Create a new SDK server (spawns a fresh kilo serve with updated env)
    const { client, port } = await ensureSDKServer(agent.workdir, hotSwapEnv);
    agent.serverPort = port;

    // 5. Create a new session and send the startup prompt.
    //    The system prompt lives in AGENTS.md (on disk), so kilo serve picks
    //    it up automatically for every session.
    const sessionResult = await client.session.create({ body: {} });
    const rawSession: unknown = sessionResult.data ?? sessionResult;
    const parsed = SessionResponse.safeParse(rawSession);
    if (!parsed.success) {
      throw new Error('SDK session.create response missing required "id" field');
    }
    agent.sessionId = parsed.data.id;

    const newInstance = sdkInstances.get(agent.workdir);
    if (newInstance) {
      newInstance.sessionCount++;
    }

    // Send the startup prompt, including conversation history if available
    // so the mayor retains context across model changes (same mechanism
    // used for container restarts — see PR #1494).
    const prompt = conversationHistory
      ? `${conversationHistory}\n\n${MAYOR_STARTUP_PROMPT}`
      : MAYOR_STARTUP_PROMPT;
    const modelParam = { providerID: 'kilo', modelID: model };
    await client.session.prompt({
      path: { id: agent.sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        model: modelParam,
      },
    });
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

      // 4d: Report the agent as completed so the TownDO can unhook it
      // and transition the bead. Without this, the bead stays in_progress
      // and the agent stays working until stale-bead recovery kicks in.
      if (agent.role !== 'mayor' && agent.role !== 'triage') {
        await reportAgentCompleted(agent, 'completed', 'container eviction');
      }
    } catch (err) {
      console.warn(`${DRAIN_LOG} Phase 3: force-save failed for agent ${agent.agentId}:`, err);
    }
  }

  console.log(`${DRAIN_LOG} Drain complete`);
}

export async function stopAll(): Promise<void> {
  // Cancel all idle timers
  for (const [, timer] of idleTimers) {
    clearTimeout(timer);
  }
  idleTimers.clear();

  // Abort all event subscriptions
  for (const [, controller] of eventAbortControllers) {
    controller.abort();
  }
  eventAbortControllers.clear();

  // Abort all running sessions
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
    }
  }

  // Close all SDK servers
  for (const [, instance] of sdkInstances) {
    instance.server.close();
  }
  sdkInstances.clear();
}
