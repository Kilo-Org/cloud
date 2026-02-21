import { Container } from '@cloudflare/containers';

const TC_LOG = '[TownContainer.do]';

/** Polling interval for relaying container events to WebSocket clients. */
const POLL_INTERVAL_MS = 500;

/**
 * TownContainer — a Cloudflare Container per town.
 *
 * All agent processes for a town run inside this container via the SDK.
 * The container exposes an HTTP control server on port 8080.
 *
 * This DO:
 * - Manages container lifecycle (start/sleep/stop)
 * - Accepts WebSocket connections from browser clients
 * - Polls the container's HTTP /agents/:id/events endpoint
 * - Relays events from container → browser WebSocket
 *
 * Note: containerFetch does NOT support WebSocket upgrades, so we use
 * HTTP polling for the DO→container link and WebSocket for the DO→browser link.
 */
export class TownContainerDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';

  // Only infra URLs needed at boot. User config comes per-request via X-Town-Config.
  envVars: Record<string, string> = {
    ...(this.env.GASTOWN_API_URL ? { GASTOWN_API_URL: this.env.GASTOWN_API_URL } : {}),
    ...(this.env.KILO_API_URL
      ? {
          KILO_API_URL: this.env.KILO_API_URL,
          KILO_OPENROUTER_BASE: `${this.env.KILO_API_URL}/api`,
        }
      : {}),
  };

  // Browser WebSocket sessions: agentId → set of { ws, lastEventId }
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

    // Match agent stream path (works with both full worker path and short path)
    const streamMatch = url.pathname.match(/\/agents\/([^/]+)\/stream$/);
    if (streamMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleStreamWebSocket(streamMatch[1]);
    }

    // Multiplexed WS endpoint
    if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const agentId = url.searchParams.get('agentId');
      return this.handleStreamWebSocket(agentId ?? '__all__');
    }

    return super.fetch(request);
  }

  /**
   * Handle a WebSocket upgrade for agent streaming.
   * Creates a WebSocketPair, starts polling the container for events,
   * and relays them to the connected client.
   */
  private handleStreamWebSocket(agentId: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    console.log(`${TC_LOG} WS connected: agent=${agentId}`);

    let sessions = this.wsSessions.get(agentId);
    if (!sessions) {
      sessions = new Set();
      this.wsSessions.set(agentId, sessions);
    }
    const session = { ws: server, lastEventId: 0 };
    sessions.add(session);

    // Start polling if not already running
    this.ensurePolling();

    // Send historical backfill
    void this.backfillEvents(agentId, server, session);

    // Handle subscribe messages from client
    server.addEventListener('message', event => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.type === 'subscribe' && msg.agentId) {
          let targetSessions = this.wsSessions.get(msg.agentId);
          if (!targetSessions) {
            targetSessions = new Set();
            this.wsSessions.set(msg.agentId, targetSessions);
          }
          targetSessions.add(session);
          console.log(`${TC_LOG} WS client subscribed to agent=${msg.agentId}`);
        }
      } catch {
        // Ignore
      }
    });

    server.addEventListener('close', event => {
      console.log(`${TC_LOG} WS closed: agent=${agentId} code=${event.code}`);
      sessions.delete(session);
      if (sessions.size === 0) this.wsSessions.delete(agentId);
      // Also remove from any other subscription sets
      for (const [key, set] of this.wsSessions) {
        set.delete(session);
        if (set.size === 0) this.wsSessions.delete(key);
      }
      if (this.wsSessions.size === 0) this.stopPolling();
    });

    server.addEventListener('error', event => {
      console.error(`${TC_LOG} WS error: agent=${agentId}`, event);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Backfill all buffered events from the container to a newly connected client.
   */
  private async backfillEvents(
    agentId: string,
    ws: WebSocket,
    session: { ws: WebSocket; lastEventId: number }
  ): Promise<void> {
    try {
      // Send current agent status
      const statusRes = await this.containerFetch(`http://container/agents/${agentId}/status`);
      if (statusRes.ok) {
        const status = (await statusRes.json()) as Record<string, unknown>;
        ws.send(JSON.stringify({ event: 'agent.status', data: status }));
      }

      // Fetch and send all buffered events
      const eventsRes = await this.containerFetch(
        `http://container/agents/${agentId}/events?after=0`
      );
      if (eventsRes.ok) {
        const body = (await eventsRes.json()) as {
          events: Array<{ id: number; event: string; data: unknown; timestamp: string }>;
        };
        if (body.events && body.events.length > 0) {
          for (const evt of body.events) {
            try {
              ws.send(JSON.stringify({ event: evt.event, data: evt.data }));
            } catch {
              return; // WS closed during backfill
            }
          }
          session.lastEventId = body.events[body.events.length - 1].id;
        }
      }
    } catch (err) {
      console.error(`${TC_LOG} backfill error: agent=${agentId}`, err);
    }
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    // Use ctx.setInterval via blockConcurrencyWhile workaround:
    // containerFetch only works in the DO's request/alarm context.
    // Use the DO alarm for polling instead of setInterval.
    this.pollTimer = true as unknown as ReturnType<typeof setInterval>;
    void this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    console.log(`${TC_LOG} Started event polling via alarm (${POLL_INTERVAL_MS}ms)`);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      this.pollTimer = null;
      void this.ctx.storage.deleteAlarm();
      console.log(`${TC_LOG} Stopped event polling`);
    }
  }

  /**
   * Alarm handler — polls the container for events and relays to WS clients.
   * Used instead of setInterval because containerFetch only works within
   * the DO's request/alarm execution context.
   */
  async alarm(): Promise<void> {
    if (this.wsSessions.size === 0) return;

    await this.pollEvents();

    // Re-arm if there are still active sessions
    if (this.wsSessions.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  private pollCount = 0;

  /**
   * Poll the container for new events for each agent with active WS sessions.
   */
  private async pollEvents(): Promise<void> {
    this.pollCount++;

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
        if (!res.ok) {
          if (this.pollCount <= 3) {
            console.log(`${TC_LOG} poll: agent=${agentId} after=${minLastId} status=${res.status}`);
          }
          continue;
        }

        const body = (await res.json()) as {
          events: Array<{ id: number; event: string; data: unknown; timestamp: string }>;
        };

        if (this.pollCount <= 5 || (body.events && body.events.length > 0)) {
          console.log(
            `${TC_LOG} poll: agent=${agentId} after=${minLastId} events=${body.events?.length ?? 0}`
          );
        }

        if (!body.events || body.events.length === 0) continue;

        for (const evt of body.events) {
          const msg = JSON.stringify({ event: evt.event, data: evt.data });
          for (const session of sessions) {
            if (evt.id > session.lastEventId) {
              try {
                session.ws.send(msg);
                session.lastEventId = evt.id;
              } catch {
                // WS likely closed
              }
            }
          }
        }
      } catch (err) {
        if (this.pollCount <= 3) {
          console.error(`${TC_LOG} poll error: agent=${agentId}`, err);
        }
      }
    }
  }
}

export function getTownContainerStub(env: Env, townId: string) {
  return env.TOWN_CONTAINER.get(env.TOWN_CONTAINER.idFromName(townId));
}
