/**
 * Agent manager — tracks agents as kilo serve sessions.
 *
 * Replaces the old Bun.spawn + stdin pipe approach. Each agent is a session
 * within a kilo serve instance (one server per worktree). Messages are sent
 * via HTTP, not stdin.
 */

import type { ManagedAgent, StartAgentRequest, KiloSSEEventData } from './types';
import {
  ensureServer,
  registerSession,
  unregisterSession,
  stopAllServers,
  activeServerCount,
} from './kilo-server';
import { createKiloClient } from './kilo-client';
import { createSSEConsumer, isCompletionEvent, type SSEConsumer } from './sse-consumer';
import { reportAgentCompleted } from './completion-reporter';

const agents = new Map<string, ManagedAgent>();
const sseConsumers = new Map<string, SSEConsumer>();

const startTime = Date.now();

export function getUptime(): number {
  return Date.now() - startTime;
}

/**
 * Start an agent: ensure kilo serve is running for the workdir, create a
 * session, send the initial prompt, and subscribe to SSE events.
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
    // 1. Ensure kilo serve is running for this workdir
    const port = await ensureServer(workdir, env);
    agent.serverPort = port;

    // 2. Create a session on the server
    const client = createKiloClient(port);
    const session = await client.createSession();
    agent.sessionId = session.id;
    registerSession(workdir, session.id);

    // 3. Subscribe to SSE events for observability.
    //    The SSE stream is server-wide, so filter by our sessionId to avoid
    //    cross-talk when multiple agents share a kilo serve instance.
    const consumer = createSSEConsumer({
      port,
      onEvent: evt => {
        const sessionID = extractSessionID(evt.data);
        if (sessionID && sessionID !== agent.sessionId) return;

        agent.lastActivityAt = new Date().toISOString();

        // Track active tool calls from event data
        if ('properties' in evt.data && evt.data.properties) {
          const props = evt.data.properties;
          if ('activeTools' in props && Array.isArray(props.activeTools)) {
            agent.activeTools = props.activeTools.filter((t): t is string => typeof t === 'string');
          }
        }

        // Detect completion
        if (isCompletionEvent(evt)) {
          agent.status = 'exited';
          agent.exitReason = 'completed';
          void reportAgentCompleted(agent, 'completed');
        }
      },
      onActivity: () => {
        agent.lastActivityAt = new Date().toISOString();
      },
      onClose: reason => {
        if (agent.status === 'running') {
          agent.status = 'failed';
          agent.exitReason = `SSE stream closed: ${reason}`;
          void reportAgentCompleted(agent, 'failed', reason);
        }
      },
    });
    sseConsumers.set(request.agentId, consumer);

    // 4. Send the initial prompt
    await client.sendPromptAsync(session.id, {
      prompt: request.prompt,
      model: request.model,
      systemPrompt: request.systemPrompt,
    });

    // Only transition to 'running' if the SSE consumer hasn't already
    // moved us to a terminal state (e.g. a fast completion event arrived
    // between subscription and here).
    if (agent.status === 'starting') {
      agent.status = 'running';
    }
    agent.messageCount = 1;

    console.log(
      `Started agent ${request.name} (${request.agentId}) ` +
        `session=${session.id} port=${port} role=${request.role}`
    );

    return agent;
  } catch (err) {
    agent.status = 'failed';
    agent.exitReason = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/**
 * Extract sessionID from a parsed SSE event's properties, if present.
 */
function extractSessionID(data: KiloSSEEventData): string | undefined {
  if ('properties' in data && data.properties && 'sessionID' in data.properties) {
    const id = data.properties.sessionID;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/**
 * Stop an agent by aborting its session and cleaning up.
 */
export async function stopAgent(agentId: string): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  if (agent.status !== 'running' && agent.status !== 'starting') {
    return;
  }

  agent.status = 'stopping';

  // Stop SSE consumer
  const consumer = sseConsumers.get(agentId);
  if (consumer) {
    consumer.stop();
    sseConsumers.delete(agentId);
  }

  // Abort the session via the kilo serve API
  try {
    const client = createKiloClient(agent.serverPort);
    await client.abortSession(agent.sessionId);
  } catch (err) {
    console.warn(`Failed to abort session for agent ${agentId}:`, err);
  }

  // Unregister the session (may stop the server if last session)
  await unregisterSession(agent.workdir, agent.sessionId);

  agent.status = 'exited';
  agent.exitReason = 'stopped';
}

/**
 * Send a follow-up prompt to an agent via the kilo serve HTTP API.
 */
export async function sendMessage(agentId: string, prompt: string): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }
  if (agent.status !== 'running') {
    throw new Error(`Agent ${agentId} is not running (status: ${agent.status})`);
  }

  const client = createKiloClient(agent.serverPort);
  await client.sendPromptAsync(agent.sessionId, { prompt });
  agent.messageCount++;
  agent.lastActivityAt = new Date().toISOString();
}

/**
 * Get the status of an agent.
 */
export function getAgentStatus(agentId: string): ManagedAgent | null {
  return agents.get(agentId) ?? null;
}

/**
 * List all managed agents.
 */
export function listAgents(): ManagedAgent[] {
  return [...agents.values()];
}

/**
 * Count of active (running/starting) agents.
 */
export function activeAgentCount(): number {
  let count = 0;
  for (const a of agents.values()) {
    if (a.status === 'running' || a.status === 'starting') {
      count++;
    }
  }
  return count;
}

/**
 * Stop all agents and all kilo serve instances.
 */
export async function stopAll(): Promise<void> {
  // Stop all SSE consumers
  for (const [id, consumer] of sseConsumers) {
    consumer.stop();
    sseConsumers.delete(id);
  }

  // Abort all running agent sessions
  const running = [...agents.values()].filter(
    a => a.status === 'running' || a.status === 'starting'
  );
  for (const agent of running) {
    try {
      const client = createKiloClient(agent.serverPort);
      await client.abortSession(agent.sessionId);
    } catch {
      /* best-effort */
    }
    agent.status = 'exited';
    agent.exitReason = 'container shutdown';
  }

  // Stop all kilo serve instances
  await stopAllServers();
}

/** Re-export for control-server health endpoint */
export { activeServerCount };
