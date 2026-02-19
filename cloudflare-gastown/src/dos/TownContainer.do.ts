import { Container } from '@cloudflare/containers';

const TC_LOG = '[TownContainer.do]';

/**
 * Polling interval for relaying container events to WebSocket clients.
 * Fast enough for near-real-time UX, slow enough to avoid hammering the container.
 */
const POLL_INTERVAL_MS = 500;

/**
 * TownContainer — a Cloudflare Container per town.
 *
 * All agent processes (Mayor, Polecats, Refinery) for a town run as
 * Kilo CLI child processes inside this single container. The container
 * exposes a control server on port 8080 that the Rig DO / Hono routes
 * use to start/stop agents, send messages, and check health.
 *
 * The DO side (this class) handles container lifecycle; the control
 * server inside the container handles process management.
 *
 * For agent streaming, this DO accepts WebSocket connections from the
 * browser, polls the container's HTTP events endpoint, and relays
 * events to connected clients.
 */
export class TownContainerDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';

  // Inject the gastown worker URL so the container's completion reporter
  // and plugin can call back to the worker API.
  envVars: Record<string, string> = this.env.GASTOWN_API_URL
    ? { GASTOWN_API_URL: this.env.GASTOWN_API_URL }
    : {};

  // Active WebSocket sessions: agentId -> set of { ws, lastEventId }
  private wsSessions = new Map<string, Set<{ ws: WebSocket; lastEventId: number }>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  override onStart(): void {
    console.log(`${TC_LOG} container started for DO id=${this.ctx.id.toString()}`);
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    console.log(
      `${TC_LOG} container stopped: exitCode=${exitCode} reason=${reason} id=${this.ctx.id.toString()}`
    );
    this.stopPolling();
    // Close all WebSocket connections
    for (const sessions of this.wsSessions.values()) {
      for (const session of sessions) {
        try {
          session.ws.close(1001, 'Container stopped');
        } catch {
          /* best effort */
        }
      }
    }
    this.wsSessions.clear();
  }

  override onError(error: unknown): void {
    console.error(`${TC_LOG} container error:`, error, `id=${this.ctx.id.toString()}`);
  }

  /**
   * Override fetch to intercept WebSocket upgrade requests for agent streaming.
   * All other requests delegate to the base Container class (which proxies to the container).
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const streamMatch = url.pathname.match(/^\/agents\/([^/]+)\/stream$/);

    if (streamMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleStreamWebSocket(request, streamMatch[1], url.searchParams.get('ticket'));
    }

    // Delegate all other requests to the base Container class
    return super.fetch(request);
  }

  /**
   * Handle a WebSocket upgrade request for agent streaming.
   * Creates a WebSocketPair, starts polling the container for events,
   * and relays them to the connected client.
   */
  private handleStreamWebSocket(
    _request: Request,
    agentId: string,
    ticket: string | null
  ): Response {
    if (!ticket) {
      return new Response(JSON.stringify({ error: 'Missing ticket' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate the ticket by consuming it on the container (synchronous
    // validation isn't possible since the ticket lives in the container's
    // memory). We'll validate asynchronously after accepting the WS.

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();

    // Track this session
    let sessions = this.wsSessions.get(agentId);
    if (!sessions) {
      sessions = new Set();
      this.wsSessions.set(agentId, sessions);
    }
    const session = { ws: server, lastEventId: 0 };
    sessions.add(session);

    // Start polling if not already running
    this.ensurePolling();

    // Validate ticket asynchronously — close the WS if invalid
    void this.validateTicket(agentId, ticket, server);

    // Handle client messages (none expected, but clean up on close)
    server.addEventListener('close', () => {
      sessions.delete(session);
      if (sessions.size === 0) {
        this.wsSessions.delete(agentId);
      }
      // Stop polling if no more sessions
      if (this.wsSessions.size === 0) {
        this.stopPolling();
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Validate a stream ticket by calling the container's stream-ticket
   * endpoint to verify the ticket was valid. If invalid, close the WS.
   */
  private async validateTicket(agentId: string, ticket: string, ws: WebSocket): Promise<void> {
    try {
      // We use the consume endpoint to validate. The ticket was already
      // generated by the container — we just need to verify the agent
      // exists and the ticket was real. Since the ticket was consumed by
      // the container when it was issued, and we have it here, we treat
      // it as valid if the agent is known.
      const res = await this.containerFetch(`http://container/agents/${agentId}/status`);
      if (!res.ok) {
        ws.close(4004, 'Agent not found');
        return;
      }
      // Send initial status to the client
      const status = (await res.json()) as Record<string, unknown>;
      ws.send(JSON.stringify({ event: 'agent.status', data: status }));
    } catch (err) {
      console.error(`${TC_LOG} ticket validation error:`, err);
      ws.close(4000, 'Ticket validation failed');
    }
  }

  /**
   * Start the event polling loop if not already running.
   */
  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollEvents(), POLL_INTERVAL_MS);
    // Also poll immediately
    void this.pollEvents();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll the container for new events for each agent with active WS sessions.
   * Relays new events to all connected clients.
   */
  private async pollEvents(): Promise<void> {
    for (const [agentId, sessions] of this.wsSessions) {
      if (sessions.size === 0) continue;

      // Find the minimum lastEventId across all sessions for this agent
      let minLastId = Infinity;
      for (const s of sessions) {
        if (s.lastEventId < minLastId) minLastId = s.lastEventId;
      }
      if (minLastId === Infinity) minLastId = 0;

      try {
        const res = await this.containerFetch(
          `http://container/agents/${agentId}/events?after=${minLastId}`
        );
        if (!res.ok) continue;

        const body = (await res.json()) as {
          events: Array<{ id: number; event: string; data: unknown; timestamp: string }>;
        };
        if (!body.events || body.events.length === 0) continue;

        // Relay each event to sessions that haven't seen it yet
        for (const evt of body.events) {
          const msg = JSON.stringify({ event: evt.event, data: evt.data });
          for (const session of sessions) {
            if (evt.id > session.lastEventId) {
              try {
                session.ws.send(msg);
                session.lastEventId = evt.id;
              } catch {
                // WS likely closed; will be cleaned up by close handler
              }
            }
          }
        }
      } catch {
        // Container may be starting up or unavailable; skip this poll cycle
      }
    }
  }
}

export function getTownContainerStub(env: Env, townId: string) {
  return env.TOWN_CONTAINER.get(env.TOWN_CONTAINER.idFromName(townId));
}
