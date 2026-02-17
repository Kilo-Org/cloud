# Implementation Plan: Gastown Cloud (Proposal D — Revised)

Cloud-first rewrite of gastown's core tenets as a Kilo platform feature. See `docs/gt/hosted-gastown-proposals.md` — Proposal D for the full architecture rationale.

**Key design decisions:**

- All orchestration state lives in Durable Objects (SQLite) + Postgres (read replica for dashboard)
- Agents interact with gastown via **tool calls** backed by DO RPCs — no filesystem coordination, no `gt`/`bd` binaries
- Each town gets a **Cloudflare Container** that runs all agent processes (Kilo CLI instances) — one container per town, not one per agent
- The DO is the **scheduler**: alarms scan for pending work and signal the container to start/stop agent processes
- The container is the **execution runtime**: it receives commands from the DO, spawns Kilo CLI processes, and routes tool calls back to the DO
- LLM calls route through the Kilo gateway (`KILO_API_URL`)
- Watchdog/health monitoring uses DO alarms — the DO can independently verify container health and re-dispatch work if the container dies

**Architecture overview:**

```
┌──────────────┐     tRPC      ┌──────────────────┐
│   Dashboard  │◄─────────────►│   Next.js Backend │
│   (Next.js)  │               │   (Postgres r/w)  │
└──────────────┘               └────────┬─────────┘
                                        │ internal auth
                                        ▼
                               ┌──────────────────┐
                               │  Gastown Worker   │
                               │  (Hono router)    │
                               └────────┬─────────┘
                                        │ DO RPC
                          ┌─────────────┼─────────────┐
                          ▼             ▼             ▼
                    ┌──────────┐  ┌──────────┐  ┌──────────┐
                    │  Rig DO  │  │ Town DO  │  │ Agent ID │
                    │ (SQLite) │  │ (SQLite) │  │   DO     │
                    └─────┬────┘  └──────────┘  └──────────┘
                          │
                          │ alarm fires → fetch()
                          ▼
                    ┌──────────────────────┐
                    │   Town Container     │
                    │  ┌────────────────┐  │
                    │  │ Control Server │  │  ◄── receives start/stop/health commands
                    │  └───────┬────────┘  │
                    │          │            │
                    │  ┌───────┴────────┐  │
                    │  │ Agent Processes │  │  ◄── Kilo CLI instances (Mayor, Polecats, Refinery)
                    │  │  ┌──────────┐  │  │
                    │  │  │ Polecat1 │  │  │  ──► tool calls ──► DO RPCs
                    │  │  │ Polecat2 │  │  │
                    │  │  │ Mayor    │  │  │
                    │  │  │ Refinery │  │  │
                    │  │  └──────────┘  │  │
                    │  └────────────────┘  │
                    └──────────────────────┘
```

---

## Phase 1: Single Rig, Single Polecat (Weeks 1–8)

The goal is to validate the core loop: a user creates a rig, assigns work, a polecat works on it via tool calls, completes it, and the work is merged.

### PR 1: Database Schema — Gastown Tables ✅ COMPLETED

**Goal:** Core Postgres tables for the dashboard and ledger. DO SQLite is the authoritative state; Postgres is the read replica synced on writes.

#### Schema (in `src/db/schema.ts`)

```typescript
// -- Towns --
export const gastown_towns = pgTable(
  'gastown_towns',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    name: text().notNull(),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    config: jsonb().$type<GasTownConfig>().default({}),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  t => [
    check(
      'gastown_towns_owner_check',
      sql`(
    (${t.owned_by_user_id} IS NOT NULL AND ${t.owned_by_organization_id} IS NULL) OR
    (${t.owned_by_user_id} IS NULL AND ${t.owned_by_organization_id} IS NOT NULL)
  )`
    ),
    uniqueIndex('UQ_gastown_towns_user_name')
      .on(t.owned_by_user_id, t.name)
      .where(sql`${t.owned_by_user_id} IS NOT NULL`),
    uniqueIndex('UQ_gastown_towns_org_name')
      .on(t.owned_by_organization_id, t.name)
      .where(sql`${t.owned_by_organization_id} IS NOT NULL`),
  ]
);

// -- Rigs --
export const gastown_rigs = pgTable(
  'gastown_rigs',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    town_id: uuid()
      .notNull()
      .references(() => gastown_towns.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    git_url: text().notNull(),
    default_branch: text().default('main').notNull(),
    config: jsonb().$type<RigConfig>().default({}),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  t => [uniqueIndex('UQ_gastown_rigs_town_name').on(t.town_id, t.name)]
);

// -- Agents --
export const gastown_agents = pgTable(
  'gastown_agents',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    rig_id: uuid()
      .notNull()
      .references(() => gastown_rigs.id, { onDelete: 'cascade' }),
    role: text().notNull().$type<'mayor' | 'polecat' | 'witness' | 'refinery'>(),
    name: text().notNull(), // e.g., "Toast", "Maple"
    identity: text().notNull(), // full identity string: "rig/role/name"
    container_process_id: text(), // process ID within the town container (null if no active process)
    status: text().notNull().$type<'idle' | 'working' | 'stalled' | 'dead'>().default('idle'),
    current_hook_bead_id: uuid(), // FK added after gastown_beads defined
    last_activity_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  t => [
    uniqueIndex('UQ_gastown_agents_rig_identity').on(t.rig_id, t.identity),
    index('IDX_gastown_agents_rig_role').on(t.rig_id, t.role),
    index('IDX_gastown_agents_process').on(t.container_process_id),
  ]
);

// -- Beads --
export const gastown_beads = pgTable(
  'gastown_beads',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    rig_id: uuid()
      .notNull()
      .references(() => gastown_rigs.id, { onDelete: 'cascade' }),
    type: text().notNull().$type<'issue' | 'message' | 'escalation' | 'merge_request' | 'agent'>(),
    status: text()
      .notNull()
      .$type<'open' | 'in_progress' | 'closed' | 'cancelled'>()
      .default('open'),
    title: text().notNull(),
    body: text(),
    assignee_agent_id: uuid().references(() => gastown_agents.id),
    convoy_id: uuid(), // FK added after gastown_convoys defined
    molecule_id: uuid(),
    priority: text().$type<'low' | 'medium' | 'high' | 'critical'>().default('medium'),
    labels: jsonb().$type<string[]>().default([]),
    metadata: jsonb().$type<Record<string, unknown>>().default({}),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    closed_at: timestamp({ withTimezone: true, mode: 'string' }),
  },
  t => [
    index('IDX_gastown_beads_rig_status').on(t.rig_id, t.status),
    index('IDX_gastown_beads_assignee').on(t.assignee_agent_id),
    index('IDX_gastown_beads_convoy').on(t.convoy_id),
  ]
);

// -- Convoys --
export const gastown_convoys = pgTable(
  'gastown_convoys',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    town_id: uuid()
      .notNull()
      .references(() => gastown_towns.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    status: text().notNull().$type<'active' | 'landed' | 'cancelled'>().default('active'),
    total_beads: integer().default(0).notNull(),
    closed_beads: integer().default(0).notNull(),
    created_by_agent_id: uuid().references(() => gastown_agents.id),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    landed_at: timestamp({ withTimezone: true, mode: 'string' }),
  },
  t => [index('IDX_gastown_convoys_town_status').on(t.town_id, t.status)]
);

// -- Mail --
export const gastown_mail = pgTable(
  'gastown_mail',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    rig_id: uuid()
      .notNull()
      .references(() => gastown_rigs.id, { onDelete: 'cascade' }),
    from_agent_id: uuid()
      .notNull()
      .references(() => gastown_agents.id),
    to_agent_id: uuid()
      .notNull()
      .references(() => gastown_agents.id),
    subject: text().notNull(), // typed: POLECAT_DONE, MERGE_READY, HELP, etc.
    body: text().notNull(),
    delivered: boolean().default(false).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    delivered_at: timestamp({ withTimezone: true, mode: 'string' }),
  },
  t => [
    index('IDX_gastown_mail_to_undelivered')
      .on(t.to_agent_id, t.delivered)
      .where(sql`${t.delivered} = false`),
  ]
);

// -- Bead Events (append-only ledger) --
export const gastown_bead_events = pgTable(
  'gastown_bead_events',
  {
    id: uuid()
      .default(sql`gen_random_uuid()`)
      .primaryKey()
      .notNull(),
    bead_id: uuid()
      .notNull()
      .references(() => gastown_beads.id, { onDelete: 'cascade' }),
    agent_id: uuid().references(() => gastown_agents.id),
    event_type: text()
      .notNull()
      .$type<
        'created' | 'assigned' | 'hooked' | 'unhooked' | 'status_changed' | 'closed' | 'escalated'
      >(),
    old_value: text(),
    new_value: text(),
    metadata: jsonb().$type<Record<string, unknown>>().default({}),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  t => [
    index('IDX_gastown_bead_events_bead').on(t.bead_id),
    index('IDX_gastown_bead_events_agent').on(t.agent_id),
  ]
);
```

#### Migration Strategy

1. Generate migration with `pnpm drizzle-kit generate`
2. Test with `pnpm drizzle-kit push` against dev DB
3. No compatibility views needed (new tables, no renaming)

---

### PR 2: Gastown Worker — Rig Durable Object ✅ COMPLETED

**Goal:** The Rig DO — the core state machine that holds beads, agents, mail, and the review queue for a single rig.

#### Worker: `cloud/cloudflare-gastown/`

```
cloud/cloudflare-gastown/
├── src/
│   ├── gastown.worker.ts      # Hono router, DO exports
│   ├── types.ts               # Shared types & Zod enums
│   ├── dos/
│   │   ├── Rig.do.ts          # Rig Durable Object (core state machine)
│   │   ├── Town.do.ts         # Town Durable Object (stub)
│   │   └── AgentIdentity.do.ts # Agent Identity DO (stub)
│   ├── db/tables/
│   │   ├── beads.table.ts
│   │   ├── agents.table.ts
│   │   ├── mail.table.ts
│   │   ├── review-queue.table.ts
│   │   └── molecules.table.ts
│   ├── handlers/
│   │   ├── rig-beads.handler.ts
│   │   ├── rig-agents.handler.ts
│   │   ├── rig-mail.handler.ts
│   │   ├── rig-review-queue.handler.ts
│   │   └── rig-escalations.handler.ts
│   ├── middleware/
│   │   └── auth.middleware.ts
│   └── util/
│       ├── query.util.ts       # Type-safe SQL query helper
│       ├── table.ts            # Zod→SQLite table interpolator
│       ├── res.util.ts         # Response envelope
│       ├── jwt.util.ts         # HS256 JWT sign/verify
│       └── parse-json-body.util.ts
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

#### Rig DO SQLite Schema (5 tables)

```sql
-- Beads (authoritative state)
CREATE TABLE beads (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'issue', 'message', 'escalation', 'merge_request'
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  body TEXT,
  assignee_agent_id TEXT,
  convoy_id TEXT,
  molecule_id TEXT,
  priority TEXT DEFAULT 'medium',
  labels TEXT DEFAULT '[]',     -- JSON array
  metadata TEXT DEFAULT '{}',   -- JSON object
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

-- Agents registered in this rig
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  identity TEXT NOT NULL UNIQUE,
  cloud_agent_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  current_hook_bead_id TEXT REFERENCES beads(id),
  last_activity_at TEXT,
  checkpoint TEXT,               -- JSON: crash-recovery data
  created_at TEXT NOT NULL
);

-- Mail queue
CREATE TABLE mail (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id TEXT NOT NULL REFERENCES agents(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX idx_mail_undelivered ON mail(to_agent_id) WHERE delivered = 0;

-- Review queue (renamed from merge_queue to match implementation)
CREATE TABLE review_queue (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  bead_id TEXT NOT NULL REFERENCES beads(id),
  branch TEXT NOT NULL,
  pr_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'running', 'merged', 'failed'
  summary TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

-- Molecules (multi-step workflows) — schema defined, methods deferred
CREATE TABLE molecules (
  id TEXT PRIMARY KEY,
  bead_id TEXT NOT NULL REFERENCES beads(id),
  formula TEXT NOT NULL,         -- JSON: step definitions
  current_step INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### Rig DO RPC Methods (implemented)

```typescript
class RigDO extends DurableObject<Env> {
  // -- Beads --
  async createBead(input: CreateBeadInput): Promise<Bead>;
  async getBeadAsync(beadId: string): Promise<Bead | null>;
  async listBeads(filter: BeadFilter): Promise<Bead[]>;
  async updateBeadStatus(beadId: string, status: string, agentId: string): Promise<Bead>;
  async closeBead(beadId: string, agentId: string): Promise<Bead>;

  // -- Agents --
  async registerAgent(input: RegisterAgentInput): Promise<Agent>;
  async getAgentAsync(agentId: string): Promise<Agent | null>;
  async getAgentByIdentity(identity: string): Promise<Agent | null>;
  async listAgents(filter?: AgentFilter): Promise<Agent[]>;
  async updateAgentSession(agentId: string, sessionId: string | null): Promise<void>;
  async updateAgentStatus(agentId: string, status: string): Promise<void>;

  // -- Hooks (GUPP) --
  async hookBead(agentId: string, beadId: string): Promise<void>;
  async unhookBead(agentId: string): Promise<void>;
  async getHookedBead(agentId: string): Promise<Bead | null>;

  // -- Mail --
  async sendMail(input: SendMailInput): Promise<void>;
  async checkMail(agentId: string): Promise<Mail[]>; // marks as delivered

  // -- Review Queue --
  async submitToReviewQueue(input: ReviewQueueInput): Promise<void>;
  async popReviewQueue(): Promise<ReviewQueueEntry | null>;
  async completeReview(entryId: string, status: 'merged' | 'failed'): Promise<void>;

  // -- Prime (context assembly) --
  async prime(agentId: string): Promise<PrimeContext>;

  // -- Checkpoint --
  async writeCheckpoint(agentId: string, data: unknown): Promise<void>;
  async readCheckpoint(agentId: string): Promise<unknown | null>;

  // -- Done --
  async agentDone(agentId: string, input: AgentDoneInput): Promise<void>;

  // -- Health --
  async witnessPatrol(): Promise<PatrolResult>;
}
```

---

### PR 3: Gastown Worker — HTTP API Layer ✅ COMPLETED

**Goal:** Hono router exposing the Rig DO's methods as HTTP endpoints, consumed by both the tool plugin and the Next.js backend.

#### Routes

```
GET    /health                                       → health check

POST   /api/rigs/:rigId/beads                        → createBead
GET    /api/rigs/:rigId/beads                        → listBeads
GET    /api/rigs/:rigId/beads/:beadId                → getBead
PATCH  /api/rigs/:rigId/beads/:beadId/status         → updateBeadStatus
POST   /api/rigs/:rigId/beads/:beadId/close          → closeBead

POST   /api/rigs/:rigId/agents                       → registerAgent
GET    /api/rigs/:rigId/agents                       → listAgents
GET    /api/rigs/:rigId/agents/:agentId              → getAgent

POST   /api/rigs/:rigId/agents/:agentId/hook         → hookBead
DELETE /api/rigs/:rigId/agents/:agentId/hook          → unhookBead
GET    /api/rigs/:rigId/agents/:agentId/prime         → prime
POST   /api/rigs/:rigId/agents/:agentId/done          → agentDone
POST   /api/rigs/:rigId/agents/:agentId/checkpoint    → writeCheckpoint

POST   /api/rigs/:rigId/mail                          → sendMail
GET    /api/rigs/:rigId/agents/:agentId/mail           → checkMail

POST   /api/rigs/:rigId/review-queue                  → submitToReviewQueue
POST   /api/rigs/:rigId/escalations                   → createEscalation
```

#### Auth

Two auth modes:

- **Internal** (`X-Internal-API-Key`): Next.js backend → worker
- **Agent** (`Authorization: Bearer <session-token>`): tool plugin → worker. Token is a short-lived JWT (HS256, 24h max age) containing `{ agentId, rigId, townId, userId }`, minted when starting an agent process.

Agent-only middleware on `/api/rigs/:rigId/agents/:agentId/*` validates JWT `agentId` matches the route param. Internal auth bypasses this check.

---

### PR 4: Gastown Tool Plugin

**Status:** Partially implemented. The plugin exists at `cloud/cloudflare-gastown/plugin/` with 7 tools and event hooks. Minor updates needed for the container execution model.

**Goal:** The opencode plugin that exposes gastown tools to agents. This is the heart of the system — it's what agents actually interact with.

#### Location

```
cloud/cloudflare-gastown/plugin/
├── src/
│   ├── index.ts         # Plugin entry point (prime injection, event hooks)
│   ├── tools.ts         # Tool definitions
│   ├── client.ts        # GastownClient — HTTP client for Rig DO API
│   └── types.ts         # Client-side type mirrors
├── package.json
└── tsconfig.json
```

#### Tools (Phase 1 — minimum viable set)

| Tool             | Description                                                              | Rig DO Method                    |
| ---------------- | ------------------------------------------------------------------------ | -------------------------------- |
| `gt_prime`       | Get full role context: identity, hooked work, instructions, pending mail | `prime(agentId)`                 |
| `gt_bead_status` | Read the status of a bead                                                | `getBeadAsync(beadId)`           |
| `gt_bead_close`  | Close current bead or molecule step                                      | `closeBead(beadId)`              |
| `gt_done`        | Signal work complete — push branch, submit to review queue               | `agentDone(agentId, ...)`        |
| `gt_mail_send`   | Send a typed message to another agent                                    | `sendMail(...)`                  |
| `gt_mail_check`  | Read and acknowledge pending mail                                        | `checkMail(agentId)`             |
| `gt_escalate`    | Escalate an issue with severity and category                             | `createBead(type: 'escalation')` |
| `gt_checkpoint`  | Write crash-recovery data                                                | `writeCheckpoint(agentId, ...)`  |

#### Plugin Event Hooks

| Event               | Action                                                               |
| ------------------- | -------------------------------------------------------------------- |
| `session.created`   | Auto-call `gt_prime` and inject result into session context          |
| `session.compacted` | Re-call `gt_prime` to restore context after compaction               |
| `session.deleted`   | Notify Rig DO that the session has ended (for cleanup/cost tracking) |

#### Changes from original proposal

The plugin is unchanged in its tool definitions and event hooks. The difference is in how it reaches the DO — the `GASTOWN_API_URL` now points to the gastown worker from within the container's network, and the JWT is minted by the control server inside the container (or passed as an env var when starting the Kilo CLI process).

#### Environment Variables (set by the container's control server when spawning a Kilo CLI process)

| Var                     | Value                                               |
| ----------------------- | --------------------------------------------------- |
| `GASTOWN_API_URL`       | Worker URL: `https://gastown.<account>.workers.dev` |
| `GASTOWN_SESSION_TOKEN` | Short-lived JWT for this agent session              |
| `GASTOWN_AGENT_ID`      | This agent's UUID                                   |
| `GASTOWN_RIG_ID`        | This rig's UUID                                     |
| `KILO_API_URL`          | Kilo gateway URL (for LLM calls)                    |

---

### PR 5: Town Container — Execution Runtime

**Goal:** A Cloudflare Container per town that runs all agent processes. The container receives commands from the DO (via `fetch()`) and spawns/manages Kilo CLI processes inside a shared environment.

This replaces the cloud-agent-next session integration from the original proposal. Instead of one container per agent, all agents in a town share a single container.

#### Container Architecture

```
cloud/cloudflare-gastown/
├── container/
│   ├── Dockerfile              # Based on cloudflare/sandbox or custom Node image
│   ├── src/
│   │   ├── control-server.ts   # HTTP server receiving commands from DO
│   │   ├── process-manager.ts  # Spawns and supervises Kilo CLI processes
│   │   ├── agent-runner.ts     # Configures and starts a single agent process
│   │   ├── git-manager.ts      # Git clone, worktree, branch management
│   │   ├── heartbeat.ts        # Reports agent health back to DO
│   │   └── types.ts
│   └── package.json
├── src/
│   ├── dos/
│   │   ├── TownContainer.do.ts # Container class extending @cloudflare/containers
│   │   └── ...existing DOs
│   └── ...existing worker code
```

#### Container Image

The Dockerfile installs:

- Node.js / Bun runtime
- `@kilocode/cli` (Kilo CLI)
- `git`
- `gh` CLI (GitHub)
- The gastown tool plugin (pre-installed, referenced via opencode config)

No `gt` or `bd` binaries. No Go code. The container is a pure JavaScript/TypeScript runtime for Kilo CLI processes.

#### TownContainer DO (extends Container)

```typescript
import { Container } from '@cloudflare/containers';

export class TownContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '30m'; // Keep alive while town is active

  override onStart() {
    console.log(`Town container started for ${this.ctx.id}`);
  }

  override onStop() {
    console.log(`Town container stopped for ${this.ctx.id}`);
  }

  override onError(error: unknown) {
    console.error('Town container error:', error);
  }
}
```

#### Control Server (runs inside the container)

An HTTP server on port 8080 that accepts commands from the gastown worker (via `env.TOWN_CONTAINER.get(townId).fetch()`):

```typescript
// container/src/control-server.ts

// POST /agents/start — Start a Kilo CLI process for an agent
interface StartAgentRequest {
  agentId: string;
  rigId: string;
  townId: string;
  role: 'mayor' | 'polecat' | 'refinery';
  name: string;
  identity: string;
  prompt: string; // Initial prompt for the agent
  model: string; // LLM model to use
  systemPrompt: string; // Role-specific system prompt
  gitUrl: string; // Repository to clone/use
  branch: string; // Branch to work on (e.g., "polecat/toast/abc123")
  defaultBranch: string; // e.g., "main"
  envVars: Record<string, string>; // GASTOWN_API_URL, JWT, etc.
}

// POST /agents/:agentId/stop — Stop an agent process
// POST /agents/:agentId/message — Send a follow-up prompt to an agent
// GET  /agents/:agentId/status — Check if agent process is alive
// GET  /health — Container health check
// POST /agents/:agentId/stream-ticket — Get a WebSocket stream ticket for an agent
```

#### Process Manager

```typescript
// container/src/process-manager.ts

class ProcessManager {
  private processes: Map<string, AgentProcess> = new Map();

  async startAgent(config: StartAgentRequest): Promise<{ processId: string }> {
    // 1. Ensure git repo is cloned (shared clone per rig, worktree per agent)
    await this.gitManager.ensureWorktree(config.rigId, config.gitUrl, config.branch);

    // 2. Write opencode config with gastown plugin enabled
    const workdir = this.gitManager.getWorktreePath(config.rigId, config.branch);
    await this.writeAgentConfig(workdir, config);

    // 3. Spawn Kilo CLI process
    const proc = spawn('kilo', ['--prompt', config.prompt], {
      cwd: workdir,
      env: {
        ...process.env,
        ...config.envVars,
        KILO_API_URL: config.envVars.KILO_API_URL,
        GASTOWN_API_URL: config.envVars.GASTOWN_API_URL,
        GASTOWN_SESSION_TOKEN: config.envVars.GASTOWN_SESSION_TOKEN,
        GASTOWN_AGENT_ID: config.agentId,
        GASTOWN_RIG_ID: config.rigId,
      },
    });

    // 4. Track process, wire up heartbeat reporting
    const agentProcess = new AgentProcess(config.agentId, proc);
    this.processes.set(config.agentId, agentProcess);

    // 5. Start heartbeat — periodically call DO to update last_activity_at
    agentProcess.startHeartbeat(
      config.envVars.GASTOWN_API_URL,
      config.envVars.GASTOWN_SESSION_TOKEN
    );

    return { processId: agentProcess.id };
  }

  async stopAgent(agentId: string): Promise<void> {
    const proc = this.processes.get(agentId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(agentId);
    }
  }

  getStatus(agentId: string): 'running' | 'exited' | 'not_found' {
    const proc = this.processes.get(agentId);
    if (!proc) return 'not_found';
    return proc.isAlive() ? 'running' : 'exited';
  }
}
```

#### Git Management (shared repos, agent worktrees)

```typescript
// container/src/git-manager.ts

class GitManager {
  private rigClones: Map<string, string> = new Map(); // rigId → clone path

  // Clone the rig's repo once (shared), create worktrees per agent
  async ensureWorktree(rigId: string, gitUrl: string, branch: string): Promise<string> {
    // 1. Clone if not already cloned
    if (!this.rigClones.has(rigId)) {
      const clonePath = `/workspace/rigs/${rigId}/repo`;
      await exec(`git clone ${gitUrl} ${clonePath}`);
      this.rigClones.set(rigId, clonePath);
    }

    // 2. Create worktree for this branch
    const clonePath = this.rigClones.get(rigId)!;
    const worktreePath = `/workspace/rigs/${rigId}/worktrees/${branch}`;
    await exec(`git -C ${clonePath} worktree add ${worktreePath} -b ${branch}`);

    return worktreePath;
  }
}
```

This means multiple polecats in the same rig share the same git clone but get isolated worktrees — each polecat works on its own branch (`polecat/<name>/<bead-id-prefix>`) without interfering with others. This is the same worktree model used by local gastown.

#### Wrangler Config Updates

```jsonc
// cloud/cloudflare-gastown/wrangler.jsonc
{
  "name": "gastown",
  "main": "src/gastown.worker.ts",
  "compatibility_date": "2025-01-01",
  "observability": { "enabled": true },
  "placement": { "mode": "smart" },
  "containers": [
    {
      "class_name": "TownContainer",
      "image": "./container/Dockerfile",
      "instance_type": "standard-4", // 4 vCPU, 12 GiB, 20 GB disk
      "max_instances": 50,
    },
  ],
  "durable_objects": {
    "bindings": [
      { "name": "RIG", "class_name": "RigDO" },
      { "name": "TOWN", "class_name": "TownDO" },
      { "name": "AGENT_IDENTITY", "class_name": "AgentIdentityDO" },
      { "name": "TOWN_CONTAINER", "class_name": "TownContainer" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RigDO", "TownDO", "AgentIdentityDO"] },
    { "tag": "v2", "new_sqlite_classes": ["TownContainer"] },
  ],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<hyperdrive-id>" }],
}
```

#### DO → Container Communication Flow

When the Rig DO needs to start an agent (e.g., alarm detects a pending bead):

```typescript
// In Rig DO alarm handler or in the Hono route handler
async function dispatchAgentToContainer(env: Env, townId: string, agentConfig: StartAgentRequest) {
  const container = env.TOWN_CONTAINER.get(env.TOWN_CONTAINER.idFromName(townId));

  const response = await container.fetch('http://container/agents/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agentConfig),
  });

  if (!response.ok) {
    throw new Error(`Failed to start agent: ${await response.text()}`);
  }

  return response.json();
}
```

---

### PR 6: Rig DO Alarm — Work Scheduler

**Goal:** The Rig DO becomes the scheduler. Alarms periodically scan state and signal the container to start/stop agent processes.

This is new — the original proposal had no alarm handler. The DO now actively drives the system rather than passively serving requests.

#### Alarm Handler

```typescript
// In Rig.do.ts
async alarm(): Promise<void> {
  await this.schedulePendingWork();
  await this.witnessPatrol();
  await this.processReviewQueue();

  // Re-arm alarm (every 30 seconds while there's active work, 5 min when idle)
  const hasActiveWork = this.hasActiveAgentsOrPendingBeads();
  const nextAlarm = hasActiveWork ? 30_000 : 300_000;
  this.ctx.storage.setAlarm(Date.now() + nextAlarm);
}
```

#### `schedulePendingWork()` — Dispatch beads to agents

```typescript
async schedulePendingWork(): Promise<void> {
  // Find beads that are assigned to an agent but the agent is idle (not yet started)
  const pendingAgents = this.ctx.storage.sql.exec(
    `SELECT a.*, b.id as bead_id, b.title as bead_title
     FROM agents a
     JOIN beads b ON b.assignee_agent_id = a.id
     WHERE a.status = 'idle'
     AND b.status = 'in_progress'
     AND a.current_hook_bead_id IS NOT NULL`
  ).toArray();

  for (const agent of pendingAgents) {
    // Signal container to start this agent
    await this.startAgentInContainer(agent);
  }
}
```

#### `witnessPatrol()` — Health monitoring (already implemented, now called by alarm)

```typescript
async witnessPatrol(): Promise<void> {
  const workingAgents = this.ctx.storage.sql.exec(
    `SELECT * FROM agents WHERE status IN ('working', 'blocked')`
  ).toArray();

  for (const agent of workingAgents) {
    // 1. Check if agent process is alive in the container
    const container = this.env.TOWN_CONTAINER.get(
      this.env.TOWN_CONTAINER.idFromName(this.townId)
    );
    const statusRes = await container.fetch(
      `http://container/agents/${agent.id}/status`
    );
    const { status } = await statusRes.json();

    if (status === 'not_found' || status === 'exited') {
      if (agent.current_hook_bead_id) {
        // Dead process with hooked work → restart
        await this.restartAgent(agent);
      } else {
        // Dead process, no hooked work → mark idle
        this.updateAgentStatus(agent.id, 'idle');
      }
      continue;
    }

    // 2. GUPP violation check (30 min no progress)
    if (agent.last_activity_at) {
      const staleMs = Date.now() - new Date(agent.last_activity_at).getTime();
      if (staleMs > 30 * 60 * 1000) {
        await this.sendMail({
          from_agent_id: 'witness',
          to_agent_id: agent.id,
          subject: 'GUPP_CHECK',
          body: 'You have had work hooked for 30+ minutes with no activity. Are you stuck? If so, call gt_escalate.',
        });
      }
    }
  }
}
```

#### `processReviewQueue()` — Trigger refinery agent

```typescript
async processReviewQueue(): Promise<void> {
  const pendingEntry = this.popReviewQueue();
  if (!pendingEntry) return;

  // Start a refinery agent in the container to handle the review
  await this.startAgentInContainer({
    role: 'refinery',
    beadId: pendingEntry.bead_id,
    branch: pendingEntry.branch,
    // ... refinery-specific config
  });
}
```

#### Alarm Activation

The alarm is armed when:

- A new bead is created with an assigned agent (in `createBead` or `hookBead`)
- An agent calls `agentDone` (to process the review queue)
- The container reports an agent process has exited
- Manually triggered via a health check endpoint

```typescript
// In hookBead, after assigning work:
private armAlarmIfNeeded() {
  const currentAlarm = this.ctx.storage.getAlarm();
  if (!currentAlarm) {
    this.ctx.storage.setAlarm(Date.now() + 5_000); // Fire in 5 seconds
  }
}
```

---

### PR 7: tRPC Routes — Town & Rig Management

**Goal:** Dashboard API for creating and managing towns and rigs. The `sling` mutation now creates the bead and assigns the agent, then arms the Rig DO alarm — the alarm handles dispatching to the container.

#### New Router: `src/server/routers/gastown.ts`

```typescript
export const gastownRouter = router({
  // -- Towns --
  createTown: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      /* insert into gastown_towns */
    }),

  listTowns: protectedProcedure.query(async ({ ctx }) => {
    /* select from gastown_towns where owner = ctx.user */
  }),

  getTown: protectedProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      /* select with rigs, active convoys */
    }),

  // -- Rigs --
  createRig: protectedProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        name: z.string().min(1).max(64),
        gitUrl: z.string().url(),
        defaultBranch: z.string().default('main'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      /* insert into gastown_rigs, initialize Rig DO */
    }),

  getRig: protectedProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      /* select with agents, active beads */
    }),

  // -- Beads (read from Postgres ledger) --
  listBeads: protectedProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        status: z.enum(['open', 'in_progress', 'closed', 'cancelled']).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      /* select from gastown_beads */
    }),

  // -- Agents --
  listAgents: protectedProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      /* select from gastown_agents */
    }),

  // -- Work Assignment --
  sling: protectedProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        title: z.string(),
        body: z.string().optional(),
        model: z.string().default('kilo/auto'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Create bead in Rig DO (via internal auth HTTP call)
      // 2. Register or pick an agent (Rig DO allocates name)
      // 3. Hook bead to agent (Rig DO updates state)
      // 4. Arm Rig DO alarm → alarm will dispatch agent to container
      // 5. Return agent info (no stream URL yet — that comes from container)
    }),

  // -- Send message to Mayor --
  sendMessage: protectedProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        message: z.string(),
        model: z.string().default('kilo/auto'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Create a message bead assigned to the Mayor agent
      // 2. Arm alarm → dispatches to container
    }),

  // -- Agent Streams --
  getAgentStreamUrl: protectedProcedure
    .input(z.object({ agentId: z.string().uuid(), townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Fetch stream ticket from container via TownContainer.fetch()
      // Return WebSocket URL for the dashboard to connect to
    }),
});
```

**Key difference from original:** The `sling` mutation no longer creates a cloud-agent-next session. It creates state in the DO and arms the alarm. The alarm handles dispatching to the container. This decouples the API response time from container cold starts.

---

### PR 8: Basic Dashboard UI

**Goal:** Minimal UI to create a rig, sling work, and watch an agent work.

This is a thin first pass. Follow existing dashboard patterns.

#### Pages

| Route                            | Component     | Purpose                              |
| -------------------------------- | ------------- | ------------------------------------ |
| `/gastown`                       | Town list     | List user's towns, create new        |
| `/gastown/[townId]`              | Town overview | List rigs, active convoys            |
| `/gastown/[townId]/rigs/[rigId]` | Rig detail    | Bead board, agent list, agent stream |

#### Key Components

- **Bead board**: Simple list/kanban of beads by status (open → in_progress → closed). Read from Postgres via tRPC.
- **Agent card**: Shows agent identity, status, current hook. Links to conversation stream.
- **Agent stream**: WebSocket connection to the container's stream endpoint (via `getAgentStreamUrl` tRPC query). The container proxies Kilo CLI output events.
- **Sling dialog**: Form to create a bead and assign it. Inputs: title, body, model selector.
- **Mayor chat**: Direct message input that sends to the Mayor agent. Uses `sendMessage` tRPC mutation.

---

### PR 9: Manual Merge Flow

**Goal:** When a polecat calls `gt_done`, process the review queue entry. Phase 1 uses a simple merge — no AI-powered refinery.

#### Implementation

When `agentDone()` is called on the Rig DO:

1. Unhook bead from agent
2. Close bead, record in bead events
3. Insert into review queue with branch name
4. Mark agent as `idle`, stop the container process
5. Arm alarm to process review queue

Review processing (alarm handler calls `processReviewQueue()`):

1. Pop next entry from review queue
2. Signal container to run a git merge operation (not an AI agent — just a deterministic merge):
   - `POST /git/merge` → container checks out branch, attempts `git merge --no-ff` into default branch
3. If merge succeeds → update entry status to `merged`, push to remote
4. If merge fails (conflict) → update entry status to `failed`, create escalation bead
5. Sync results to Postgres

Phase 1 does not use an AI refinery — the merge is mechanical. Phase 2 adds an AI refinery agent for quality gates and conflict resolution.

---

## Phase 2: Multi-Agent Orchestration (Weeks 9–14)

### PR 10: Town Durable Object

**Goal:** The Town DO manages cross-rig coordination: convoy lifecycle, escalation routing, and the watchdog heartbeat.

#### Town DO State (SQLite)

```sql
CREATE TABLE rigs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  rig_do_id TEXT NOT NULL         -- Rig DO's durable object ID
);

CREATE TABLE convoys (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  total_beads INTEGER NOT NULL DEFAULT 0,
  closed_beads INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  landed_at TEXT
);

CREATE TABLE convoy_beads (
  convoy_id TEXT NOT NULL REFERENCES convoys(id),
  bead_id TEXT NOT NULL,
  rig_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  PRIMARY KEY (convoy_id, bead_id)
);

CREATE TABLE escalations (
  id TEXT PRIMARY KEY,
  source_rig_id TEXT NOT NULL,
  source_agent_id TEXT,
  severity TEXT NOT NULL,          -- 'low', 'medium', 'high', 'critical'
  category TEXT,
  message TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  re_escalation_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);
```

#### Key Methods

- `createConvoy(title, beads[])` — create convoy, distribute beads to rig DOs
- `onBeadClosed(convoyId, beadId)` — increment closed count, check if convoy has landed
- `routeEscalation(input)` — route by severity: low → log, medium → mail Mayor, high → webhook/email
- `watchdogHeartbeat()` — DO alarm (3 min): check each Rig DO health, verify container is alive

---

### PR 11: Multiple Polecats per Rig

**Goal:** Support N concurrent polecats working on different beads in the same rig.

Changes:

- `sling` tRPC mutation supports creating multiple beads + agents
- Rig DO manages agent name allocation (sequential names: Toast, Maple, Birch, etc.)
- Each polecat gets its own git worktree and branch: `polecat/<name>/<bead-id-prefix>`
- All polecats run as separate Kilo CLI processes inside the same town container
- Dashboard shows all active agents with their streams

The shared container model makes this natural — adding a polecat is just spawning another process, not provisioning another container. The git worktree model provides filesystem isolation between polecats.

---

### PR 12: Mayor Agent

**Goal:** The Mayor is an agent process inside the town container that coordinates work across rigs.

The Mayor:

- Receives work requests from the user (via dashboard `sendMessage` → message bead → alarm → container)
- Breaks down work into beads, creates convoys (via `gt_sling`, `gt_convoy_create` tools)
- Handles escalations routed to it (via mail)
- Has cross-rig visibility via Town DO tools

#### New Tools for Mayor Role

| Tool               | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `gt_sling`         | Create bead and assign to a polecat in a rig               |
| `gt_convoy_create` | Create a convoy with multiple beads                        |
| `gt_convoy_status` | Check convoy progress                                      |
| `gt_rig_status`    | Get summary of a rig's state (agents, beads, review queue) |

#### Mayor Lifecycle

The Mayor is **demand-spawned** — the Town DO alarm starts a Mayor process in the container when:

- A user sends a message (message bead created)
- An escalation is routed to the Mayor (mail delivered)
- A convoy needs coordination

The Mayor process runs until its work is complete, then calls `gt_done` and exits. There is no persistent Mayor session — the DO state provides continuity between Mayor invocations. The Mayor's `gt_prime` context includes full town state so it can resume from where it left off.

This avoids the "Mayor session persistence" problem from the original proposal entirely. The DO is the persistent memory; the Mayor agent is an ephemeral reasoning process.

---

### PR 13: Refinery Agent

**Goal:** Automated merge with quality gates, powered by an AI agent.

When a review queue entry is ready:

1. Rig DO alarm fires, calls `processReviewQueue()`
2. Signal container to start a refinery agent process:
   - The refinery agent gets a worktree with the polecat's branch
   - Runs quality gates (configurable: `npm test`, `npm run build`, lint, etc.)
   - If passing → merge to default branch, update review queue entry
   - If failing → create `REWORK_REQUEST` mail to the polecat, set entry to `failed`
3. Refinery process exits after the review completes

Quality gate configuration stored in rig config:

```json
{
  "refinery": {
    "gates": ["npm test", "npm run build"],
    "auto_merge": true,
    "require_clean_merge": true
  }
}
```

The refinery agent can reason about test failures — if tests fail, it can examine the output and send a specific rework request to the polecat explaining what needs to change. This is the key advantage over a non-AI merge gate.

---

### PR 14: Molecule/Formula System

**Goal:** Multi-step workflows so polecats can self-navigate through complex tasks.

#### Molecule Lifecycle

1. Work bead is created with a formula (JSON step definitions)
2. On sling, the Rig DO creates a molecule record with `current_step = 0`
3. `gt_mol_current` returns the current step
4. `gt_mol_advance` closes current step, increments to next
5. When all steps are closed, the molecule is complete → triggers `gt_done` equivalent

#### New Tools (added to plugin)

| Tool             | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `gt_mol_current` | Get current molecule step (title, instructions, step N of M) |
| `gt_mol_advance` | Complete current step with summary, advance to next          |

---

### PR 15: Convoy Lifecycle

**Goal:** Convoys track batched work across rigs with landing notifications.

#### Flow

1. Mayor (or dashboard) creates convoy via Town DO: `createConvoy(title, beadSpecs[])`
2. Town DO distributes beads to Rig DOs, recording `convoy_id` on each
3. When a bead closes, Rig DO notifies Town DO: `onBeadClosed(convoyId, beadId)`
4. Town DO increments `closed_beads`, checks if `closed_beads == total_beads`
5. If landed → update status, fire webhook/notification, write to Postgres

---

### PR 16: Escalation System

**Goal:** Severity-routed escalation with auto-re-escalation.

#### Severity Routing

| Severity   | Action                                    |
| ---------- | ----------------------------------------- |
| `low`      | Record in bead events only                |
| `medium`   | + send mail to Mayor agent                |
| `high`     | + webhook to user (email/Slack)           |
| `critical` | + mark convoy as blocked, alert dashboard |

#### Auto-Re-Escalation

Town DO alarm checks unacknowledged escalations every heartbeat (3 min). If unacknowledged for configurable threshold (default 4 hours), bump severity and re-route.

---

## Phase 3: Multi-Rig + Scaling (Weeks 15–20)

### PR 17: Multi-Rig Support

**Goal:** A Town with multiple rigs, cross-rig mail routing, and the dashboard reflecting all rigs.

- Town DO maintains rig registry, routes cross-rig mail via Rig DO RPCs
- Dashboard shows all rigs in a town with drill-down
- Convoys can span multiple rigs
- All rigs in a town share the same container — each rig's agents get their own worktrees

---

### PR 18: Agent CVs & Performance Analytics

**Goal:** Build the structured work ledger for agent performance tracking.

#### Agent Identity DO

Each agent gets a persistent DO that accumulates:

- Bead closures (type, time, quality signal from refinery)
- Molecule step completions
- Convoy participations
- Escalation history
- Session count/duration
- Model used per session

#### Dashboard Views

- Agent performance cards (beads closed, avg time, quality rate)
- Model comparison (same work type, different models → which performs better)
- Cost per bead (LLM usage from gateway, attributed to agent)

---

### PR 19: Container Resilience — Checkpoint/Restore

**Goal:** Handle the ephemeral disk problem. When a container sleeps or dies, in-flight state must be recoverable.

#### Strategy

Cloudflare Containers have **ephemeral disk** — when a container sleeps or restarts, all filesystem state is lost. Since all _coordination state_ lives in DOs, the main recovery concern is git state (cloned repos, worktrees, uncommitted changes).

1. **Git state recovery**: On container start, the control server reads Rig DO state to determine which rigs need repos cloned and which agents need worktrees. Repos are re-cloned and worktrees re-created from the remote branches.

2. **Uncommitted work**: Agents should commit frequently (the polecat system prompt instructs this). The `gt_checkpoint` tool writes a JSON checkpoint to the DO. On restart, the agent's `gt_prime` context includes the checkpoint so it can resume.

3. **Container startup sequence**:

   ```
   Container starts → control server boots
   → Reads rig registry from Town DO (which rigs belong to this town)
   → For each rig with active agents:
     → Clone repo (or pull if warm)
     → Create worktrees for active agent branches
   → Report ready to DO
   → DO alarm dispatches pending agents
   ```

4. **Proactive git push**: The polecat system prompt instructs agents to push their branch after meaningful progress, not just at `gt_done`. This ensures remote has latest state for recovery.

5. **R2 snapshot** (optional optimization): Before container sleep, snapshot large repos as git bundles to R2 for faster restore. This is a Phase 4 optimization if cold start times are problematic.

---

### PR 20: Dashboard Polish

- Convoy progress visualization (progress bar, timeline)
- Real-time updates via WebSocket (container streams agent events → dashboard)
- Agent conversation history (stored in DO or R2)
- Cost tracking per town/rig/convoy/agent

---

## Phase 4: Hardening (Weeks 21–24)

### PR 21: Stress Testing

- Simulate 30 concurrent polecats across 5 rigs in a single container
- Measure DO→container latency under load (tool call round-trip)
- Measure container resource usage (CPU, memory) with N concurrent Kilo CLI processes
- Identify container resource limits and determine when to scale to multiple containers
- Identify DO SQLite size limits and implement archival (closed beads → Postgres, purge from DO)
- Test container crash/restart/restore cycles

### PR 22: Edge Case Handling

- Split-brain: two processes for same agent (race on restart) → Rig DO enforces single-writer per agent, container checks DO state before starting
- Concurrent writes to same bead → SQLite serialization in DO handles this, but add optimistic locking for cross-DO operations
- DO eviction during alarm → alarms are durable and will re-fire
- Container OOM → kills all agents. DO alarms detect dead agents, new container starts, agents are re-dispatched from DO state
- Container sleep during active work → agents must have pushed to remote. DO re-dispatches on wake
- Gateway outage → agent retries built into Kilo CLI; escalation if persistent

### PR 23: Observability

- Structured logging in gastown worker (Sentry)
- Container process logs forwarded to Workers Logs
- Bead event stream for real-time dashboard (DO → WebSocket or SSE)
- Alert on: GUPP violations, escalation rate spikes, review queue depth, agent restart loops, container OOM events
- Usage metrics: beads/day, agents/day, LLM cost/bead, container uptime/cost

### PR 24: Onboarding Flow

- "Create your first Town" wizard
- Connect git repo (GitHub App integration — reuse existing)
- Select model
- Sling first bead
- Watch the polecat work

### PR 25: Documentation & API Reference

- Internal: architecture doc, DO state schemas, tool plugin API, container control server API
- External: user guide for hosted gastown

---

## Open Questions

1. **Container sizing**: A `standard-4` (4 vCPU, 12 GiB, 20 GB disk) may not be enough for towns with many concurrent agents. Custom instance types now support up to 4 vCPU max. For large towns, we may need to shard across multiple containers (container-per-rig instead of container-per-town). This should be measured in stress testing (PR 21) before over-engineering.

2. **Agent event streaming**: How do we stream Kilo CLI output from the container to the dashboard? Options:
   - Container exposes a WebSocket per agent, dashboard connects directly
   - Container forwards events to the DO, DO streams to dashboard via WebSocket hibernation API
   - Container writes events to a queue/R2, dashboard polls
   - The first option is simplest for Phase 1. The second gives better durability (events survive container restart).

3. **Git auth in the container**: The container needs to clone private repos. Options:
   - Pass GitHub App installation tokens via env vars (short-lived, minted by the Next.js backend when arming the alarm)
   - Store encrypted tokens in DO, container fetches on startup
   - Use a service binding to the existing GitHub token infrastructure
   - The token refresh problem is real — long-running containers will need tokens refreshed periodically.

4. **Container cold start impact**: When a container sleeps and wakes, all repos need to be re-cloned. For large repos this could take minutes. Mitigations:
   - Aggressive `sleepAfter` (30+ min) so active towns don't sleep
   - Shallow clones (`--depth 1`) for initial clone, fetch full history only when needed
   - R2 git bundle snapshots for fast restore
   - Pre-warm containers when a user navigates to their town dashboard

5. **DO storage limits**: Durable Object SQLite has a 10GB limit. A rig with thousands of beads over months could approach this. Archival strategy: periodically move closed beads to Postgres and purge from DO SQLite. The DO is the hot path; Postgres is the cold archive.

6. **Billing model**: Per-agent-session LLM costs are already tracked via the gateway. Container costs are per-town (metered by Cloudflare). Do we add gastown-specific billing (per-bead, per-convoy, per-town monthly fee) or just pass through LLM + container costs?

7. **Refinery quality gates**: Should quality gates run inside the refinery agent's Kilo CLI session (agent runs `npm test`)? Or should they be a separate deterministic step (container runs tests directly, only invokes AI if tests fail)? The latter is cheaper and faster for the common case (tests pass). The AI agent is only needed for reasoning about failures.
