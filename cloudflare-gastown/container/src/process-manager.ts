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
import { reportAgentCompleted } from './completion-reporter';
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

let nextPort = 4096;
const startTime = Date.now();

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
type BufferedEvent = { id: number; event: string; data: unknown; timestamp: string };
const MAX_BUFFERED_EVENTS = 2000;
const agentEventBuffers = new Map<string, BufferedEvent[]>();
let nextEventId = 1;

function bufferAgentEvent(agentId: string, event: string, data: unknown): void {
  let buf = agentEventBuffers.get(agentId);
  if (!buf) {
    buf = [];
    agentEventBuffers.set(agentId, buf);
  }
  buf.push({ id: nextEventId++, event, data, timestamp: new Date().toISOString() });
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
      { headers }
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

  const nudges = await fetchPendingNudges(agent);

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

  // No nudges (or fetch error) — (re)start the idle timeout
  clearIdleTimer(agentId);
  const timeoutMs =
    process.env.AGENT_IDLE_TIMEOUT_MS !== undefined
      ? Number(process.env.AGENT_IDLE_TIMEOUT_MS)
      : 120_000;

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
          continue;
        }
        // Non-mayor: check for pending nudges before deciding to exit.
        // handleIdleEvent is async; we run it in the background so the event
        // loop continues. The exitAgent callback will abort the stream if needed.
        void handleIdleEvent(agent, exitAgent);
      } else {
        // Non-idle event means the agent resumed work — cancel any pending idle timer.
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
        broadcastEvent(agent.agentId, 'agent.exited', { reason: 'stream error' });
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
    throw new Error(`Agent ${request.agentId} is already running`);
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
    activeTools: [],
    messageCount: 0,
    exitReason: null,
    gastownApiUrl: request.envVars?.GASTOWN_API_URL ?? process.env.GASTOWN_API_URL ?? null,
    gastownContainerToken:
      request.envVars?.GASTOWN_CONTAINER_TOKEN ?? process.env.GASTOWN_CONTAINER_TOKEN ?? null,
    gastownSessionToken: request.envVars?.GASTOWN_SESSION_TOKEN ?? null,
    completionCallbackUrl: request.envVars?.GASTOWN_COMPLETION_CALLBACK_URL ?? null,
    model: request.model ?? null,
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

    if (agent.status === 'starting') {
      agent.status = 'running';
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
          await instance.client.session.abort({ path: { id: agent.sessionId } });
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
