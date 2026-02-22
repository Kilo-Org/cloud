# Gastown at the Organization Level

## Overview

Gastown towns are currently user-scoped — one `GastownUserDO` per user, keyed by `userId`, storing that user's towns and rigs. There is no organization awareness anywhere in the gastown worker, DOs, container, or tool plugin.

The Kilo platform already has a mature org model: org membership with roles (`owner`, `member`, `billing_manager`), shared GitHub/GitLab integrations, org-level billing with per-user daily limits, seat subscriptions, SSO, audit logs, and the mutually-exclusive ownership pattern (`owned_by_user_id` XOR `owned_by_organization_id`) used across every resource type.

This spec defines how Gastown adopts the org model — enabling teams to share towns, pool agent resources, and coordinate work across members while leveraging the existing org infrastructure.

---

## Design Principles

1. **Org towns are the default for teams.** When a user belongs to an org, the primary workflow is creating and working in org-owned towns. Personal towns still exist for individual use.
2. **Existing org infrastructure, not new infrastructure.** Billing, integrations, roles, SSO, audit logs — all use the existing org systems. Gastown doesn't reinvent any of this.
3. **Org members share everything in a town.** All members can see all towns, all rigs, all beads, all agent conversations. Visibility is town-wide. Fine-grained per-rig permissions are a future concern.
4. **The Mayor serves the team, not one user.** An org town's Mayor is a shared resource. Any member can chat with it. The Mayor maintains context about all members' conversations.
5. **Billing is org-level.** All LLM and container costs for org towns charge against the org balance.

---

## Ownership Model

### Town ownership follows the platform pattern

Towns adopt the same mutually-exclusive ownership used by every other Kilo resource:

| Town type    | Owner                      | Who can access                  | Billing        |
| ------------ | -------------------------- | ------------------------------- | -------------- |
| Personal     | `owned_by_user_id`         | Only the user                   | User's balance |
| Organization | `owned_by_organization_id` | All org members (based on role) | Org balance    |

A town is either personal or org-owned, never both.

### Org role → town permissions

| Org role          | Can view towns                  | Can create towns | Can manage towns (delete, config) | Can chat with Mayor | Can view agents/beads |
| ----------------- | ------------------------------- | ---------------- | --------------------------------- | ------------------- | --------------------- |
| `owner`           | Yes                             | Yes              | Yes                               | Yes                 | Yes                   |
| `member`          | Yes                             | Yes              | No                                | Yes                 | Yes                   |
| `billing_manager` | No (not a user of the platform) | No               | No                                | No                  | No                    |

This mirrors how org roles map to other resources in the platform — owners manage, members use, billing managers handle money.

### Town creation flow

When creating a town, the UI checks the user's context:

- **User has no org:** Town is personal. Same as today.
- **User has one org:** Default to org-owned. Option to create a personal town instead.
- **User has multiple orgs:** Org picker before town creation. Option for personal.

The create-town API accepts an optional `organizationId`. When present, the backend verifies org membership before creating the town.

---

## Architecture Changes

### Replace GastownUserDO with owner-keyed lookup

The current `GastownUserDO` is keyed by `userId` and stores that user's towns. This doesn't work for org-owned towns — multiple users need access to the same set of towns.

**New approach:** Replace the per-user DO with an **owner-keyed DO** that can be keyed by either `userId` or `orgId`:

```typescript
function getGastownOwnerStub(env: Env, owner: { type: 'user' | 'org'; id: string }) {
  const key = `${owner.type}:${owner.id}`;
  return env.GASTOWN_OWNER.get(env.GASTOWN_OWNER.idFromName(key));
}
```

- Personal towns: `getGastownOwnerStub(env, { type: 'user', id: userId })`
- Org towns: `getGastownOwnerStub(env, { type: 'org', id: orgId })`

The `owner_towns` table adds an `owner_type` and `owner_id` column:

```sql
CREATE TABLE owner_towns (
  town_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_type TEXT NOT NULL,  -- 'user' or 'org'
  owner_id TEXT NOT NULL,    -- userId or orgId
  created_by TEXT NOT NULL,  -- userId of the creator (for audit)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### TownDO stores ownership context

The TownDO config gains org awareness:

```typescript
type TownConfig = {
  owner_type: 'user' | 'org';
  owner_id: string; // userId or orgId
  owner_user_id?: string; // set when owner_type = 'user'
  organization_id?: string; // set when owner_type = 'org'
  // ... existing config fields
};
```

This propagates through:

- **Container dispatch:** The container receives `organizationId` so it can resolve org-level integrations (GitHub tokens) and set appropriate env vars.
- **JWT minting:** The agent JWT payload gains `organizationId?: string` so rig-scoped tool calls carry org context.
- **Billing:** When the container makes LLM calls via the Kilo gateway, the `kilocodeToken` is minted with org context so costs charge against the org balance.

### Route structure

Add org-scoped routes alongside user-scoped routes:

```
# Personal towns (existing pattern, updated)
GET  /api/users/:userId/towns
POST /api/users/:userId/towns

# Org towns (new)
GET  /api/orgs/:orgId/towns
POST /api/orgs/:orgId/towns

# Town-level routes are the same regardless of ownership
# (townId is globally unique, no need for user/org prefix)
GET  /api/towns/:townId/...
POST /api/towns/:townId/...
```

The town-level routes don't change — once you have a `townId`, the TownDO handles everything. The ownership context is already stored in the TownDO's config.

### Auth middleware

The gastown worker currently relies on CF Access as its only perimeter. For org support, add proper authorization:

```typescript
// For /api/orgs/:orgId/towns/* routes
async function orgMiddleware(c: Context, next: Next) {
  const orgId = c.req.param('orgId');
  const userId = getUserIdFromRequest(c); // from CF Access JWT or session

  // Verify org membership via the main Kilo API
  const membership = await verifyOrgMembership(c.env, orgId, userId);
  if (!membership) return c.json({ error: 'Not an org member' }, 403);

  c.set('orgId', orgId);
  c.set('orgRole', membership.role);
  c.set('userId', userId);
  await next();
}

// For /api/towns/:townId/* routes
async function townAuthMiddleware(c: Context, next: Next) {
  const townId = c.req.param('townId');
  const userId = getUserIdFromRequest(c);

  // Look up town ownership from TownDO config
  const townDO = getTownDOStub(c.env, townId);
  const config = await townDO.getConfig();

  if (config.owner_type === 'user') {
    if (config.owner_id !== userId) return c.json({ error: 'Forbidden' }, 403);
  } else {
    // Org-owned: verify caller is an org member
    const membership = await verifyOrgMembership(c.env, config.organization_id!, userId);
    if (!membership) return c.json({ error: 'Not an org member' }, 403);
  }

  await next();
}
```

---

## Shared Mayor

In an org town, the Mayor is a shared resource. Multiple team members can chat with it concurrently or sequentially.

### How it works

The Mayor maintains a single persistent session per town (same as today). When any org member sends a message, it goes to the same Mayor session. The Mayor's conversation history includes messages from all members.

Each message carries the sender's identity:

```typescript
// When forwarding a user message to the Mayor's session
const systemContext = `[Message from ${userName} (${userRole})]`;
```

The Mayor can see who's talking to it and tailor responses accordingly. "Sarah asked me to refactor the auth module yesterday. You're asking about the auth module too — are you coordinating with her, or is this separate work?"

### Mayor chat in the dashboard

The town dashboard's Mayor chat panel shows the conversation to all connected members. Messages are attributed to their senders. This is a shared chat room where the Mayor is the AI participant and team members are the human participants.

Implementation: The existing Mayor WebSocket stream (town-wide, multiplexed) already supports multiple connected clients. Each client sends messages with the user's identity. The Mayor's responses are broadcast to all connected clients.

### Concurrency

When two members send messages simultaneously, they're queued by the TownDO (DO RPC serialization guarantees single-writer). The Mayor processes them sequentially. The second message includes context from the first — the Mayor sees the full conversation, not isolated threads.

If the team wants isolated conversations with the Mayor (e.g., a private question about performance), that's a future feature (per-user Mayor threads within an org town). For now, all Mayor interaction is shared.

---

## Integrations

### Org GitHub/GitLab apps are used automatically

When creating a rig in an org-owned town, the repo picker shows repositories from the **org's GitHub/GitLab installations** (not the user's personal installations). This uses the existing `getIntegrationForOwner({ type: 'org', id: orgId }, 'github')` infrastructure.

The flow:

1. User clicks "Add Rig" in an org town
2. Backend calls `getIntegrationForOwner({ type: 'org', id: orgId }, 'github')`
3. Repo picker shows org-accessible repos
4. On rig creation, `platform_integration_id` on the rig references the org's integration
5. When the container needs a git token, it's minted from the org's GitHub App installation

If the org doesn't have a GitHub App installed, the "Add Rig" flow prompts the user to install it (requires org `owner` role).

---

## Billing

### Org towns charge the org

All LLM costs for agents in org-owned towns charge against the org balance. This uses the existing `getBalanceForOrganizationUser(orgId, userId)` infrastructure:

1. When the TownDO dispatches an agent, it mints a `kilocodeToken` scoped to the org
2. The container's kilo serve instances route LLM calls through the Kilo gateway with this token
3. The gateway charges usage to the org's `microdollars_used`

### Container costs

Cloudflare Container costs are per-town. For org towns, these costs are attributed to the org. Metering uses the existing `microdollar_usage` table with `organization_id` set.

---

## Cross-Member Visibility

### Dashboard shows everything

When any org member opens an org town's dashboard, they see the complete picture:

- All rigs, all beads, all agents, all convoys
- All members' Mayor chat history
- All agent conversation streams
- All merge queue entries and their outcomes
- Activity feed across all members' actions

Attribution is clear — every bead shows who created it, every convoy shows who initiated it, every Mayor message shows who sent it. The dashboard answers "what is happening across the entire team's agent fleet?"

### Notifications

When an event occurs in an org town (convoy lands, escalation raised, merge failed), all connected dashboard clients receive the event via the existing WebSocket stream. Targeted notifications (e.g., "your convoy landed") use the `created_by` field on beads to identify the relevant member.

Future: Slack integration for org towns. Gastown events post to an org's Slack channel via the existing `organization-slack-router` infrastructure. "Convoy cv-abc landed: 5/5 beads merged across 2 rigs. Total cost: $23.40."

---

## Audit Trail

### Org audit logs include Gastown events

The existing `organization_audit_logs` table gains new action types for Gastown events:

| Action                        | Details                          |
| ----------------------------- | -------------------------------- |
| `gastown.town.create`         | Member created a town            |
| `gastown.town.delete`         | Owner deleted a town             |
| `gastown.town.config_change`  | Owner changed town config        |
| `gastown.rig.create`          | Member added a rig               |
| `gastown.rig.delete`          | Owner removed a rig              |
| `gastown.convoy.create`       | Member/Mayor initiated a convoy  |
| `gastown.convoy.landed`       | Convoy completed                 |
| `gastown.escalation.critical` | Critical escalation raised       |
| `gastown.escalation.resolved` | Escalation acknowledged/resolved |

These are written by the gastown worker when handling org-town events, via a service binding to the main Kilo API (or direct Postgres write if the gastown worker has DB access).

---

## Org-Level Fleet View

### The "all towns" dashboard

Beyond individual town dashboards, org owners get an aggregate view across all their org's towns:

**`/gastown/org/[orgId]`** shows:

- **Town cards** — one per town, showing: name, active agent count, open bead count, today's spend, latest activity
- **Aggregate metrics** — total spend (today/this week/this month), total beads closed, total convoys landed, active agent count across all towns
- **Cost breakdown** — per-town, per-rig, per-model cost attribution
- **Performance comparison** — which towns/rigs have high first-pass merge rates, which have high rework rates
- **Active escalations** — all unacknowledged escalations across all towns, surfaced at the top

This view is read-only for members and actionable for owners (click into any town, adjust config, kill runaway agents).

### Cross-town convoys

A convoy can track beads across multiple towns. This is natural because convoys are beads in the TownDO — but cross-town convoys require a coordination layer:

1. The initiating town creates a convoy bead
2. For beads in other towns, the convoy uses `bead_dependencies` with HOP-style references: `{ depends_on: "town:other-town-id:bead-id", type: "tracks" }`
3. When a tracked bead in another town closes, that town's alarm notifies the initiating town (via a cross-town webhook or direct DO RPC if both towns are in the same org's gastown worker)
4. The initiating town updates convoy progress

This extends the local Gastown convoy model to multi-town scope, which local Gastown doesn't support (convoys are per-town, tracking beads across rigs within one town).

---

## Agent Identity at the Org Level

### Agents are town-scoped, but CVs aggregate at the org level

Within a town, agent identities are town-scoped (per #441). But across towns in the same org, agent performance data can be aggregated:

- "Polecats using Claude Opus across all our towns have a 91% first-pass merge rate"
- "The payments-town has 3x the rework rate of the platform-town — something is wrong with the repo or the prompts"
- "Agent Toast in frontend-town has completed 47 beads with $0.83 average cost"

This data lives in the TownDO (per-town agent beads and bead events). The org fleet view aggregates across TownDOs via the gastown worker.

### Shared agent configurations

Org owners can define agent configurations at the org level:

```typescript
type OrgAgentConfig = {
  default_model: string;
  polecat_system_prompt_override?: string;
  refinery_quality_gates?: string[];
  max_polecats_per_rig?: number;
};
```

These serve as defaults for all towns in the org. Individual towns can override. This prevents the "every town is configured differently" problem and lets the org standardize on configurations that produce good results.

---

## SSO and Auto-Provisioning

When an org has SSO configured (via WorkOS), new team members who authenticate via SSO are auto-provisioned into the org. They immediately see all org-owned Gastown towns in their dashboard — no manual invitation or town sharing needed.

The flow:

1. New engineer joins company, authenticates via company SSO
2. WorkOS auto-provisions them into the Kilo org (existing behavior)
3. They navigate to Gastown, see all org towns
4. They open a town, chat with the Mayor, watch agents work

Zero configuration for the new member. The org's Gastown infrastructure is immediately accessible.

---

## Implementation Phases

### Phase 1: Ownership and access control

- Replace `GastownUserDO` with owner-keyed `GastownOwnerDO`
- Add `owner_type`/`owner_id` to town tables and TownDO config
- Add `organizationId` to agent JWT payload
- Add org auth middleware to gastown worker routes
- Add org-scoped routes (`/api/orgs/:orgId/towns`)
- Wire org membership verification

### Phase 2: Billing integration

- Mint org-scoped `kilocodeToken` for org town agents
- Route LLM costs to org balance via existing infrastructure
- Container cost attribution to org via `microdollar_usage` table

### Phase 3: Shared Mayor and dashboard

- Multi-user Mayor chat (message attribution, shared conversation)
- Dashboard access for all org members
- Activity feed shows member attribution

### Phase 4: Org fleet view

- Aggregate dashboard across all org towns
- Cost breakdown per town/rig/model
- Performance comparison metrics
- Cross-town escalation surfacing

### Phase 5: Org-level configuration

- Org-level agent config defaults (model, prompts, quality gates)
- Town-level overrides
- Shared formula library per org

### Phase 6: Cross-town convoys

- Cross-town bead references
- Cross-town convoy tracking and landing detection
- Cross-town notification routing

### Phase 7: Audit and compliance

- Gastown event types in org audit logs
- Org-level usage reporting
- Export capabilities for compliance

---

## What This Enables (That Local Gastown Can't Do)

1. **Team coordination** — Multiple engineers share a Mayor that knows what everyone is working on. "Don't touch the auth module, Sarah's convoy is refactoring it" happens naturally.
2. **Centralized cost visibility** — One dashboard showing total Gastown spend across all teams.
3. **Zero-config onboarding** — New engineer authenticates via SSO, immediately sees all org towns and can start using them.
4. **Org-wide performance data** — "Which model works best for our TypeScript repos?" answered from real production data across all teams.
5. **Cross-town project tracking** — A convoy that spans the frontend town, backend town, and infra town, with unified progress tracking and landing detection.
6. **Shared institutional knowledge** — Agent formulas, quality gate configs, and prompt tuning that work well for the org are shared across all towns, not siloed per developer.
