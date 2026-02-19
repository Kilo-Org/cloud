import { Hono } from 'hono';
import type { ServerWebSocket } from 'bun';
import { runAgent } from './agent-runner';
import {
  stopAgent,
  sendMessage,
  getAgentStatus,
  activeAgentCount,
  activeServerCount,
  getUptime,
  stopAll,
  subscribeToAgent,
} from './process-manager';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { StartAgentRequest, StopAgentRequest, SendMessageRequest } from './types';
import type { AgentStatusResponse, HealthResponse, StreamTicketResponse } from './types';

const MAX_TICKETS = 1000;
const streamTickets = new Map<string, { agentId: string; expiresAt: number }>();

// ── WebSocket data attached to each connection ──────────────────────────
type WSData = {
  agentId: string;
  unsubscribe: (() => void) | null;
};

// Bun WebSocket handlers — registered once in Bun.serve({ websocket: ... })
export const websocketHandlers = {
  open(ws: ServerWebSocket<WSData>) {
    const { agentId } = ws.data;
    const agent = getAgentStatus(agentId);

    // Send current agent status as the first message
    ws.send(
      JSON.stringify({
        event: 'agent.status',
        data: {
          agentId,
          status: agent?.status ?? 'unknown',
          activeTools: agent?.activeTools ?? [],
          startedAt: agent?.startedAt ?? null,
        },
      })
    );

    // Subscribe to the agent's event fan-out
    const unsubscribe = subscribeToAgent(agentId, evt => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ event: evt.event, data: evt.data }));
      }
    });
    ws.data.unsubscribe = unsubscribe;
  },

  message(_ws: ServerWebSocket<WSData>, _message: string | Buffer) {
    // Clients don't send meaningful messages; ignore.
  },

  close(ws: ServerWebSocket<WSData>, _code: number, _reason: string) {
    ws.data.unsubscribe?.();
    ws.data.unsubscribe = null;
  },
};

export const app = new Hono();

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
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  const agent = await runAgent(parsed.data);
  return c.json(agent, 201);
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

// POST /agents/:agentId/stream-ticket
app.post('/agents/:agentId/stream-ticket', c => {
  const { agentId } = c.req.param();
  if (!getAgentStatus(agentId)) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }

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

// Catch-all
app.notFound(c => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : 'Internal server error';
  console.error('Control server error:', err);
  return c.json({ error: message }, 500);
});

/**
 * Validate a stream ticket and return the associated agentId, consuming it.
 * Returns null if the ticket is invalid or expired.
 */
function consumeStreamTicket(ticket: string): string | null {
  const entry = streamTickets.get(ticket);
  if (!entry) return null;
  streamTickets.delete(ticket);
  if (entry.expiresAt < Date.now()) return null;
  return entry.agentId;
}

/**
 * Start the control server using Bun.serve + Hono.
 *
 * WebSocket upgrade for /agents/:agentId/stream is handled in the fetch
 * function before falling through to Hono, because Bun requires
 * server.upgrade() to be called before returning a Response.
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

  // Keepalive: ping all open WebSocket connections every 30s
  const KEEPALIVE_INTERVAL_MS = 30_000;
  setInterval(() => {
    // Bun automatically handles ping/pong frames for ServerWebSocket,
    // but we send an application-level keepalive so the browser knows
    // the connection is alive even through Cloudflare's proxy.
    server.publish('__keepalive__', '');
  }, KEEPALIVE_INTERVAL_MS);

  const server = Bun.serve<WSData>({
    port: PORT,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade: GET /agents/:agentId/stream?ticket=<uuid>
      const wsMatch = url.pathname.match(/^\/agents\/([^/]+)\/stream$/);
      if (wsMatch && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const agentId = wsMatch[1];
        const ticket = url.searchParams.get('ticket');

        if (!ticket) {
          return new Response(JSON.stringify({ error: 'Missing ticket' }), { status: 400 });
        }

        const ticketAgentId = consumeStreamTicket(ticket);
        if (!ticketAgentId) {
          return new Response(JSON.stringify({ error: 'Invalid or expired ticket' }), {
            status: 403,
          });
        }

        if (ticketAgentId !== agentId) {
          return new Response(JSON.stringify({ error: 'Ticket does not match agent' }), {
            status: 403,
          });
        }

        if (!getAgentStatus(agentId)) {
          return new Response(JSON.stringify({ error: `Agent ${agentId} not found` }), {
            status: 404,
          });
        }

        const upgraded = server.upgrade(req, {
          data: { agentId, unsubscribe: null },
        });
        if (!upgraded) {
          return new Response(JSON.stringify({ error: 'WebSocket upgrade failed' }), {
            status: 500,
          });
        }
        // Bun returns undefined on successful upgrade
        return undefined as unknown as Response;
      }

      // All other requests go through Hono
      return app.fetch(req);
    },
    websocket: websocketHandlers,
  });

  console.log(`Town container control server listening on port ${PORT}`);
}
