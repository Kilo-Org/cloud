import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runAgent } from './agent-runner.js';
import {
  stopProcess,
  sendMessage,
  getProcessStatus,
  activeProcessCount,
  getUptime,
  stopAll,
} from './process-manager.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { StartAgentRequest, StopAgentRequest, SendMessageRequest } from './types.js';
import type { AgentStatusResponse, HealthResponse, StreamTicketResponse } from './types.js';

const PORT = 8080;

// Simple stream ticket store (ticket → agentId, expires after 60s)
const streamTickets = new Map<string, { agentId: string; expiresAt: number }>();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Safely parse request body as JSON. Returns null on malformed input
 * so callers can respond with 400 rather than letting it bubble as 500.
 */
function parseBody(req: IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Match a URL path against a pattern with named params.
 * Pattern uses :paramName syntax, e.g. "/agents/:agentId/stop"
 */
function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.startsWith(':')) {
      params[pp.slice(1)] = pathParts[i];
    } else if (pp !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // GET /health
    if (method === 'GET' && pathname === '/health') {
      const response: HealthResponse = {
        status: 'ok',
        agents: activeProcessCount(),
        uptime: getUptime(),
      };
      json(res, 200, response);
      return;
    }

    // POST /agents/start
    if (method === 'POST' && pathname === '/agents/start') {
      const body = await parseBody(req);
      const parsed = StartAgentRequest.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: 'Invalid request body', issues: parsed.error.issues });
        return;
      }

      const agentProcess = await runAgent(parsed.data);
      json(res, 201, agentProcess);
      return;
    }

    // POST /agents/:agentId/stop
    const stopMatch = matchRoute('/agents/:agentId/stop', pathname);
    if (method === 'POST' && stopMatch) {
      const body = await parseBody(req);
      const parsed = StopAgentRequest.safeParse(body);
      const signal = parsed.success ? parsed.data.signal : undefined;

      await stopProcess(stopMatch.agentId, signal);
      json(res, 200, { stopped: true });
      return;
    }

    // POST /agents/:agentId/message
    const msgMatch = matchRoute('/agents/:agentId/message', pathname);
    if (method === 'POST' && msgMatch) {
      const body = await parseBody(req);
      const parsed = SendMessageRequest.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: 'Invalid request body', issues: parsed.error.issues });
        return;
      }

      sendMessage(msgMatch.agentId, parsed.data.prompt);
      json(res, 200, { sent: true });
      return;
    }

    // GET /agents/:agentId/status
    const statusMatch = matchRoute('/agents/:agentId/status', pathname);
    if (method === 'GET' && statusMatch) {
      const proc = getProcessStatus(statusMatch.agentId);
      if (!proc) {
        json(res, 404, { error: `Agent ${statusMatch.agentId} not found` });
        return;
      }

      const response: AgentStatusResponse = {
        agentId: proc.agentId,
        status: proc.status,
        pid: proc.pid,
        exitCode: proc.exitCode,
        startedAt: proc.startedAt,
        lastActivityAt: proc.lastActivityAt,
      };
      json(res, 200, response);
      return;
    }

    // POST /agents/:agentId/stream-ticket
    const ticketMatch = matchRoute('/agents/:agentId/stream-ticket', pathname);
    if (method === 'POST' && ticketMatch) {
      const proc = getProcessStatus(ticketMatch.agentId);
      if (!proc) {
        json(res, 404, { error: `Agent ${ticketMatch.agentId} not found` });
        return;
      }

      const ticket = crypto.randomUUID();
      const expiresAt = Date.now() + 60_000;
      streamTickets.set(ticket, { agentId: ticketMatch.agentId, expiresAt });

      // Clean up expired tickets
      for (const [t, v] of streamTickets) {
        if (v.expiresAt < Date.now()) streamTickets.delete(t);
      }

      const response: StreamTicketResponse = {
        ticket,
        expiresAt: new Date(expiresAt).toISOString(),
      };
      json(res, 200, response);
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('Control server error:', err);
    json(res, 500, { error: message });
  }
}

/**
 * Start the control server on the configured port.
 * This is the entrypoint for the container image.
 */
export function startControlServer(): void {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  // Start heartbeat if env vars are configured.
  // INTERNAL_API_SECRET matches the worker's auth middleware secret name.
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
    server.close(() => {
      console.log('Control server stopped');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  server.listen(PORT, () => {
    console.log(`Town container control server listening on port ${PORT}`);
  });
}
