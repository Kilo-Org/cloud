import { Container } from '@cloudflare/containers';

const TC_LOG = '[TownContainer.do]';

/**
 * TownContainer — a Cloudflare Container per town.
 *
 * All agent processes (Mayor, Polecats, Refinery) for a town run inside
 * this container via the SDK. The container exposes:
 * - HTTP control server on port 8080 (start/stop/message/status/merge)
 * - WebSocket on /ws that multiplexes events from all agents
 *
 * This DO:
 * - Manages container lifecycle (start/sleep/stop)
 * - Connects to the container's /ws endpoint for event streaming
 * - Accepts WebSocket connections from browser clients
 * - Relays agent events from container → browser
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

  // Browser WebSocket clients: agentId → set of server-side WebSockets
  private clientSubscriptions = new Map<string, Set<WebSocket>>();
  // WebSocket connection to the container's /ws endpoint
  private containerWs: WebSocket | null = null;
  private containerWsConnecting = false;

  override onStart(): void {
    console.log(`${TC_LOG} container started for DO id=${this.ctx.id.toString()}`);
    // Establish WS connection to container for event relay
    void this.connectToContainerWs();
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    console.log(
      `${TC_LOG} container stopped: exitCode=${exitCode} reason=${reason} id=${this.ctx.id.toString()}`
    );
    this.disconnectContainerWs();
    this.closeAllClients('Container stopped');
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

    // WebSocket upgrade for agent streaming
    // Matches both /agents/:id/stream (legacy) and /ws?agentId=:id (new)
    const streamMatch = url.pathname.match(/\/agents\/([^/]+)\/stream$/);
    if (streamMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleClientWebSocket(streamMatch[1]);
    }

    // New multiplexed WS endpoint
    if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const agentId = url.searchParams.get('agentId');
      return this.handleClientWebSocket(agentId);
    }

    return super.fetch(request);
  }

  /**
   * Handle a WebSocket upgrade from a browser client.
   * If agentId is provided, subscribes to that agent's events.
   * If null, subscribes to all events.
   */
  private handleClientWebSocket(agentId: string | null): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    const subscriptionKey = agentId ?? '__all__';
    console.log(`${TC_LOG} WS client connected: agent=${subscriptionKey}`);

    let sessions = this.clientSubscriptions.get(subscriptionKey);
    if (!sessions) {
      sessions = new Set();
      this.clientSubscriptions.set(subscriptionKey, sessions);
    }
    sessions.add(server);

    // Ensure container WS is connected for relay
    void this.connectToContainerWs();

    // Handle messages from client (subscribe/unsubscribe)
    server.addEventListener('message', event => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.type === 'subscribe' && msg.agentId) {
          // Add subscription for specific agent
          let targetSessions = this.clientSubscriptions.get(msg.agentId);
          if (!targetSessions) {
            targetSessions = new Set();
            this.clientSubscriptions.set(msg.agentId, targetSessions);
          }
          targetSessions.add(server);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    server.addEventListener('close', () => {
      console.log(`${TC_LOG} WS client disconnected: agent=${subscriptionKey}`);
      sessions.delete(server);
      if (sessions.size === 0) this.clientSubscriptions.delete(subscriptionKey);
      // Also remove from any other subscription sets
      for (const [key, set] of this.clientSubscriptions) {
        set.delete(server);
        if (set.size === 0) this.clientSubscriptions.delete(key);
      }
    });

    server.addEventListener('error', event => {
      console.error(`${TC_LOG} WS client error: agent=${subscriptionKey}`, event);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Connect to the container's /ws endpoint for event relay.
   * Events from the container are forwarded to subscribed browser clients.
   */
  private async connectToContainerWs(): Promise<void> {
    if (this.containerWs || this.containerWsConnecting) return;
    this.containerWsConnecting = true;

    try {
      // containerFetch is provided by the Container base class
      const res = await this.containerFetch('http://container/ws', {
        headers: { Upgrade: 'websocket' },
      });

      const ws = res.webSocket;
      if (!ws) {
        console.warn(`${TC_LOG} Container /ws upgrade failed — no webSocket on response`);
        return;
      }

      ws.accept();
      this.containerWs = ws;

      ws.addEventListener('message', event => {
        // Relay to subscribed browser clients
        const frameStr = String(event.data);
        try {
          const frame = JSON.parse(frameStr);
          const agentId = frame.agentId;

          // Send to agent-specific subscribers
          const agentClients = agentId ? this.clientSubscriptions.get(agentId) : undefined;
          if (agentClients) {
            for (const clientWs of agentClients) {
              try {
                clientWs.send(frameStr);
              } catch {
                agentClients.delete(clientWs);
              }
            }
          }

          // Send to wildcard subscribers
          const allClients = this.clientSubscriptions.get('__all__');
          if (allClients) {
            for (const clientWs of allClients) {
              try {
                clientWs.send(frameStr);
              } catch {
                allClients.delete(clientWs);
              }
            }
          }
        } catch {
          // Ignore malformed frames
        }
      });

      ws.addEventListener('close', () => {
        console.log(`${TC_LOG} Container WS closed, will reconnect on next request`);
        this.containerWs = null;
      });

      ws.addEventListener('error', event => {
        console.error(`${TC_LOG} Container WS error:`, event);
        this.containerWs = null;
      });

      console.log(`${TC_LOG} Connected to container /ws for event relay`);
    } catch (err) {
      console.warn(`${TC_LOG} Failed to connect to container /ws:`, err);
    } finally {
      this.containerWsConnecting = false;
    }
  }

  private disconnectContainerWs(): void {
    if (this.containerWs) {
      try {
        this.containerWs.close(1000, 'Container stopping');
      } catch {
        // Best-effort
      }
      this.containerWs = null;
    }
  }

  private closeAllClients(reason: string): void {
    for (const sessions of this.clientSubscriptions.values()) {
      for (const ws of sessions) {
        try {
          ws.close(1001, reason);
        } catch {
          // Best-effort
        }
      }
    }
    this.clientSubscriptions.clear();
  }
}

export function getTownContainerStub(env: Env, townId: string) {
  return env.TOWN_CONTAINER.get(env.TOWN_CONTAINER.idFromName(townId));
}
