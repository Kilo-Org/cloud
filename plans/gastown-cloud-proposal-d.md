# Implementation Plan: Gastown Cloud (Proposal D)

Cloud-first rewrite of gastown's core tenets as a Kilo platform feature. See `docs/gt/hosted-gastown-proposals.md` — Proposal D for the full architecture rationale.

**Key design decisions:**

- All orchestration state lives in Durable Objects (SQLite) + Postgres (read replica for dashboard)
- Agents interact with gastown via **tool calls** backed by DO RPCs — no filesystem coordination
- Each agent is a Cloud Agent session running Kilo CLI with the gastown tool plugin
- LLM calls route through the Kilo gateway (`KILO_API_URL`)
- Watchdog/health monitoring uses DO alarms (mechanical) + ephemeral Cloud Agent sessions (intelligent triage)

---

## Phase 1: Single Rig, Single Polecat (Weeks 1–8)

The goal is to validate the core loop: a user creates a rig, assigns work, a polecat works on it via tool calls, completes it, and the work is merged.

### PR 1: Database Schema — Gastown Tables

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
    cloud_agent_session_id: text(), // current Cloud Agent session (null if no active session)
    status: text().notNull().$type<'idle' | 'working' | 'stalled' | 'dead'>().default('idle'),
    current_hook_bead_id: uuid(), // FK added after gastown_beads defined
    last_activity_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  t => [
    uniqueIndex('UQ_gastown_agents_rig_identity').on(t.rig_id, t.identity),
    index('IDX_gastown_agents_rig_role').on(t.rig_id, t.role),
    index('IDX_gastown_agents_session').on(t.cloud_agent_session_id),
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

### PR 2: Gastown Worker — Rig Durable Object

**Goal:** The Rig DO — the core state machine that holds beads, agents, mail, and the merge queue for a single rig.

#### New Worker: `cloud/cloudflare-gastown/`

```
cloud/cloudflare-gastown/
├── src/
│   ├── index.ts              # Hono router, DO exports
│   ├── types.ts              # Shared types
│   ├── rig-do.ts             # Rig Durable Object
│   ├── town-do.ts            # Town Durable Object (stub in Phase 1)
│   ├── agent-identity-do.ts  # Agent Identity Durable Object
│   └── db/
│       └── rig-schema.sql    # SQLite schema for Rig DO
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

#### Rig DO SQLite Schema

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

-- Merge queue
CREATE TABLE merge_queue (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  bead_id TEXT NOT NULL REFERENCES beads(id),
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'running', 'merged', 'failed'
  summary TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

-- Molecules (multi-step workflows)
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

#### Rig DO API Surface (RPC methods)

```typescript
class RigDO extends DurableObject<Env> {
  // -- Beads --
  async createBead(input: CreateBeadInput): Promise<Bead>;
  async getBead(beadId: string): Promise<Bead | null>;
  async listBeads(filter: BeadFilter): Promise<Bead[]>;
  async updateBeadStatus(beadId: string, status: string, agentId: string): Promise<Bead>;
  async closeBead(beadId: string, agentId: string): Promise<Bead>;

  // -- Agents --
  async registerAgent(input: RegisterAgentInput): Promise<Agent>;
  async getAgent(agentId: string): Promise<Agent | null>;
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

  // -- Merge Queue --
  async submitToMergeQueue(input: MergeQueueInput): Promise<void>;
  async popMergeQueue(): Promise<MergeQueueEntry | null>;
  async completeMerge(entryId: string, status: 'merged' | 'failed'): Promise<void>;

  // -- Prime (context assembly) --
  async prime(agentId: string): Promise<PrimeContext>; // returns role context + hooked work + mail

  // -- Checkpoint --
  async writeCheckpoint(agentId: string, data: unknown): Promise<void>;
  async readCheckpoint(agentId: string): Promise<unknown | null>;

  // -- Done --
  async agentDone(agentId: string, input: AgentDoneInput): Promise<void>;
  // unhooks bead, updates agent CV, submits to merge queue, sends POLECAT_DONE mail

  // -- Health (called by alarms) --
  async witnessPatrol(): Promise<PatrolResult>;

  // -- Postgres sync --
  private async syncToPostgres(event: BeadEvent): Promise<void>;
}
```

#### Wrangler Config

```jsonc
// cloud/cloudflare-gastown/wrangler.jsonc
{
  "name": "gastown",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "durable_objects": {
    "bindings": [
      { "name": "RIG", "class_name": "RigDO" },
      { "name": "TOWN", "class_name": "TownDO" },
      { "name": "AGENT_IDENTITY", "class_name": "AgentIdentityDO" },
    ],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RigDO", "TownDO", "AgentIdentityDO"] }],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<hyperdrive-id>" }],
}
```

---

### PR 3: Gastown Worker — HTTP API Layer

**Goal:** Hono router exposing the Rig DO's methods as HTTP endpoints, consumed by both the tool plugin and the Next.js backend.

#### Routes

```
POST   /api/rigs/:rigId/beads                    → createBead
GET    /api/rigs/:rigId/beads                     → listBeads
GET    /api/rigs/:rigId/beads/:beadId             → getBead
PATCH  /api/rigs/:rigId/beads/:beadId/status      → updateBeadStatus
POST   /api/rigs/:rigId/beads/:beadId/close       → closeBead

POST   /api/rigs/:rigId/agents                    → registerAgent
GET    /api/rigs/:rigId/agents                     → listAgents
GET    /api/rigs/:rigId/agents/:agentId            → getAgent

POST   /api/rigs/:rigId/agents/:agentId/hook      → hookBead
DELETE /api/rigs/:rigId/agents/:agentId/hook       → unhookBead
GET    /api/rigs/:rigId/agents/:agentId/prime      → prime
POST   /api/rigs/:rigId/agents/:agentId/done       → agentDone
POST   /api/rigs/:rigId/agents/:agentId/checkpoint → writeCheckpoint

POST   /api/rigs/:rigId/mail                       → sendMail
GET    /api/rigs/:rigId/agents/:agentId/mail        → checkMail

POST   /api/rigs/:rigId/merge-queue                → submitToMergeQueue
POST   /api/rigs/:rigId/escalations                → createEscalation

GET    /api/rigs/:rigId/convoys                    → listConvoys (Phase 2)
```

#### Auth

Two auth modes (following KiloClaw pattern):

- **Internal** (`x-internal-api-key`): Next.js backend → worker
- **Agent** (`Authorization: Bearer <session-token>`): tool plugin → worker. Token is a short-lived JWT containing `{ agentId, rigId, townId, userId }`, minted by Next.js when creating a Cloud Agent session.

---

### PR 4: Gastown Tool Plugin

**Goal:** The opencode plugin that exposes gastown tools to agents. This is the heart of the system — it's what agents actually interact with.

#### Location

This should be a standalone package that gets bundled into Cloud Agent session configs:

```
cloud/cloudflare-gastown/plugin/
├── src/
│   ├── index.ts         # Plugin entry point
│   ├── tools.ts         # Tool definitions
│   ├── client.ts        # HTTP client for Rig DO API
│   └── types.ts         # Shared types
├── package.json
└── tsconfig.json
```

#### Tools (Phase 1 — minimum viable set)

| Tool             | Description                                                              | Rig DO Method                    |
| ---------------- | ------------------------------------------------------------------------ | -------------------------------- |
| `gt_prime`       | Get full role context: identity, hooked work, instructions, pending mail | `prime(agentId)`                 |
| `gt_bead_status` | Read the status of a bead                                                | `getBead(beadId)`                |
| `gt_bead_close`  | Close current bead or molecule step                                      | `closeBead(beadId)`              |
| `gt_done`        | Signal work complete — push branch, submit to merge queue                | `agentDone(agentId, ...)`        |
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

#### Environment Variables (set by Cloud Agent session config)

| Var                     | Value                                               |
| ----------------------- | --------------------------------------------------- |
| `GASTOWN_API_URL`       | Worker URL: `https://gastown.<account>.workers.dev` |
| `GASTOWN_SESSION_TOKEN` | Short-lived JWT for this agent session              |
| `GASTOWN_AGENT_ID`      | This agent's UUID                                   |
| `GASTOWN_RIG_ID`        | This rig's UUID                                     |
| `KILO_API_URL`          | Kilo gateway URL (for LLM calls)                    |

---

### PR 5: Cloud Agent Session Integration

**Goal:** Wire up the Next.js backend to create Cloud Agent sessions with the gastown tool plugin pre-configured.

#### New Service: `src/lib/gastown/`

```
src/lib/gastown/
├── types.ts                  # GasTownConfig, RigConfig, AgentConfig types
├── gastown-service.ts        # Core service: create town, create rig, sling work
├── gastown-internal-client.ts # HTTP client for gastown worker (internal auth)
├── session-factory.ts        # Creates Cloud Agent sessions for gastown agents
└── token.ts                  # Mints short-lived JWTs for agent → worker auth
```

#### `session-factory.ts` — the key integration point

```typescript
export async function createPolecatSession(input: {
  userId: string;
  townId: string;
  rigId: string;
  agentId: string;
  agentName: string;
  beadId: string;
  gitUrl: string;
  branch: string;
  model: string;
}): Promise<{ sessionId: string; streamUrl: string }> {
  const token = mintAgentToken({
    agentId: input.agentId,
    rigId: input.rigId,
    townId: input.townId,
    userId: input.userId,
  });

  const session = await cloudAgentClient.prepareSession({
    userId: input.userId,
    model: input.model,
    systemPrompt: POLECAT_SYSTEM_PROMPT,
    env: {
      GASTOWN_API_URL: env.GASTOWN_WORKER_URL,
      GASTOWN_SESSION_TOKEN: token,
      GASTOWN_AGENT_ID: input.agentId,
      GASTOWN_RIG_ID: input.rigId,
      KILO_API_URL: env.KILO_API_URL,
      OPENCODE_PERMISSION: '{"*":"allow"}',
    },
    // The gastown tool plugin is pre-installed in the Cloud Agent sandbox
    // via opencode.json config that includes it as a plugin
    gitUrl: input.gitUrl,
    gitBranch: input.branch,
  });

  return {
    sessionId: session.id,
    streamUrl: session.streamUrl,
  };
}
```

#### Role System Prompts

Port the core of `polecat-CLAUDE.md` to a system prompt template. In Phase 1, only the polecat role is needed. The prompt must:

- Establish identity (agent name, rig, role)
- Explain available gastown tools and when to use each
- Embed the GUPP principle ("work is on your hook — execute immediately, no announcements")
- Instruct on the done flow (push branch → `gt_done` → tools)
- Instruct on escalation (if stuck → `gt_escalate`)

---

### PR 6: tRPC Routes — Town & Rig Management

**Goal:** Dashboard API for creating and managing towns and rigs.

#### New Router: `src/server/routers/gastown.ts`

```typescript
export const gastownRouter = router({
  // -- Towns --
  createTown: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(64),
      })
    )
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
      // 1. Create bead in Rig DO
      // 2. Register or pick an agent
      // 3. Hook bead to agent
      // 4. Create Cloud Agent session via session-factory
      // 5. Return agent/session info
    }),

  // -- Agent Streams --
  getAgentStreamUrl: protectedProcedure
    .input(
      z.object({
        agentId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      /* return Cloud Agent WebSocket stream URL */
    }),
});
```

---

### PR 7: Basic Dashboard UI

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
- **Agent stream**: Embeds Cloud Agent WebSocket stream (reuse existing `WebSocketManager` from `cloud-agent-client.ts`).
- **Sling dialog**: Form to create a bead and assign it. Inputs: title, body, model selector.

---

### PR 8: Manual Merge Flow

**Goal:** When a polecat calls `gt_done`, process the merge queue entry. Phase 1 uses a simple merge — no AI-powered refinery.

#### Implementation in Rig DO

When `agentDone()` is called:

1. Unhook bead from agent
2. Close bead, record in bead events
3. Insert into merge queue with branch name
4. Send `POLECAT_DONE` mail to rig's witness (if exists, Phase 2)
5. Trigger merge processing via DO alarm

Merge processing (alarm handler):

1. Pop next entry from merge queue
2. Clone repo, checkout branch, attempt merge into default branch
3. If merge succeeds → update entry status to `merged`, close associated bead
4. If merge fails (conflict) → update entry status to `failed`, create escalation bead
5. Sync results to Postgres

In Phase 1, the merge is done via the **git service** (App Builder's existing git worker or a new git service endpoint). We don't spin up a Cloud Agent session for merging — that's Phase 2 (Refinery).

---

## Phase 2: Multi-Agent Orchestration (Weeks 9–14)

### PR 9: Town Durable Object

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
- `watchdogHeartbeat()` — DO alarm (3 min): check each Rig DO health, detect GUPP violations

---

### PR 10: Multiple Polecats per Rig

**Goal:** Support N concurrent polecats working on different beads in the same rig.

Changes:

- `sling` tRPC mutation supports creating multiple beads + agents
- Rig DO manages agent name allocation (sequential names: Toast, Maple, Birch, etc.)
- Each polecat gets its own branch: `polecat/<name>/<bead-id-prefix>`
- Dashboard shows all active agents with their streams

---

### PR 11: Witness Alarm

**Goal:** The Witness is not a separate agent session — it's a DO alarm in the Rig DO that monitors polecat health.

#### Witness Patrol (Rig DO alarm, every 2 minutes)

```typescript
async witnessPatrol(): Promise<void> {
  const agents = this.db.prepare(
    'SELECT * FROM agents WHERE role = ? AND status != ?'
  ).all('polecat', 'idle');

  for (const agent of agents) {
    // 1. Check if Cloud Agent session is alive
    const sessionAlive = await this.checkSessionHealth(agent.cloud_agent_session_id);

    if (!sessionAlive && agent.current_hook_bead_id) {
      // Dead session with hooked work → restart
      await this.restartAgent(agent);
      continue;
    }

    // 2. GUPP violation check (30 min no progress)
    if (agent.last_activity_at) {
      const staleMinutes = minutesSince(agent.last_activity_at);
      if (staleMinutes > 30) {
        // For ZFC: we don't judge WHY it's stalled — we escalate
        await this.sendMail({
          from: 'witness',
          to: agent.id,
          subject: 'GUPP_CHECK',
          body: 'You have had work hooked for 30+ minutes with no activity. Are you stuck? If so, call gt_escalate.',
        });
      }
    }
  }
}
```

For ambiguous cases (ZFC principle — is the agent stuck or just thinking?), the witness alarm can spawn a short-lived "triage" Cloud Agent session to assess. This is the Boot equivalent from gastown. Defer to Phase 3 if complexity is too high here.

---

### PR 12: Refinery Alarm

**Goal:** Automated merge with quality gates.

When a merge queue entry is ready:

1. Rig DO alarm fires
2. Spawn a short-lived Cloud Agent session (the "refinery") that:
   - Checks out the branch
   - Runs quality gates (configurable: `npm test`, `npm run build`, lint, etc.)
   - If passing → merge to main, update merge queue entry
   - If failing → create `REWORK_REQUEST` mail to the polecat, set merge entry to `failed`
3. Session is destroyed after the merge completes

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

---

### PR 13: Molecule/Formula System

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

### PR 14: Convoy Lifecycle

**Goal:** Convoys track batched work across rigs with landing notifications.

#### Flow

1. Mayor (or dashboard) creates convoy via Town DO: `createConvoy(title, beadSpecs[])`
2. Town DO distributes beads to Rig DOs, recording `convoy_id` on each
3. When a bead closes, Rig DO notifies Town DO: `onBeadClosed(convoyId, beadId)`
4. Town DO increments `closed_beads`, checks if `closed_beads == total_beads`
5. If landed → update status, fire webhook/notification, write to Postgres

---

### PR 15: Escalation System

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

## Phase 3: Multi-Rig + Mayor (Weeks 15–20)

### PR 16: Mayor Agent Session

**Goal:** The Mayor is a persistent Cloud Agent session that coordinates work across rigs.

The Mayor:

- Receives work requests from the user (via dashboard or direct message)
- Breaks down work into beads, creates convoys
- Slings beads to rigs (calls Rig DO APIs via gastown tools)
- Handles escalations routed to it
- Has cross-rig visibility via Town DO

#### New Tools for Mayor Role

| Tool               | Description                                               |
| ------------------ | --------------------------------------------------------- |
| `gt_sling`         | Create bead and assign to a polecat in a rig              |
| `gt_convoy_create` | Create a convoy with multiple beads                       |
| `gt_convoy_status` | Check convoy progress                                     |
| `gt_rig_status`    | Get summary of a rig's state (agents, beads, merge queue) |

The Mayor's system prompt is the most complex — it needs to understand the full gastown model and make good delegation decisions.

---

### PR 17: Multi-Rig Support

**Goal:** A Town with multiple rigs, cross-rig mail routing, and the dashboard reflecting all rigs.

- Town DO maintains rig registry, routes cross-rig mail via Rig DO RPCs
- Dashboard shows all rigs in a town with drill-down
- Convoys can span multiple rigs

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

### PR 19: Dashboard Polish

- Convoy progress visualization (progress bar, timeline)
- Real-time updates via WebSocket or polling
- Agent conversation history (read from R2/Cloud Agent session storage)
- Cost tracking per town/rig/convoy/agent

---

## Phase 4: Hardening (Weeks 21–24)

### PR 20: Stress Testing

- Simulate 30 concurrent polecats across 5 rigs
- Measure DO latency under load (tool call round-trip)
- Identify DO SQLite size limits and implement archival (closed beads → Postgres, purge from DO)
- Test rapid session crash/restart cycles

### PR 21: Edge Case Handling

- Split-brain: two sessions for same agent (race on restart) → Rig DO enforces single-writer per agent
- Concurrent writes to same bead → SQLite serialization in DO handles this, but add optimistic locking for cross-DO operations
- DO eviction during alarm → alarms are durable and will re-fire
- Cloud Agent session timeout → witness alarm detects and restarts
- Gateway outage → agent retries built into Kilo CLI; escalation if persistent

### PR 22: Observability

- Structured logging in gastown worker (Sentry)
- Bead event stream for real-time dashboard (DO → WebSocket or SSE)
- Alert on: GUPP violations, escalation rate spikes, merge queue depth, agent restart loops
- Usage metrics: beads/day, agents/day, LLM cost/bead

### PR 23: Onboarding Flow

- "Create your first Town" wizard
- Connect git repo (GitHub App integration — reuse existing)
- Select model
- Sling first bead
- Watch the polecat work

### PR 24: Documentation & API Reference

- Internal: architecture doc, DO state schemas, tool plugin API
- External: user guide for hosted gastown

---

## Open Questions

1. **Git service**: Do we build a new git management worker or reuse the App Builder's `GitRepositoryDO`? The App Builder worker already handles repo init, branch management, and builds. May need forking rather than direct reuse since gastown has different branching semantics (polecat branches, merge queue).

2. **Tool plugin distribution**: How does the gastown tool plugin get into Cloud Agent sessions? Options:
   - Baked into the Cloud Agent sandbox image (requires Cloud Agent team coordination)
   - Passed as an MCP server config at session creation time
   - Installed via `OPENCODE_CONFIG_CONTENT` env var pointing at a config that includes the plugin
   - The simplest option is likely `OPENCODE_CONFIG_CONTENT` with the plugin URL

3. **Refinery quality gates**: Should quality gates run inside the same Cloud Agent session as the refinery (agent runs `npm test`)? Or should they be a separate non-AI process (cheaper, deterministic)? The gastown philosophy says the refinery is an AI agent that can reason about test failures, but a non-AI gate is cheaper and faster for simple pass/fail.

4. **Mayor session persistence**: The Mayor should be long-lived (persistent coordination). Cloud Agent sessions have idle timeouts. Options:
   - Extend Cloud Agent to support long-lived sessions
   - Restart Mayor session on demand (when user sends a message or when work needs coordination)
   - Make the Mayor "demand-spawned" — Town DO alarm spawns a Mayor session only when there's work to coordinate, then lets it die

5. **DO storage limits**: Durable Object SQLite has a 10GB limit. A rig with thousands of beads over months could approach this. Archival strategy: periodically move closed beads to Postgres and purge from DO SQLite. The DO is the hot path; Postgres is the cold archive.

6. **Billing model**: Per-agent-session LLM costs are already tracked via the gateway. Do we add gastown-specific billing (per-bead, per-convoy, per-town monthly fee) or just charge for LLM usage?
