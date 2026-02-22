/**
 * Agent manager — tracks agents as SDK-managed opencode sessions.
 *
 * Uses @kilocode/sdk's createOpencode() to start server instances in-process
 * and client.event.subscribe() for typed event streams. No subprocesses,
 * no SSE text parsing, no ring buffers.
 */

import { createOpencode, createOpencodeClient, type OpencodeClient } from '@kilocode/sdk';
import type { ManagedAgent, StartAgentRequest, KiloSSEEvent, KiloSSEEventData } from './types';
import { reportAgentCompleted } from './completion-reporter';

const MANAGER_LOG = '[process-manager]';

type SDKInstance = {
  client: OpencodeClient;
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

let nextPort = 4096;
const startTime = Date.now();

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
  if (agent?.gastownApiUrl && agent.gastownSessionToken) {
    // POST to the worker's agent-events endpoint for persistent storage
    fetch(`${agent.gastownApiUrl}/api/rigs/_/agent-events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent.gastownSessionToken}`,
        'X-Town-Id': agent.townId ?? '',
      },
      body: JSON.stringify({
        agent_id: agentId,
        event_type: event,
        data,
      }),
    }).catch(() => {
      // Best-effort persistence — don't block live streaming
    });
  }
}

/**
 * Get or create an SDK server instance for a workdir.
 */
async function ensureSDKServer(
  workdir: string,
  env: Record<string, string>
): Promise<{ client: OpencodeClient; port: number }> {
  const existing = sdkInstances.get(workdir);
  if (existing) {
    return {
      client: existing.client,
      port: parseInt(new URL(existing.server.url).port),
    };
  }

  const port = nextPort++;
  console.log(`${MANAGER_LOG} Starting SDK server on port ${port} for ${workdir}`);

  // Set env vars before creating the server
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  // Save and set CWD for the server
  const prevCwd = process.cwd();
  try {
    process.chdir(workdir);
    const { client, server } = await createOpencode({
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
  }
}

/**
 * Subscribe to SDK events for an agent's session and forward them.
 */
async function subscribeToEvents(
  client: OpencodeClient,
  agent: ManagedAgent,
  request: StartAgentRequest
): Promise<void> {
  const controller = new AbortController();
  eventAbortControllers.set(agent.agentId, controller);

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

      // Detect completion. session.idle means "done processing this turn."
      // Mayor agents are persistent — session.idle for them means "turn done,"
      // not "task finished." Only non-mayor agents exit on idle.
      const isTerminal = event.type === 'session.idle' && request.role !== 'mayor';

      if (isTerminal) {
        console.log(
          `${MANAGER_LOG} Completion detected for agent ${agent.agentId} (${agent.name}) event=${event.type}`
        );
        agent.status = 'exited';
        agent.exitReason = 'completed';
        broadcastEvent(agent.agentId, 'agent.exited', { reason: 'completed' });
        void reportAgentCompleted(agent, 'completed');
        break;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(`${MANAGER_LOG} Event stream error for agent ${agent.agentId}:`, err);
      if (agent.status === 'running') {
        agent.status = 'failed';
        agent.exitReason = 'Event stream error';
        broadcastEvent(agent.agentId, 'agent.exited', { reason: 'stream error' });
        void reportAgentCompleted(agent, 'failed', 'Event stream error');
      }
    }
  } finally {
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
    gastownSessionToken: request.envVars?.GASTOWN_SESSION_TOKEN ?? null,
    completionCallbackUrl: request.envVars?.GASTOWN_COMPLETION_CALLBACK_URL ?? null,
  };
  agents.set(request.agentId, agent);

  try {
    // 1. Ensure SDK server is running for this workdir
    const { client, port } = await ensureSDKServer(workdir, env);
    agent.serverPort = port;

    // Track session count on the SDK instance
    const instance = sdkInstances.get(workdir);
    if (instance) instance.sessionCount++;

    // 2. Create a session
    const sessionResult = await client.session.create({ body: {} });
    const session = sessionResult.data ?? sessionResult;
    const sessionId =
      typeof session === 'object' && session && 'id' in session ? String(session.id) : '';
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

    console.log(
      `${MANAGER_LOG} Started agent ${request.name} (${request.agentId}) session=${sessionId} port=${port}`
    );

    return agent;
  } catch (err) {
    agent.status = 'failed';
    agent.exitReason = err instanceof Error ? err.message : String(err);
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
    console.warn(`${MANAGER_LOG} Failed to abort session for agent ${agentId}:`, err);
  }

  agent.status = 'exited';
  agent.exitReason = 'stopped';
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

  await instance.client.session.prompt({
    path: { id: agent.sessionId },
    body: {
      parts: [{ type: 'text', text: prompt }],
    },
  });

  agent.messageCount++;
  agent.lastActivityAt = new Date().toISOString();
}

export function getAgentStatus(agentId: string): ManagedAgent | null {
  return agents.get(agentId) ?? null;
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
