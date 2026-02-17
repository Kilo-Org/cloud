import { Hono } from 'hono';
import { runAgent } from './agent-runner';
import {
  stopProcess,
  sendMessage,
  getProcessStatus,
  activeProcessCount,
  getUptime,
  stopAll,
} from './process-manager';
import { startHeartbeat, stopHeartbeat } from './heartbeat';
import { StartAgentRequest, StopAgentRequest, SendMessageRequest } from './types';
import type { AgentStatusResponse, HealthResponse, StreamTicketResponse } from './types';

// Simple stream ticket store (ticket -> agentId, expires after 60s)
const streamTickets = new Map<string, { agentId: string; expiresAt: number }>();

export const app = new Hono();

// GET /health
app.get('/health', c => {
  const response: HealthResponse = {
    status: 'ok',
    agents: activeProcessCount(),
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

  const agentProcess = await runAgent(parsed.data);
  return c.json(agentProcess, 201);
});

// POST /agents/:agentId/stop
app.post('/agents/:agentId/stop', async c => {
  const { agentId } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const parsed = StopAgentRequest.safeParse(body);
  const signal = parsed.success ? parsed.data.signal : undefined;

  await stopProcess(agentId, signal ?? 'SIGTERM');
  return c.json({ stopped: true });
});

// POST /agents/:agentId/message
app.post('/agents/:agentId/message', async c => {
  const { agentId } = c.req.param();
  const body = await c.req.json().catch(() => null);
  const parsed = SendMessageRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  sendMessage(agentId, parsed.data.prompt);
  return c.json({ sent: true });
});

// GET /agents/:agentId/status
app.get('/agents/:agentId/status', c => {
  const { agentId } = c.req.param();
  const proc = getProcessStatus(agentId);
  if (!proc) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }

  const response: AgentStatusResponse = {
    agentId: proc.agentId,
    status: proc.status,
    pid: proc.pid,
    exitCode: proc.exitCode,
    startedAt: proc.startedAt,
    lastActivityAt: proc.lastActivityAt,
  };
  return c.json(response);
});

// POST /agents/:agentId/stream-ticket
app.post('/agents/:agentId/stream-ticket', c => {
  const { agentId } = c.req.param();
  const proc = getProcessStatus(agentId);
  if (!proc) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }

  const ticket = crypto.randomUUID();
  const expiresAt = Date.now() + 60_000;
  streamTickets.set(ticket, { agentId, expiresAt });

  // Clean up expired tickets
  for (const [t, v] of streamTickets) {
    if (v.expiresAt < Date.now()) streamTickets.delete(t);
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
 * Start the control server using Bun.serve + Hono.
 */
export function startControlServer(): void {
  const PORT = 8080;

  // Start heartbeat if env vars are configured
  const apiUrl = process.env.GASTOWN_API_URL;
  const apiKey = process.env.INTERNAL_API_SECRET;
  if (apiUrl && apiKey) {
    startHeartbeat(apiUrl, apiKey);
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

  Bun.serve({
    port: PORT,
    fetch: app.fetch,
  });

  console.log(`Town container control server listening on port ${PORT}`);
}
