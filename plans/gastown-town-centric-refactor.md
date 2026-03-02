# Gastown: Town-Centric Refactor & SDK-Based Agent Streaming

## Problem Statement

The current gastown architecture has several structural issues:

1. **Data is fragmented across DOs.** Agent state, beads, mail, and review queues live in the Rig DO. Convoys, escalations, and config live in the Town DO. Mayor state lives in a separate Mayor DO. The Town DO — the logical owner — has no complete picture of the system.

2. **Too many indirection layers for agent streaming.** Events flow: `kilo serve` → SSE → `sse-consumer.ts` → ring buffer → HTTP poll endpoint → `TownContainerDO.pollEvents()` (500ms interval) → WebSocket relay → browser. That's 6 hops with a polling bottleneck in the middle.

3. **Spawning `kilo serve` as a child process is unnecessary.** The `@kilocode/sdk` provides `createOpencode()` which starts a server in-process. We can use the SDK's `client.event.subscribe()` to get a typed event stream directly — no SSE parsing, no ring buffers, no polling.

4. **Model and config are threaded through too many layers.** Models are passed from the client through Next.js, through the worker, through the DO, through the container, and into the agent. Models should be configured at the town/agent level ahead of time.

5. **Container startup is reactive.** Containers spin up on first agent request, causing cold-start delays. They should start proactively when a town is created.

---

## Design Principles

- **Town knows all.** The Town DO is the single source of truth for all control-plane data: rigs, agents, beads, mail, review queues, convoys, escalations, config. Rig DO and Mayor DO are eliminated.
- **Three DOs total.** TownDO (control plane), AgentDO (event storage, one per agent), TownContainerDO (container lifecycle). That's it.
- **WebSocket all the way.** One WebSocket connection per client, multiplexed for all agents. No SSE, no polling, no tickets.
- **SDK, not subprocess.** Use `createOpencode()` / `createOpencodeClient()` from `@kilocode/sdk` instead of spawning `kilo serve` processes.
- **Config at rest, not in flight.** Models, env vars, and agent config are resolved from town/rig config when an agent starts. They are not passed through the request chain.

---

## Architecture Overview

```
Browser
  │
  │ WebSocket (one per town, multiplexed)
  ▼
gastown.worker.ts
  │
  │ DO RPC
  ▼
┌─────────────────────────────────────────────┐
│  TownDO  (all control-plane data)           │
│  ┌─────────────────────────────────────────┐│
│  │ SQLite: rigs, agents, beads, mail,      ││
│  │ review_queue, molecules, bead_events,   ││
│  │ convoys, convoy_beads, escalations      ││
│  └─────────────────────────────────────────┘│
│  KV: town config, rig configs              │
│  Alarm: scheduler, health monitor          │
└──────┬──────────────────┬───────────────────┘
       │                  │ DO RPC (write events)
       │                  ▼
       │  ┌───────────────────────────────────┐
       │  │ AgentDO  (one per agent)          │
       │  │ SQLite: agent_events (unbounded)  │
       │  │ Keyed by agentId                  │
       │  │ Owns: event append, event query,  │
       │  │       historical backfill         │
       │  └───────────────────────────────────┘
       │
       │ fetch() (Container DO RPC)
       ▼
┌─────────────────────────────────────────────┐
│  TownContainerDO  (thin proxy)              │
│  - Accepts WebSocket from worker            │
│  - Forwards to container control server     │
│  - Container lifecycle (start/stop/sleep)   │
└─────────────┬───────────────────────────────┘
              │ HTTP to port 8080
              ▼
┌─────────────────────────────────────────────┐
│  Container                                  │
│  ┌────────────────────────────────────────┐ │
│  │ Control Server (Hono, port 8080)       │ │
│  │  - POST /agents/start                  │ │
│  │  - POST /agents/:id/stop              │ │
│  │  - POST /agents/:id/message           │ │
│  │  - GET  /agents/:id/status            │ │
│  │  - WS   /ws (multiplexed event pipe)  │ │
│  │  - POST /git/merge                    │ │
│  └────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │ Agent Manager (SDK-based, in-process)  │ │
│  │  - createOpencode() per agent          │ │
│  │  - client.event.subscribe() per agent  │ │
│  │  - Events → WebSocket frame            │ │
│  └────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │ Git Manager                            │ │
│  │  - Bare repos, worktrees              │ │
│  │  - Merge operations                   │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

---

## Part 1: Move All Control-Plane Data to TownDO

### What Moves

Everything currently in the Rig DO's SQLite moves to Town DO's SQLite, scoped by a `rig_id` column. The Mayor DO's KV state also moves to Town DO.

#### From Rig DO → Town DO

| Table              | Key Change                                                     |
| ------------------ | -------------------------------------------------------------- |
| `rig_beads`        | Add `rig_id TEXT NOT NULL` column, index on `(rig_id, status)` |
| `rig_agents`       | Add `rig_id TEXT NOT NULL` column, index on `(rig_id, role)`   |
| `rig_mail`         | Already scoped via agent FKs — no change needed                |
| `rig_review_queue` | Add `rig_id TEXT NOT NULL` for queries                         |
| `rig_molecules`    | Already scoped via bead FK — no change needed                  |
| `rig_bead_events`  | Already scoped via bead FK — no change needed                  |
| `rig_agent_events` | **Moves to AgentDO** (see below) — not in Town DO              |

The Town DO already has `town_convoys`, `town_convoy_beads`, `town_escalations`. These stay.

#### From Mayor DO → Town DO

| Data              | Migration                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `mayorConfig` KV  | Merged into town config KV (it's mostly redundant — townId, gitUrl, etc.)                                       |
| `mayorSession` KV | New `mayor_session` KV key in Town DO, or just tracked as a special agent in `rig_agents` with `role = 'mayor'` |

The Mayor becomes just another agent row in `rig_agents` with `role = 'mayor'` and a synthetic `rig_id` (e.g., `mayor-{townId}`). Its session state (agentId, sessionId, status, lastActivityAt) maps directly to the agent table's existing columns.

#### New: Rig Registry Table

Replace KV-based rig registry with a SQL table:

```sql
CREATE TABLE rigs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  git_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  config TEXT DEFAULT '{}', -- JSON: model overrides, env var overrides, etc.
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_rigs_name ON rigs(name);
```

### New: AgentDO (One Per Agent — Event Storage)

Agent events are the highest-volume data in the system. A single agent session can produce thousands of events (`message_part.updated` for every streamed token, tool calls, file edits, etc.). With multiple agents per rig and multiple rigs per town, storing all events in the Town DO's 10GB SQLite limit is untenable.

Each agent gets its own AgentDO instance, keyed by `agentId`. The AgentDO owns:

```sql
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',  -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX idx_agent_events_id ON agent_events(id);
```

**Interface:**

```typescript
export class AgentDO extends DurableObject<Env> {
  // Append an event (called by TownDO as events flow through)
  async appendEvent(eventType: string, data: unknown): Promise<number>; // returns event id

  // Query events for backfill (called by TownContainerDO or worker for late-joining clients)
  async getEvents(afterId?: number, limit?: number): Promise<AgentEvent[]>;

  // Bulk cleanup when agent is deleted
  async destroy(): Promise<void>;
}

export function getAgentDOStub(env: Env, agentId: string) {
  return env.AGENT.get(env.AGENT.idFromName(agentId));
}
```

**Event flow:**

1. Container SDK `event.subscribe()` yields an event
2. Container WS → TownContainerDO WS → TownDO receives the frame
3. TownDO writes to AgentDO: `getAgentDOStub(env, agentId).appendEvent(type, data)`
4. TownDO also relays the frame to subscribed browser clients

**Backfill flow:**

1. Browser sends `{ type: 'subscribe', agentId, afterEventId: 0 }`
2. Worker (or TownDO) queries: `getAgentDOStub(env, agentId).getEvents(afterEventId)`
3. Sends backfill frames, then switches to live relay

This way each agent's event history is isolated in its own DO with its own 10GB budget. A long-running mayor with millions of events won't crowd out polecat event storage. The Town DO stays lean — it tracks the agent row (status, role, hook) but delegates event storage to the AgentDO.

**Cleanup:** When an agent is deleted from the Town DO, call `agentDO.destroy()` to wipe its events. For agents that are no longer active, consider a TTL-based cleanup alarm in the AgentDO (e.g., auto-delete events older than 7 days).

### Rig DO: Eliminated

The Rig DO is deleted entirely. All its data and logic moves to the Town DO. The Town DO's alarm handles scheduling, witness patrol, and review queue processing by iterating over rigs — the SQLite queries are cheap and DO alarms can re-arm at sub-second intervals. If alarm handler duration becomes a problem with many rigs, we can shard work across alarm ticks (e.g., round-robin one rig per tick) rather than reintroducing a separate DO.

Circuit breaker state for dispatch attempts lives in the `dispatch_attempts` column on the agent row — no separate DO needed.

The `RIG` wrangler binding is removed. The `getRigDOStub()` helper is deleted. All handler code that called Rig DO methods calls Town DO methods instead.

### Mayor DO: Eliminated

The Mayor DO is **eliminated**. The mayor is an agent like any other, tracked in the Town DO's `rig_agents` table. The Town DO exposes the same RPC surface the Mayor DO currently has:

- `sendMayorMessage(message)` → creates or resumes the mayor agent, sends a follow-up
- `getMayorStatus()` → queries the mayor agent row

The container doesn't care whether the agent is a mayor or a polecat — it's the same `POST /agents/start` call.

### Migration Strategy

1. Add all tables to Town DO's `initializeDatabase()`. Create the AgentDO class.
2. Copy the Rig DO's CRUD methods to Town DO, adding `rigId` parameters. Move Mayor DO logic into Town DO.
3. Update all handlers to route through Town DO instead of Rig DO / Mayor DO.
4. Update the tool plugin to call Town DO endpoints.
5. Delete Rig DO class, Mayor DO class, and their wrangler bindings (`RIG`, `MAYOR`).
6. Remove `getRigDOStub()`, `getMayorDOStub()` helpers and all call sites.

### API Surface Changes

The gastown worker HTTP routes change from rig-scoped to town-scoped:

```
Before:  POST /api/rigs/:rigId/beads
After:   POST /api/towns/:townId/rigs/:rigId/beads

Before:  POST /api/rigs/:rigId/agents/:agentId/done
After:   POST /api/towns/:townId/agents/:agentId/done
```

Agent-scoped routes don't need a rig prefix since agent IDs are globally unique within a town.

The tool plugin's `GASTOWN_API_URL` and `GASTOWN_RIG_ID` env vars still work — the plugin just hits different URL paths.

---

## Part 2: SDK-Based Agent Management (Replace kilo serve subprocess)

### Current Flow (to be replaced)

```
agent-runner.ts
  → kilo-server.ts: Bun.spawn(['kilo', 'serve', ...])
  → kilo-client.ts: HTTP calls to localhost:4096+
  → sse-consumer.ts: GET /event (SSE stream)
  → process-manager.ts: ring buffer, event polling
```

### New Flow

```
agent-manager.ts
  → createOpencode({ port, config, hostname: '127.0.0.1' })
  → client.session.create()
  → client.session.prompt({ path: { id }, body: { parts, model, system } })
  → client.event.subscribe() → for await (event of stream) → ws.send()
```

### Key Changes

#### Replace `kilo-server.ts` with SDK lifecycle

Instead of spawning `kilo serve` as a child process and managing its stdout/stderr/health polling, use the SDK:

```typescript
import { createOpencode, createOpencodeClient } from '@kilocode/sdk';

// Start a server instance for a workdir
const { client, server } = await createOpencode({
  hostname: '127.0.0.1',
  port: allocatePort(),
  config: buildAgentConfig(request),
});

// Or connect to an existing one
const client = createOpencodeClient({
  baseUrl: `http://127.0.0.1:${port}`,
});
```

This eliminates:

- `kilo-server.ts` entirely (port allocation, process spawn, health polling, stdout piping)
- `kilo-client.ts` entirely (hand-rolled HTTP client with Zod parsing)
- The `Bun.spawn` dependency for kilo processes
- The 60-second health check polling loop
- XDG_CONFIG_HOME manipulation and config file writing

#### Replace `sse-consumer.ts` with SDK event subscription

```typescript
const events = await client.event.subscribe();
for await (const event of events.stream) {
  // Filter by session
  if (event.properties?.sessionID !== sessionId) continue;

  // Forward to the WebSocket connection
  ws.send(
    JSON.stringify({
      agentId: request.agentId,
      event: event.type,
      data: event.properties,
    })
  );

  // Detect completion
  if (event.type === 'session.completed') {
    await reportAgentCompleted(request, 'completed');
    break;
  }
}
```

This eliminates:

- `sse-consumer.ts` entirely (manual SSE text parsing, reconnect logic, chunk buffering)
- The `parseSSEChunk()` / `parseSSEEventData()` Zod schemas for SSE events
- The reconnect-with-backoff loop (SDK handles this internally)
- The `isCompletionEvent()` logic (still needed but simplified with typed events)

#### Replace `process-manager.ts` ring buffers with direct WebSocket forwarding

The current ring buffer + polling architecture exists because SSE events needed to be buffered for the TownContainerDO to poll over HTTP. With a WebSocket pipe from the container to the DO, events flow directly:

```
SDK event.subscribe() → WebSocket frame → TownContainerDO → client WebSocket
```

No buffering needed. Late-joining clients get a backfill from the AgentDO (which persists events for exactly this purpose).

### Files to Delete

| File                            | Reason                              |
| ------------------------------- | ----------------------------------- |
| `container/src/kilo-server.ts`  | Replaced by SDK `createOpencode()`  |
| `container/src/kilo-client.ts`  | Replaced by SDK client              |
| `container/src/sse-consumer.ts` | Replaced by SDK `event.subscribe()` |

### Files to Heavily Refactor

| File                               | Changes                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `container/src/process-manager.ts` | Remove ring buffers, SSE consumers, event buffering. Becomes a thin map of agentId → { client, server, session }      |
| `container/src/agent-runner.ts`    | Use `createOpencode()` instead of `ensureServer()`. Simplify `buildAgentEnv()` since config is passed to SDK directly |
| `container/src/control-server.ts`  | Remove `/agents/:id/events` polling endpoint, stream-ticket endpoints. Add WebSocket endpoint                         |
| `container/src/types.ts`           | Remove SSE event Zod schemas (`SSESessionEvent`, `SSEMessageEvent`, etc.), `KiloServerInstance`, `BufferedEvent`      |

### Files to Keep (mostly unchanged)

| File                           | Notes                                                               |
| ------------------------------ | ------------------------------------------------------------------- |
| `container/src/git-manager.ts` | Git operations don't change                                         |
| `container/src/heartbeat.ts`   | Simplify — may not need per-agent heartbeats if events flow over WS |
| `container/src/main.ts`        | Still starts control server                                         |

---

## Part 3: WebSocket-Based Event Streaming (Replace SSE + Polling + Tickets)

### Current Flow (to be replaced)

```
kilo serve SSE → sse-consumer → ring buffer → HTTP /events?after=N
  ↑ (500ms poll)
TownContainerDO → WebSocket relay → browser

+ Ticket system:
  POST /stream-ticket → ticket UUID → browser passes in WS URL
  TownContainerDO validates ticket on WS upgrade
```

### New Flow

```
SDK event.subscribe() → container WS → TownContainerDO WS → gastown worker → browser

No tickets. No polling. No SSE parsing. No ring buffers.
```

### Container-Side: WebSocket Endpoint

The control server exposes a WebSocket endpoint that multiplexes events from all agents:

```typescript
// container/src/control-server.ts

// WS /ws — multiplexed event stream for all agents in this container
app.get(
  '/ws',
  upgradeWebSocket(c => ({
    onOpen(event, ws) {
      // Register this WS connection for event forwarding
      registerEventSink(ws);
    },
    onClose() {
      unregisterEventSink(ws);
    },
  }))
);
```

When an agent starts and its SDK event subscription yields events, they are forwarded to all registered WebSocket sinks:

```typescript
// In agent-manager.ts, after starting an agent
const events = await client.event.subscribe();
for await (const event of events.stream) {
  if (event.properties?.sessionID !== sessionId) continue;
  broadcastToSinks({
    agentId,
    type: event.type,
    data: event.properties,
    timestamp: new Date().toISOString(),
  });
}
```

### TownContainerDO: WebSocket Relay

The TownContainerDO establishes a single WebSocket connection to the container's `/ws` endpoint. It relays frames to all connected browser clients:

```typescript
export class TownContainerDO extends Container<Env> {
  private containerWs: WebSocket | null = null;
  private clientSessions = new Map<string, Set<WebSocket>>(); // agentId → clients

  override onStart() {
    // Establish WS to container on boot
    this.connectToContainer();
  }

  private async connectToContainer() {
    // Use containerFetch to upgrade to WebSocket
    const resp = await this.containerFetch('http://container/ws', {
      headers: { Upgrade: 'websocket' },
    });
    this.containerWs = resp.webSocket;
    this.containerWs.accept();
    this.containerWs.addEventListener('message', event => {
      const frame = JSON.parse(event.data);
      // Relay to clients subscribed to this agent
      const clients = this.clientSessions.get(frame.agentId);
      if (clients) {
        for (const ws of clients) {
          ws.send(event.data);
        }
      }
    });
  }

  // Browser clients connect here
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleClientWebSocket(request);
    }
    return super.fetch(request);
  }

  private handleClientWebSocket(request: Request): Response {
    const url = new URL(request.url);
    const agentId = url.searchParams.get('agentId');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // Track subscription
    if (agentId) {
      let set = this.clientSessions.get(agentId);
      if (!set) {
        set = new Set();
        this.clientSessions.set(agentId, set);
      }
      set.add(server);
    }

    server.addEventListener('close', () => {
      this.clientSessions.get(agentId)?.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
```

### What Gets Eliminated

| Component                                                                                              | Status                                          |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Stream ticket system (`streamTickets` map, `consumeStreamTicket()`, `POST /stream-ticket`)             | **Deleted**                                     |
| `GET /agents/:id/events?after=N` polling endpoint                                                      | **Deleted**                                     |
| Ring buffer in `process-manager.ts` (`agentEventBuffers`, `MAX_BUFFERED_EVENTS`, `bufferAgentEvent()`) | **Deleted**                                     |
| `TownContainerDO.pollEvents()` (500ms setInterval)                                                     | **Deleted**                                     |
| `TownContainerDO.backfillEvents()` via HTTP                                                            | **Replaced** with historical query from AgentDO |
| `gastown-router.ts` `getAgentStreamUrl` (ticket fetching)                                              | **Replaced** with direct WS URL                 |
| `gastown-client.ts` `getStreamTicket()`                                                                | **Deleted**                                     |
| `town-container.handler.ts` `handleContainerStreamTicket()`                                            | **Deleted**                                     |

### Browser Connection

The browser opens a single WebSocket per town (not per agent). It sends subscription messages to indicate which agents it wants events for:

```typescript
// Browser
const ws = new WebSocket(`wss://gastown.kiloapps.io/api/towns/${townId}/ws`);

// Subscribe to a specific agent's events
ws.send(JSON.stringify({ type: 'subscribe', agentId }));

// Receive multiplexed events
ws.onmessage = event => {
  const frame = JSON.parse(event.data);
  // frame.agentId tells you which agent this event is for
  // frame.type is the event type (message.part.updated, session.idle, etc.)
  // frame.data is the event payload
};
```

### Backfill for Late Joiners

When a browser connects and subscribes to an agent that's already running, it needs historical events. Instead of buffering in the container, query the AgentDO:

1. Browser sends `{ type: 'subscribe', agentId, afterEventId: 0 }`
2. Worker (or TownDO) queries `getAgentDOStub(env, agentId).getEvents(afterEventId)`
3. Sends backfill frames, then switches to live relay

This means the container is stateless for event history — the AgentDO is the source of truth for event data, while the TownDO is the source of truth for agent metadata (status, role, hook, etc.).

---

## Part 4: Proactive Container & Mayor Startup

### Current Behavior

- Container starts lazily on first `fetch()` to the TownContainerDO stub
- Mayor starts when the user sends their first message
- Cold start can take 10-30 seconds

### New Behavior

When a town is created (or when the Town DO is first initialized):

1. **Ping the container** to wake it up: `getTownContainerStub(env, townId).fetch('/health')`
2. **Start the mayor agent** immediately (no user message needed — mayor is always-on)
3. **Container `sleepAfter`** stays at 30m, but the Town DO's alarm re-pings every 25m while the town has recent activity

When no messages are received for 5 minutes:

- The Town DO stops pinging the container
- After 30m of no `fetch()` calls, the container sleeps
- Mayor agent state is preserved in the Town DO — next message restarts it

### Implementation

```typescript
// In Town DO, after town creation or on first alarm
async ensureContainerReady(townId: string): Promise<void> {
  const container = getTownContainerStub(this.env, townId)
  try {
    const resp = await container.fetch('http://container/health')
    if (resp.ok) {
      // Container is up — start mayor if not running
      const mayor = this.getMayorAgent()
      if (!mayor || mayor.status === 'idle') {
        await this.startMayorAgent()
      }
    }
  } catch {
    // Container is starting up — alarm will retry
  }
}
```

---

## Part 5: Config at Rest (Eliminate Model Pass-Through)

### Current Problem

Models flow through 6 layers:

```
Browser → tRPC (model param) → gastown worker → DO → container POST body → kilo serve config
```

### New Approach

Models are configured at the town level (with optional per-rig overrides) and resolved when an agent starts:

```typescript
// Town config (stored in Town DO KV)
{
  default_model: 'anthropic/claude-sonnet-4.6',
  agent_models: {
    mayor: 'anthropic/claude-sonnet-4.6',
    polecat: 'anthropic/claude-sonnet-4.6',
    refinery: 'anthropic/claude-sonnet-4.6',
  },
  // Per-rig overrides
  rig_overrides: {
    'rig-uuid': {
      default_model: 'anthropic/claude-opus-4.6',
    }
  }
}
```

When the Town DO dispatches an agent to the container, it resolves the model from config:

```typescript
function resolveModel(townConfig: TownConfig, rigId: string, role: AgentRole): string {
  // 1. Check rig override
  const rigOverride = townConfig.rig_overrides?.[rigId]?.default_model;
  if (rigOverride) return rigOverride;

  // 2. Check role-specific model
  const roleModel = townConfig.agent_models?.[role];
  if (roleModel) return roleModel;

  // 3. Fall back to town default
  return townConfig.default_model ?? 'anthropic/claude-sonnet-4.6';
}
```

The browser never sends a model. The `sling` tRPC mutation and `sendMayorMessage` mutation drop the `model` parameter.

---

## Part 6: Container Config Freshness (Eliminate Stale Injection)

### Current Problem

The TownContainerDO sets `envVars` once at construction time:

```typescript
envVars: Record<string, string> = {
  ...(this.env.GASTOWN_API_URL ? { GASTOWN_API_URL: this.env.GASTOWN_API_URL } : {}),
  ...(this.env.KILO_API_URL ? { ... } : {}),
}
```

These become OS-level environment variables baked into the container at boot. If a user updates their town config (changes models, rotates a git token, adds env vars), the running container has no way to learn about it. The stale config persists until the container sleeps and restarts — which could be 30+ minutes.

Per-agent env vars are also built at agent start time in `buildAgentEnv()` using `resolveEnv()`, which reads from request body `envVars` or falls back to `process.env`. Once a `kilo serve` process (or SDK instance) is running, its config is frozen.

### New Approach: Config-on-Request

Every `fetch()` from the TownDO to the container includes the current resolved config as a header or request body field. The container's control server applies it before processing the request.

**What goes in the config payload:**

```typescript
type ContainerConfig = {
  // Resolved env vars (town-level + rig overrides merged)
  env_vars: Record<string, string>;
  // Models by role (pre-resolved, no need for the container to look up config)
  models: Record<AgentRole, string>;
  // Auth tokens (git, LLM gateway)
  kilo_api_url: string;
  kilocode_token: string;
  git_token?: string;
};
```

**Where it's attached:**

The TownDO resolves the current config from its KV/SQLite before every container call and includes it:

```typescript
// In Town DO, every call to the container
async containerFetch(path: string, init?: RequestInit): Promise<Response> {
  const config = await this.resolveContainerConfig()
  const container = getTownContainerStub(this.env, this.townId)
  return container.fetch(`http://container${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      'X-Town-Config': JSON.stringify(config),
    },
  })
}
```

**How the container uses it:**

A Hono middleware on the control server extracts and applies the config:

```typescript
app.use('*', async (c, next) => {
  const configHeader = c.req.header('X-Town-Config');
  if (configHeader) {
    const parsed = ContainerConfig.safeParse(JSON.parse(configHeader));
    if (parsed.success) {
      applyConfig(parsed.data);
    }
  }
  await next();
});
```

`applyConfig()` updates a module-level config store that `buildAgentEnv()` and `createOpencode()` read from. For already-running agents, config changes take effect on the next message or restart — we don't hot-reload running SDK instances.

**What stays as OS-level envVars on TownContainerDO:**

Only truly static infrastructure URLs that the control server needs at boot before any TownDO request arrives:

```typescript
envVars = {
  ...(this.env.GASTOWN_API_URL ? { GASTOWN_API_URL: this.env.GASTOWN_API_URL } : {}),
};
```

Everything else (models, tokens, user-configured env vars) comes per-request from the TownDO.

**Benefits:**

- Zero staleness — every request gets the latest config
- No polling timer or refresh interval
- Trivial payload size (< 2KB of JSON)
- Config changes take effect immediately for new agents, and on next message for running agents

---

## Implementation Order

### Phase A: Data Consolidation (Town-Centric)

**PR A1: Town DO schema + AgentDO**

- Add `rigs`, `rig_beads`, `rig_agents`, `rig_mail`, `rig_review_queue`, `rig_molecules`, `rig_bead_events` tables to Town DO
- Create `AgentDO` class with `agent_events` table, `appendEvent()`, `getEvents()`, `destroy()`
- Add `AGENT` binding to wrangler.jsonc, add migration tag for new SQLite class
- Copy CRUD methods from Rig DO → Town DO (add rigId params)
- Move Mayor DO session logic into Town DO (mayor = agent row with `role = 'mayor'`)
- Town DO exposes the union of Rig DO + Mayor DO RPC methods

**PR A2: Route all handlers through Town DO + delete Rig DO and Mayor DO**

- Update all gastown worker handlers to call Town DO instead of Rig DO / Mayor DO
- Update tool plugin URLs and handler routing
- Consolidate alarm: single Town DO alarm handles scheduling, witness patrol, review queue, container health, mayor health, stale escalation re-escalation (15s active / 5m idle)
- Delete Rig DO class, Mayor DO class
- Remove `RIG` and `MAYOR` bindings from wrangler.jsonc
- Delete `getRigDOStub()`, `getMayorDOStub()` and all call sites

### Phase B: SDK-Based Agent Management

**PR B1: Replace kilo-server.ts with SDK**

- Use `createOpencode()` to start server instances
- Use `createOpencodeClient()` to connect
- Delete `kilo-server.ts`, update `agent-runner.ts`

**PR B2: Replace SSE consumer with SDK event subscription**

- Use `client.event.subscribe()` for typed event streams
- Delete `sse-consumer.ts`, update `process-manager.ts`
- Events forwarded directly to a WebSocket sink (next PR)

**PR B3: Replace kilo-client.ts with SDK client**

- Use `client.session.create()`, `client.session.prompt()`, `client.session.abort()`
- Delete `kilo-client.ts`

### Phase C: WebSocket Streaming

**PR C1: Container WebSocket endpoint**

- Add `WS /ws` endpoint to control server
- Agent manager forwards SDK events to WS sinks
- Remove ring buffers, polling endpoint, ticket system from control server

**PR C2: TownContainerDO WebSocket relay**

- Establish WS to container `/ws` on start
- Relay frames to subscribed browser clients
- Remove `pollEvents()`, `backfillEvents()`, ticket validation

**PR C3: Browser WebSocket client**

- Single WS per town, multiplexed subscriptions
- Remove `getAgentStreamUrl` tRPC, ticket fetching
- Update `AgentStream.tsx` to use the new WS protocol

### Phase D: Proactive Startup & Config Cleanup

**PR D1: Proactive container + mayor startup**

- Town DO pings container on creation and alarm
- Mayor starts automatically

**PR D2: Config at rest + config-on-request**

- Models resolved from town config, not passed through request chain
- Drop `model` params from tRPC mutations and container requests
- TownDO attaches current resolved config (`X-Town-Config` header) to every container `fetch()`
- Container control server middleware extracts and applies config before handling each request
- Remove user-configured env vars and tokens from TownContainerDO's static `envVars` (keep only infra URLs needed at boot)
- New agents get the latest config; running agents pick it up on next message

---

## Risk Mitigation

**Data migration**: Town DO SQLite starts empty for new towns. Existing towns need a migration alarm that copies data from Rig DO → Town DO on first access. Use a `migrated` KV flag.

**WebSocket reliability**: Cloudflare WebSocket connections can drop. The browser client must reconnect and request backfill from the AgentDO. The container-to-DO WebSocket must also reconnect — use the DO's `onStart()` hook.

**SDK compatibility**: The container currently uses `@kilocode/sdk@1.0.23`. Verify that `createOpencode()` works in the Bun container environment and that `event.subscribe()` returns an async iterable. If the SDK version doesn't support this, use `createOpencodeClient()` with a manually spawned server as an intermediate step.

**Alarm contention**: A single Town DO alarm handling 10 rigs with 50 agents must complete in <30s (DO alarm deadline). Monitor alarm duration and split into per-rig alarms if needed.

**DO storage limits**: Cloudflare DOs have a 10GB SQLite limit. Agent events are isolated in per-agent AgentDOs to avoid one busy town exhausting the Town DO's storage. The Town DO stores only control-plane data (agent rows, beads, mail, etc.) which is bounded — even a large town with 100 rigs and 500 agents will use <100MB. Each AgentDO gets its own 10GB budget; consider TTL-based event pruning (e.g., 7-day rolling window) for long-running agents like the mayor.
