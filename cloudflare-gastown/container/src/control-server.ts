import { Hono } from 'hono';
import { runAgent } from './agent-runner';
import {
  stopAgent,
  sendMessage,
  getAgentStatus,
  activeAgentCount,
  activeServerCount,
  getUptime,
  stopAll,
  getAgentEvents,
  registerEventSink,
} from './process-manager';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { mergeBranch } from './git-manager';
import { StartAgentRequest, StopAgentRequest, SendMessageRequest, MergeRequest } from './types';
import type {
  AgentStatusResponse,
  HealthResponse,
  StreamTicketResponse,
  MergeResult,
} from './types';

const MAX_TICKETS = 1000;
const streamTickets = new Map<string, { agentId: string; expiresAt: number }>();

export const app = new Hono();

// Apply town config from X-Town-Config header (sent by TownDO on every request)
let currentTownConfig: Record<string, unknown> | null = null;

/** Get the latest town config delivered via X-Town-Config header. */
export function getCurrentTownConfig(): Record<string, unknown> | null {
  return currentTownConfig;
}

app.use('*', async (c, next) => {
  const configHeader = c.req.header('X-Town-Config');
  if (configHeader) {
    try {
      const parsed = JSON.parse(configHeader);
      currentTownConfig = parsed;
      const hasToken =
        typeof parsed.kilocode_token === 'string' && parsed.kilocode_token.length > 0;
      console.log(
        `[control-server] X-Town-Config received: hasKilocodeToken=${hasToken} keys=${Object.keys(parsed).join(',')}`
      );
    } catch {
      console.warn('[control-server] X-Town-Config header malformed');
    }
  }
  await next();
});

// Log method, path, status, and duration for every request
app.use('*', async (c, next) => {
  const start = performance.now();
  const method = c.req.method;
  const path = c.req.path;
  console.log(`[control-server] --> ${method} ${path}`);
  await next();
  const duration = (performance.now() - start).toFixed(1);
  const status = c.res.status;
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'log';
  console[level](`[control-server] <-- ${method} ${path} ${status} ${duration}ms`);
});

// GET /health
app.get('/health', c => {
  const response: HealthResponse = {
    status: 'ok',
    agents: activeAgentCount(),
    servers: activeServerCount(),
    uptime: getUptime(),
  };
  return c.json(response);
});

// POST /agents/start
app.post('/agents/start', async c => {
  const body = await c.req.json().catch(() => null);
  const parsed = StartAgentRequest.safeParse(body);
  if (!parsed.success) {
    console.error('[control-server] /agents/start: invalid request body', parsed.error.issues);
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  console.log(
    `[control-server] /agents/start: role=${parsed.data.role} name=${parsed.data.name} rigId=${parsed.data.rigId} agentId=${parsed.data.agentId}`
  );

  try {
    const agent = await runAgent(parsed.data);
    console.log(
      `[control-server] /agents/start: success agentId=${agent.agentId} port=${agent.serverPort} session=${agent.sessionId}`
    );
    return c.json(agent, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[control-server] /agents/start: FAILED for ${parsed.data.name}: ${message}`);
    return c.json({ error: message }, 500);
  }
});

// POST /agents/:agentId/stop
app.post('/agents/:agentId/stop', async c => {
  const { agentId } = c.req.param();
  if (!getAgentStatus(agentId)) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }
  // StopAgentRequest.signal is no longer used — abort is always clean via API.
  // We still parse the body to avoid breaking callers that send it.
  await c.req.json().catch(() => ({}));

  await stopAgent(agentId);
  return c.json({ stopped: true });
});

// POST /agents/:agentId/message
app.post('/agents/:agentId/message', async c => {
  const { agentId } = c.req.param();
  if (!getAgentStatus(agentId)) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = SendMessageRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  await sendMessage(agentId, parsed.data.prompt);
  return c.json({ sent: true });
});

// GET /agents/:agentId/status
app.get('/agents/:agentId/status', c => {
  const { agentId } = c.req.param();
  const agent = getAgentStatus(agentId);
  if (!agent) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }

  const response: AgentStatusResponse = {
    agentId: agent.agentId,
    status: agent.status,
    serverPort: agent.serverPort,
    sessionId: agent.sessionId,
    startedAt: agent.startedAt,
    lastActivityAt: agent.lastActivityAt,
    activeTools: agent.activeTools,
    messageCount: agent.messageCount,
    exitReason: agent.exitReason,
  };
  return c.json(response);
});

// GET /agents/:agentId/events?after=N
// Returns buffered events for the agent, optionally after a given event id.
// Used by the TownContainerDO to poll for events and relay them to WebSocket clients.
// Does NOT 404 for unknown agents — returns an empty array so the poller
// can keep trying while the agent is starting up.
app.get('/agents/:agentId/events', c => {
  const { agentId } = c.req.param();
  const afterParam = c.req.query('after');
  const afterId = afterParam ? parseInt(afterParam, 10) : 0;
  const events = getAgentEvents(agentId, afterId);
  return c.json({ events });
});

// POST /agents/:agentId/stream-ticket
// Issues a one-time-use stream ticket for the agent. Does NOT require
// the agent to be registered yet — tickets can be issued optimistically
// so the frontend can connect a WebSocket before the agent finishes starting.
app.post('/agents/:agentId/stream-ticket', c => {
  const { agentId } = c.req.param();

  const ticket = crypto.randomUUID();
  const expiresAt = Date.now() + 60_000;
  streamTickets.set(ticket, { agentId, expiresAt });

  // Clean up expired tickets and enforce cap
  for (const [t, v] of streamTickets) {
    if (v.expiresAt < Date.now()) streamTickets.delete(t);
  }
  if (streamTickets.size > MAX_TICKETS) {
    const oldest = streamTickets.keys().next().value;
    if (oldest) streamTickets.delete(oldest);
  }

  const response: StreamTicketResponse = {
    ticket,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  return c.json(response);
});

/**
 * Validate a stream ticket and return the associated agentId, consuming it.
 * Returns null if the ticket is invalid or expired.
 */
export function consumeStreamTicket(ticket: string): string | null {
  const entry = streamTickets.get(ticket);
  if (!entry) return null;
  streamTickets.delete(ticket);
  if (entry.expiresAt < Date.now()) return null;
  return entry.agentId;
}

// POST /git/merge
// Deterministic merge of a polecat branch into the target branch.
// Called by the Rig DO's processReviewQueue → startMergeInContainer.
// Runs the merge synchronously and reports the result back to the Rig DO
// via a callback to the completeReview endpoint.
app.post('/git/merge', async c => {
  const body = await c.req.json().catch(() => null);
  const parsed = MergeRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  const req = parsed.data;

  // Run the merge in the background so we can return 202 immediately.
  // The Rig DO will be notified via callback when the merge completes.
  const apiUrl = req.envVars?.GASTOWN_API_URL ?? process.env.GASTOWN_API_URL;
  const token = req.envVars?.GASTOWN_SESSION_TOKEN ?? process.env.GASTOWN_SESSION_TOKEN;

  const doMerge = async () => {
    const outcome = await mergeBranch({
      rigId: req.rigId,
      branch: req.branch,
      targetBranch: req.targetBranch,
      gitUrl: req.gitUrl,
      envVars: req.envVars,
    });

    // Report result back to the Rig DO
    const callbackUrl =
      req.callbackUrl ??
      (apiUrl ? `${apiUrl}/api/rigs/${req.rigId}/review-queue/${req.entryId}/complete` : null);

    if (callbackUrl && token) {
      try {
        const resp = await fetch(callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            entry_id: req.entryId,
            status: outcome.status,
            message: outcome.message,
            commit_sha: outcome.commitSha,
          }),
        });
        if (!resp.ok) {
          console.warn(
            `Merge callback failed for entry ${req.entryId}: ${resp.status} ${resp.statusText}`
          );
        }
      } catch (err) {
        console.warn(`Merge callback error for entry ${req.entryId}:`, err);
      }
    } else {
      console.warn(
        `No callback URL or token for merge entry ${req.entryId}, result: ${outcome.status}`
      );
    }
  };

  // Fire and forget — the Rig DO will time out stuck entries via recoverStuckReviews
  doMerge().catch(err => {
    console.error(`Merge failed for entry ${req.entryId}:`, err);
  });

  const result: MergeResult = { status: 'accepted', message: 'Merge started' };
  return c.json(result, 202);
});

// Catch-all
app.notFound(c => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : 'Internal server error';
  console.error('Control server error:', err);
  return c.json({ error: message }, 500);
});

/**
 * Start the control server using Bun.serve + Hono, with WebSocket support.
 *
 * The /ws endpoint provides a multiplexed event stream for all agents.
 * SDK events from process-manager are forwarded to all connected WS clients.
 */
export function startControlServer(): void {
  const PORT = 8080;

  // Start heartbeat if env vars are configured
  const apiUrl = process.env.GASTOWN_API_URL;
  const sessionToken = process.env.GASTOWN_SESSION_TOKEN;
  if (apiUrl && sessionToken) {
    startHeartbeat(apiUrl, sessionToken);
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down control server...');
    stopHeartbeat();
    await stopAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // Track connected WebSocket clients with optional agent filter
  type WSClient = import('bun').ServerWebSocket<{ agentId: string | null }>;
  const wsClients = new Set<WSClient>();

  // Agent stream URL patterns (the container receives the full path from the worker)
  const AGENT_STREAM_RE = /\/agents\/([^/]+)\/stream$/;

  // Register an event sink that forwards agent events to WS clients
  registerEventSink((agentId, event, data) => {
    const frame = JSON.stringify({
      agentId,
      event,
      data,
      timestamp: new Date().toISOString(),
    });
    for (const ws of wsClients) {
      try {
        // If the client subscribed to a specific agent, only send that agent's events
        const filter = ws.data.agentId;
        if (filter && filter !== agentId) continue;
        ws.send(frame);
      } catch {
        wsClients.delete(ws);
      }
    }
  });

  Bun.serve<{ agentId: string | null }>({
    port: PORT,
    fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // WebSocket upgrade: match /ws OR /agents/:id/stream (with any prefix)
      const isWsUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (isWsUpgrade) {
        let agentId: string | null = null;

        if (pathname === '/ws') {
          agentId = url.searchParams.get('agentId');
        } else {
          const match = pathname.match(AGENT_STREAM_RE);
          if (match) agentId = match[1];
        }

        // Accept upgrade if the path matches any WS pattern
        if (pathname === '/ws' || AGENT_STREAM_RE.test(pathname)) {
          const upgraded = server.upgrade(req, { data: { agentId } });
          if (upgraded) return undefined;
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
      }

      // All other requests go through Hono
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        wsClients.add(ws);
        const agentFilter = ws.data.agentId ?? 'all';
        console.log(
          `[control-server] WebSocket connected: agent=${agentFilter} (${wsClients.size} total)`
        );

        // Send in-memory backfill for this session's events.
        // This covers late-joining clients within the same container lifecycle.
        // For historical events after container restarts, clients query the
        // AgentDO via the worker's GET /agents/:id/events endpoint.
        if (ws.data.agentId) {
          const events = getAgentEvents(ws.data.agentId, 0);
          for (const evt of events) {
            try {
              ws.send(
                JSON.stringify({
                  agentId: ws.data.agentId,
                  event: evt.event,
                  data: evt.data,
                  timestamp: evt.timestamp,
                })
              );
            } catch {
              break;
            }
          }
        }
      },
      message(ws, message) {
        // Handle subscribe messages from client
        try {
          const msg = JSON.parse(String(message));
          if (msg.type === 'subscribe' && msg.agentId) {
            ws.data.agentId = msg.agentId;
            console.log(`[control-server] WebSocket subscribed to agent=${msg.agentId}`);
          }
        } catch {
          // Ignore
        }
      },
      close(ws) {
        wsClients.delete(ws);
        console.log(`[control-server] WebSocket disconnected (${wsClients.size} total)`);
      },
    },
  });

  console.log(`Town container control server listening on port ${PORT}`);
}
