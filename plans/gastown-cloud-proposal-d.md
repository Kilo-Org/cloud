# Implementation Plan: Gastown Cloud (Proposal D — Revised)

Cloud-first rewrite of gastown's core tenets as a Kilo platform feature. See `docs/gt/hosted-gastown-proposals.md` — Proposal D for the full architecture rationale.

---

## What Is Gastown? A Comprehensive Reference

> This section documents the full scope of the Gastown system — its concepts, architecture, information model, agent taxonomy, communication protocols, and operational design — as described in the [official Gastown documentation](https://docs.gastownhall.ai/). It exists to serve as the ground truth against which this cloud rewrite proposal should be evaluated. If a concept from Gastown doesn't appear in this section, it may be missing from the cloud proposal.

### 1. Overview and Purpose

**Gastown** (also styled "Gas Town") is an agent orchestration system for managing multiple AI coding agents working concurrently across multiple git repositories. It is implemented as a local command-line tool — two Go binaries (`gt` for orchestration and `bd` for the Beads work-tracking database) — coordinated with tmux in git-managed directories on the user's machine.

Gastown solves four problems that arise when deploying AI agents at engineering scale:

1. **Accountability** — Which agent introduced this bug? All work is attributed to a specific agent identity.
2. **Quality** — Which agents are reliable? Structured work history enables objective comparison.
3. **Efficiency** — How do you route work to the right agent? Capability-based routing derived from work history.
4. **Scale** — How do you coordinate agents across repos and teams? Multi-rig, multi-agent, cross-project orchestration.

### 2. Core Principles

Gastown's design is governed by three foundational principles:

| Principle                                   | Acronym | Meaning                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Molecular Expression of Work**            | MEOW    | Breaking large goals into detailed, trackable, atomic instructions for agents. Supported by Beads, Formulas, and Molecules.                                                                                                                                 |
| **Gas Town Universal Propulsion Principle** | GUPP    | "If there is work on your Hook, YOU MUST RUN IT." Agents autonomously proceed with available work without waiting for external input. The hook is your assignment — execute immediately.                                                                    |
| **Nondeterministic Idempotence**            | NDI     | Useful outcomes are achieved through orchestration of potentially unreliable processes. Persistent Beads and oversight agents (Witness, Deacon) guarantee eventual workflow completion even when individual operations may fail or produce varying results. |

Additionally:

- **ZFC (Zero Framework Cognition)**: Agents decide; Go code transports. The Go binaries (`gt`/`bd`) never reason about other agents — they provide mechanical transport. Intelligence lives in the AI agent sessions.
- **Discover, Don't Track**: Reality is truth; state is derived from observable facts (tmux sessions, git state) rather than stored state that can diverge.

### 3. Information Architecture: The Two-Level Beads System

The fundamental data model is **Beads** — git-backed atomic work units stored in JSONL format. Beads are the universal unit of work tracking. They can represent issues, tasks, epics, escalations, messages, agent identity records, or any trackable work item.

Gastown uses a **two-level Beads architecture**:

| Level    | Location                  | Prefix                             | Purpose                                                                                                            |
| -------- | ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Town** | `~/gt/.beads/`            | `hq-*`                             | Cross-rig coordination: Mayor mail, convoy tracking, strategic decisions, town-level agent beads, role definitions |
| **Rig**  | `<rig>/mayor/rig/.beads/` | project prefix (e.g. `gt-`, `bd-`) | Implementation work: bugs, features, tasks, merge requests, project-specific molecules, rig-level agent beads      |

**Beads routing** is prefix-based. The file `~/gt/.beads/routes.jsonl` maps issue ID prefixes to rig locations. When you run `bd show gt-xyz`, the prefix `gt-` routes to the gastown rig's beads database. This is transparent — agents don't need to know which database to use.

### 4. Environments: Towns and Rigs

| Concept  | Description                                                                                                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Town** | The management headquarters (e.g., `~/gt/`). A town coordinates all workers across multiple rigs. It houses town-level agents (Mayor, Deacon) and the town-level Beads database.                                                                                                                                        |
| **Rig**  | A project-specific git repository under Gastown management. Each rig has its own Polecats, Refinery, Witness, and Crew members. Rigs are where actual development work happens. The rig root is a _container directory_, not a git clone itself — it holds a bare repo (`.repo.git/`) from which worktrees are created. |

#### Directory Structure

```
~/gt/                           Town root
├── .beads/                     Town-level beads (hq-* prefix, routes)
├── mayor/                      Mayor config
│   ├── town.json               Town configuration
│   ├── CLAUDE.md               Mayor context (on disk)
│   └── .claude/settings.json   Mayor Claude settings
├── deacon/                     Deacon daemon
│   ├── heartbeat.json          Freshness indicator
│   └── dogs/                   Deacon helpers
│       └── boot/               Health triage dog
└── <rig>/                      Project container (NOT a git clone)
    ├── config.json             Rig identity + beads prefix
    ├── .beads/ → mayor/rig/.beads  (redirect)
    ├── .repo.git/              Bare repo (shared by worktrees)
    ├── mayor/rig/              Mayor's clone (canonical beads)
    ├── refinery/rig/           Worktree on main branch
    ├── witness/                No clone (monitors only)
    ├── crew/                   Persistent human workspaces
    │   ├── .claude/settings.json  (shared by all crew)
    │   └── <name>/rig/        Individual crew clones
    └── polecats/               Ephemeral worker worktrees
        ├── .claude/settings.json  (shared by all polecats)
        └── <name>/rig/        Individual polecat worktrees
```

**Worktree architecture**: Polecats and the Refinery are git worktrees from the bare `.repo.git/`, not full clones. This enables fast spawning and shared git object storage. Crew members get full clones for independent long-lived work.

### 5. Agent Taxonomy

Gastown has seven distinct agent roles organized into two tiers:

#### Town-Level Agents (Cross-Rig)

| Role       | Description                                                                                                                                                                            | Lifecycle                 | Location            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------- |
| **Mayor**  | Global coordinator. Initiates convoys, distributes work across rigs, handles escalations, coordinates cross-rig communication.                                                         | Singleton, persistent     | `~/gt/mayor/`       |
| **Deacon** | Daemon beacon. Background supervisor running continuous patrol cycles. Monitors system health, ensures worker activity, triggers recovery.                                             | Singleton, persistent     | `~/gt/deacon/`      |
| **Dogs**   | The Deacon's helper agents for infrastructure tasks (NOT project work). Example: Boot (health triage dog). Dogs are lightweight Go routines or ephemeral AI sessions for narrow tasks. | Ephemeral, Deacon-managed | `~/gt/deacon/dogs/` |

#### Rig-Level Agents (Per-Project)

| Role         | Description                                                                                                                                                                                                                                                                   | Lifecycle                  | Location                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------- |
| **Witness**  | Per-rig polecat lifecycle manager. Monitors polecat health, nudges stuck workers, handles cleanup, triggers escalations.                                                                                                                                                      | One per rig, persistent    | `<rig>/witness/`             |
| **Refinery** | Per-rig merge queue processor. Intelligently merges changes from polecats, handles conflicts, runs quality gates, ensures code quality before changes reach main.                                                                                                             | One per rig, persistent    | `<rig>/refinery/rig/`        |
| **Polecat**  | Ephemeral worker agents that produce merge requests. Spawned for specific tasks, work in isolated git worktrees, submit to merge queue when done, then self-clean. There is **no idle state** — polecats are either working, stalled (crashed), or zombie (`gt done` failed). | Transient, Witness-managed | `<rig>/polecats/<name>/rig/` |
| **Crew**     | Persistent worker agents for long-lived collaboration. Human-managed, no automatic monitoring. Push to main directly (no merge queue).                                                                                                                                        | Long-lived, user-managed   | `<rig>/crew/<name>/rig/`     |

#### Key Distinctions

- **Crew vs Polecats**: Crew is persistent, human-directed, pushes to main. Polecats are transient, Witness-managed, work on branches, go through the Refinery merge queue.
- **Dogs vs Crew**: Dogs are NOT workers. They handle infrastructure tasks for the Deacon (health checks, shutdown dances). Project work uses Crew or Polecats.

### 6. The Polecat Lifecycle (Three-Layer Architecture)

Polecats have three distinct lifecycle layers that operate independently:

| Layer       | Component                                    | Lifecycle  | Persistence             |
| ----------- | -------------------------------------------- | ---------- | ----------------------- |
| **Session** | AI agent instance (e.g., Claude in tmux)     | Ephemeral  | Cycles per step/handoff |
| **Sandbox** | Git worktree (the working directory)         | Persistent | Until nuke              |
| **Slot**    | Name from pool (Toast, Shadow, Copper, etc.) | Persistent | Until nuke              |

**Session cycling is normal operation**, not failure. A polecat may cycle through many sessions while working on a single task (via `gt handoff` between molecule steps, compaction triggers, or crash recovery). The sandbox and slot persist across all session cycles.

**Polecat states** (there are exactly three — no idle state):

| State       | Description                                                         |
| ----------- | ------------------------------------------------------------------- |
| **Working** | Actively doing assigned work                                        |
| **Stalled** | Session stopped mid-work (crashed/interrupted without being nudged) |
| **Zombie**  | Completed work but failed to die (`gt done` failed during cleanup)  |

**Lifecycle flow**: `gt sling` → allocate slot → create worktree → start session → hook molecule → work happens (with session cycling) → `gt done` → push branch → submit to merge queue → request self-nuke → polecat is gone.

**Self-cleaning model**: Polecats are responsible for their own cleanup. When work completes, the polecat calls `gt done`, exits, and requests its own nuke. There is no dependency on the Witness for normal cleanup.

### 7. Work Units and Workflow

#### Work Units

| Concept           | Description                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bead**          | Git-backed atomic work unit (JSONL). The fundamental tracking primitive. Can represent issues, tasks, messages, escalations, MRs, agent identity records.                         |
| **Hook**          | A special pinned Bead for each agent — their current assignment. GUPP: if work is on your hook, you run it immediately.                                                           |
| **Formula**       | TOML-based workflow source template. Defines reusable patterns for multi-step operations (e.g., polecat work, patrol cycles, code review).                                        |
| **Protomolecule** | A frozen template created from a formula via `bd cook`. Ready for instantiation.                                                                                                  |
| **Molecule**      | A durable, active workflow instance with trackable steps. Each step is a Bead. Molecules survive agent restarts and ensure complex workflows complete. Created via `bd mol pour`. |
| **Wisp**          | An ephemeral molecule for patrol cycles and operational loops. Never synced to persistent storage. Created via `bd mol wisp`. Used by patrol agents to avoid accumulating data.   |
| **Convoy**        | A persistent tracking unit that monitors related beads across multiple rigs. Convoys group related tasks and track progress to "landing" (all tracked issues closed).             |

#### Molecule Lifecycle

```
Formula (source TOML) ─── "Ice-9"
    │
    ▼ bd cook
Protomolecule (frozen template) ─── Solid
    │
    ├─▶ bd mol pour ──▶ Mol (persistent) ─── Liquid ──▶ bd squash ──▶ Digest
    │
    └─▶ bd mol wisp ──▶ Wisp (ephemeral) ─── Vapor ──┬▶ bd squash ──▶ Digest
                                                       └▶ bd burn ──▶ (gone)
```

Agents navigate molecules with `bd mol current` (where am I?), `bd close <step> --continue` (close step and auto-advance), and `gt done` (signal completion).

#### The Sling → Work → Done → Merge Flow

1. **Sling**: `gt sling <bead> <rig>` assigns work to a polecat. Auto-creates a convoy for tracking.
2. **Work**: Polecat finds work on hook via `gt hook`, navigates molecule steps, executes code changes.
3. **Done**: Polecat calls `gt done` → pushes branch → submits to merge queue → self-nukes.
4. **Merge**: Refinery picks up from merge queue → runs quality gates → merges to main (or sends rework request back through the Witness).

### 8. Communication Systems

#### Mail Protocol

Agents coordinate via typed mail messages routed through the Beads system. Key message types:

| Type             | Route                        | Purpose                                          |
| ---------------- | ---------------------------- | ------------------------------------------------ |
| `POLECAT_DONE`   | Polecat → Witness            | Signal work completion, trigger cleanup          |
| `MERGE_READY`    | Witness → Refinery           | Branch ready for merge queue processing          |
| `MERGED`         | Refinery → Witness           | Branch merged successfully, safe to nuke polecat |
| `MERGE_FAILED`   | Refinery → Witness           | Merge failed (tests/build), needs rework         |
| `REWORK_REQUEST` | Refinery → Witness → Polecat | Rebase needed due to merge conflicts             |
| `WITNESS_PING`   | Witness → Deacon             | Second-order monitoring (ensure Deacon is alive) |
| `HELP`           | Any → Mayor                  | Request intervention for stuck/blocked work      |
| `HANDOFF`        | Agent → self                 | Session continuity data across context limits    |

Mail addresses use slash-separated path format: `gastown/witness`, `gastown/polecats/toast`, `mayor/`, `deacon/`.

#### Nudging

Real-time messaging between agents via `gt nudge <agent> "message"`. Delivered via tmux, not mail. Used for urgent communication (health checks, unsticking agents).

#### Beads-Native Messaging Extensions

Advanced messaging primitives:

- **Groups** (`gt:group`): Named distribution lists for multi-recipient mail
- **Queues** (`gt:queue`): Work queues where messages are claimed by single workers (FIFO or priority)
- **Channels** (`gt:channel`): Pub/sub broadcast streams with retention policies

### 9. Identity and Attribution

All work is attributed to the agent who performed it via the `BD_ACTOR` environment variable:

| Role     | BD_ACTOR Format         | Example                  |
| -------- | ----------------------- | ------------------------ |
| Mayor    | `mayor`                 | `mayor`                  |
| Deacon   | `deacon`                | `deacon`                 |
| Witness  | `{rig}/witness`         | `gastown/witness`        |
| Refinery | `{rig}/refinery`        | `gastown/refinery`       |
| Crew     | `{rig}/crew/{name}`     | `gastown/crew/joe`       |
| Polecat  | `{rig}/polecats/{name}` | `gastown/polecats/toast` |

Attribution flows through:

- **Git commits**: `GIT_AUTHOR_NAME="gastown/polecats/toast"`, `GIT_AUTHOR_EMAIL="<owner>@example.com"`
- **Beads records**: `created_by`, `updated_by` fields
- **Event logs**: `actor` field on all events

**Agents execute. Humans own.** The polecat name is executor attribution; the CV credits the human owner. Identity is preserved even when working cross-rig (a crew member from rig A working in rig B's worktree still has their original identity).

**Polecat identity is persistent; sessions are ephemeral.** Polecats accumulate work history (CV) across sessions, enabling performance tracking, capability-based routing, and model comparison.

### 10. The Watchdog Chain: Daemon → Boot → Deacon

Gastown uses a three-tier watchdog chain for autonomous health monitoring:

```
Daemon (Go process)           ← Dumb transport, 3-min heartbeat tick
    │
    └─► Boot (AI agent)       ← Intelligent triage, fresh each tick
            │
            └─► Deacon (AI agent)  ← Continuous patrol, long-running
                    │
                    └─► Witnesses & Refineries  ← Per-rig agents
```

- **Daemon**: A Go process running a 3-minute heartbeat. Cannot reason (ZFC principle). Ensures Boot runs, checks tmux sessions, spawns agents.
- **Boot**: An ephemeral AI agent spawned fresh each daemon tick. Makes a single intelligent decision: should the Deacon wake? Exits immediately. This provides intelligent triage without constant AI cost.
- **Deacon**: A long-running AI agent doing continuous patrol cycles. Monitors all agents, runs plugins, handles escalations. Writes `heartbeat.json` each cycle.

**Boot decision matrix**:

| Condition                         | Action                                             |
| --------------------------------- | -------------------------------------------------- |
| Deacon session dead               | START (exit; daemon calls `ensureDeaconRunning()`) |
| Heartbeat > 15 min                | WAKE (nudge Deacon)                                |
| Heartbeat 5–15 min + pending mail | NUDGE (send check-in)                              |
| Heartbeat fresh                   | NOTHING (exit silently)                            |

**Why two AI agents?** The Deacon can't observe itself (a hung Deacon can't detect it's hung). Boot provides an external observer with fresh context each tick.

**Degraded mode**: When tmux is unavailable, Boot falls back to mechanical Go code (purely threshold-based, no reasoning).

### 11. The Convoy System

Convoys are the primary unit for tracking batched work across rigs. Even a single slung bead auto-creates a convoy for dashboard visibility.

**Lifecycle**: `OPEN → (all tracked issues close) → CLOSED/LANDED`. Adding issues to a closed convoy auto-reopens it.

**Convoy vs Swarm**: A convoy is persistent (tracking unit with ID `hq-cv-*`). A "swarm" is ephemeral — just the workers currently assigned to a convoy's issues. When issues close, the convoy lands and the swarm dissolves.

**Active Convoy Convergence**: Convoy completion should be event-driven (triggered by issue close, not polling), redundantly observed (Daemon, Witness, and Deacon all check), and manually overridable (`gt convoy close`).

### 12. The Escalation System

Severity-routed escalation with tiered routing and auto-re-escalation:

| Severity   | Default Route                         |
| ---------- | ------------------------------------- |
| `low`      | Bead only (record)                    |
| `medium`   | Bead + mail Mayor                     |
| `high`     | Bead + mail Mayor + email human       |
| `critical` | Bead + mail Mayor + email + SMS human |

**Escalation categories**: `decision`, `help`, `blocked`, `failed`, `emergency`, `gate_timeout`, `lifecycle`.

**Tiered escalation flow**: Worker → Deacon → Mayor → Overseer (human). Each tier can resolve or forward.

**Stale escalation patrol**: Unacknowledged escalations are checked every patrol cycle. If older than `stale_threshold` (default 4h), severity is bumped and re-routed. Respects `max_reescalations` limit.

**Decision pattern**: When `--type decision` is used, the escalation bead includes structured options (A/B/C), context, and resolution instructions. The bead itself becomes the async communication channel.

### 13. The Merge Queue and Refinery

When a polecat completes work:

1. Polecat calls `gt done` → sends `POLECAT_DONE` mail to Witness
2. Witness verifies clean state → sends `MERGE_READY` to Refinery
3. Refinery adds to merge queue → attempts merge (rebase, quality gates, tests)
4. On success: `MERGED` mail → Witness nukes polecat worktree
5. On conflict: `REWORK_REQUEST` mail → Witness notifies polecat to rebase
6. On failure (tests/build): `MERGE_FAILED` → rework request with failure details

The Refinery runs continuous patrol (using wisps) to process the merge queue.

### 14. The Plugin System

Gastown has an extensible plugin system for periodic maintenance tasks. Plugins are molecule definitions in `plugin.md` files with TOML frontmatter.

**Plugin locations**: Town-level (`~/gt/plugins/`) for universal plugins; rig-level (`<rig>/plugins/`) for project-specific.

**Gate types** control when plugins run: `cooldown` (time-based), `cron`, `condition` (check command exit code), `event` (e.g., startup), `manual`.

**Execution model**: Plugins are dispatched to Dogs (lightweight executors) by the Deacon during patrol. Non-blocking — multiple plugins can run concurrently.

**State tracking**: Plugin runs create wisps on the ledger (not state files). Gate evaluation queries wisps. Daily digest squashes wisps for clean audit history.

### 15. Configuration: Property Layers

Four-layer configuration with most-specific-wins precedence:

1. **Wisp layer** (transient, local) — `<rig>/.beads-wisp/config/`. Temporary overrides. Never synced.
2. **Rig bead layer** (persistent, global) — Rig identity bead labels. Syncs via git.
3. **Town defaults** — `~/gt/config.json` or `~/gt/.beads/`.
4. **System defaults** — Compiled-in fallbacks.

Most properties use override semantics (first non-nil wins). Integer properties (like `priority_adjustment`) use stacking semantics (values add). Properties can be explicitly blocked from inheritance.

**Rig lifecycle controls**:

- `gt rig park` (local, ephemeral): Stop services, daemon won't restart. For local maintenance.
- `gt rig dock` (global, persistent): Set `status:docked` label on rig bead. Syncs to all clones.

### 16. Operational State

State transitions are recorded as event beads (immutable audit trail) and cached as labels on role beads (fast current-state queries).

Event types include: `patrol.muted`, `patrol.unmuted`, `agent.started`, `agent.stopped`, `mode.degraded`, `mode.normal`.

**Events are the source of truth. Labels are the cache.** This follows the "Discover, Don't Track" principle — the ledger of events is the ground truth, and labels are a performance optimization.

### 17. Agent Context Delivery

Agent context (role instructions, environment) is delivered via two mechanisms:

| Method                                 | Roles                           | How                                                                                     |
| -------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| **On-disk CLAUDE.md**                  | Mayor, Refinery                 | Written to the agent's working directory inside the git worktree                        |
| **Ephemeral injection via `gt prime`** | Deacon, Witness, Crew, Polecats | Injected at `SessionStart` hook. Not persisted to disk to avoid polluting source repos. |

**Sparse checkout** is used to exclude context files (`.claude/`, `CLAUDE.md`, `.mcp.json`) from source repos, ensuring agents use Gastown's context rather than the project's.

**Settings templates** differ by agent type:

- **Interactive** (Mayor, Crew): Mail injected on `UserPromptSubmit` hook
- **Autonomous** (Polecat, Witness, Refinery, Deacon): Mail injected on `SessionStart` hook

### 18. Formula Resolution Architecture

Formulas are resolved through a three-tier hierarchy:

1. **Project (rig-level)**: `<project>/.beads/formulas/` — committed to project repo, project-specific workflows
2. **Town (user-level)**: `~/gt/.beads/formulas/` — Mol Mall installs, user customizations
3. **System (embedded)**: Compiled into the `gt` binary — factory defaults, blessed patterns

Most-specific wins. Version pinning is supported (`bd cook mol-polecat-work@4.0.0`).

### 19. Federation (Design Spec — Not Yet Implemented)

Federation enables multiple Gastown instances to reference each other's work across organizations. It introduces:

- **HOP (Highway Operations Protocol) URIs**: `hop://entity/chain/rig/issue-id` for cross-workspace references
- **Employment relationships**: Track which entities belong to organizations
- **Cross-references**: Depend on work in another workspace
- **Delegation**: Distribute work across workspaces with terms
- **Discovery**: Workspace metadata (`.town.json`), remote registration, cross-workspace queries

### 20. The Seance System

`gt seance` allows agents to communicate with previous sessions. Each session has a startup nudge that becomes searchable. Agents can query predecessors for context and decisions from earlier work: `gt seance --talk <id> -p "Where is X?"`. This provides session-to-session continuity beyond the handoff mail system.

### 21. What the Cloud Proposal Must Faithfully Reproduce

Based on this analysis, the following Gastown concepts are load-bearing and must have clear cloud equivalents:

1. **Beads as the universal work unit** — git-backed JSONL in local Gastown; needs a cloud-native equivalent (currently: DO SQLite + Postgres read replica)
2. **Two-level architecture** (town vs rig) — distinct scoping for coordination vs implementation work
3. **All seven agent roles** with their distinct lifecycles and responsibilities
4. **The Hook + GUPP** — immediate autonomous execution when work is assigned
5. **Molecules** — durable multi-step workflows with crash recovery
6. **Convoys** — cross-rig batch work tracking with landing detection
7. **The mail protocol** — typed inter-agent messages with defined flows (POLECAT_DONE → MERGE_READY → MERGED)
8. **Identity and attribution** — every action attributed to a specific agent
9. **The watchdog chain** — multi-tier health monitoring (Daemon/Boot → Deacon → Witness)
10. **The escalation system** — severity-routed, tiered, auto-re-escalating
11. **The Refinery merge queue** — AI-powered quality gates with rework requests
12. **Property layers** — multi-level configuration with override/stack semantics
13. **Context delivery** — `gt prime` ephemeral injection vs on-disk CLAUDE.md
14. **Session cycling and handoff** — polecats cycle sessions freely; work survives
15. **Self-cleaning polecat model** — no idle state, polecats clean up after themselves
16. **Formula/Protomolecule/Molecule/Wisp lifecycle** — the full MEOW stack
17. **The plugin system** — extensible periodic maintenance with gate-based execution
18. **Beads-native messaging** — groups, queues, channels beyond simple mail

---

## Product Vision: The Browser-Based Gastown Experience

The end goal is a product that's **absurdly simple to use**. You create a town, connect your repos through Kilo's existing integrations system, and talk to the Mayor in a chat interface. Behind the scenes, the full Gastown machine operates — agents spawn, communicate, merge code — and the UI shows you everything that's happening in real time. Every object on screen is clickable. Every connection is traceable. The system is transparent.

This is not a "dashboard" bolted onto the backend. The UI _is_ the product. Everything about the architecture should be designed to serve this experience.

### Design Principles

1. **Chat-first interaction model.** The primary way you interact with Gastown is by talking to the Mayor in a conversational chat interface — the same quality as our existing Cloud Agent chat. You describe what you want. The Mayor delegates. You watch the machine work.

2. **Radical transparency.** The UI shows the living state of the system: agents spawning, beads flowing between states, mail being sent, molecules progressing through steps, convoys converging on landing. This isn't a status page. It's a real-time visualization of an agent orchestration system in motion.

3. **Everything is clickable.** Every bead, agent, convoy, mail message, molecule step, escalation, and log entry is a first-class interactive object. Click an agent to see its conversation stream, its current hook, its work history. Click a bead to see who created it, who's working on it, its event timeline, and its connections to other beads. Click a convoy to see all tracked beads across all rigs with progress.

4. **Progressive disclosure.** The top-level view is simple: your town, your rigs, the Mayor chat. But you can drill into any layer of detail — raw agent conversation logs, DO state, tool call traces, git diffs, mail messages, escalation history. The UI serves both the casual user ("just get this done") and the power user ("why did this agent stall at 14:32?").

5. **Zero configuration for the common case.** Creating a town and connecting a repo should take under 60 seconds. Kilo's existing GitHub/GitLab integrations handle auth. The Mayor is pre-configured. You type a message, and work starts. Advanced configuration (model selection, quality gates, polecat count, branch naming) is available but never required.

### The Core Screens

#### Town Home (`/gastown/[townId]`)

The town home is the **command center**. It has two halves:

**Left: The Mayor Chat** — A full-featured conversational chat interface (same quality and architecture as the existing Cloud Agent chat: Jotai atom store, WebSocket streaming, tool execution cards, message bubbles with markdown rendering). This is the primary interaction surface. You talk to the Mayor here. The Mayor responds conversationally, and when it decides to delegate work, you see it happen — tool calls like `gt_sling` appear in the chat as expandable cards, and the right side of the screen updates in real time.

**Right: The Town Dashboard** — A real-time overview showing:

- **Active Convoys** — Progress bars with bead counts (`3/5 closed`), linked bead list, time elapsed, notification subscribers. Click to drill into convoy detail.
- **Rig Cards** — One card per rig showing: name, repo, agent count, active bead count, Refinery merge queue depth. Click to drill into rig detail.
- **Activity Feed** — A live-streaming timeline of events across all rigs: beads created, agents spawned, mail sent, molecules advancing, escalations raised, merges completed. Each event is clickable to navigate to the relevant object.
- **Escalation Banner** — If any escalations are pending, they surface at the top with severity badges and one-click acknowledge.

This layout means you can chat with the Mayor and simultaneously see the effects of the conversation ripple through the system.

#### Rig Detail (`/gastown/[townId]/rigs/[rigId]`)

The rig detail is the **workbench** for a single project:

- **Bead Board** — A kanban-style board with columns: `Open`, `In Progress`, `In Review`, `Closed`. Each bead card shows title, assignee (agent avatar + name), priority badge, labels, time in status. Drag is not needed; the board is read-only but every card is clickable. Click a bead to open its detail panel.
- **Agent Roster** — Live agent cards arranged horizontally. Each card shows: agent name (e.g., "Toast"), role badge (polecat/witness/refinery), status indicator (working/idle/stalled), current hook (bead title), last activity timestamp, and a "Watch" button to open the agent's live stream.
- **Merge Queue** — A compact list showing pending reviews: branch name, polecat name, status (pending/running/merged/failed), submitted time. Click to see the full diff or review details.
- **Agent Stream Panel** — When you click "Watch" on an agent, a streaming panel opens showing the real-time conversation: user prompt (from the system), assistant responses, tool calls (file edits, git commands, test runs) with expandable input/output. This reuses the same streaming infrastructure as the Cloud Agent chat (WebSocket manager, event normalizer, message atoms) but in a read-only observer mode.

#### Bead Detail (slide-over panel)

Click any bead anywhere in the UI and a detail panel slides in:

- **Header**: Bead ID, type badge, status badge, priority, title
- **Body**: Full description/body text with markdown rendering
- **Connections**: Assignee agent (clickable), convoy membership (clickable), molecule attachment (clickable), parent/child beads
- **Event Timeline**: Append-only ledger — created, assigned, hooked, status changes, closed. Each event shows actor, timestamp, and old/new values.
- **Agent Activity**: If the bead is currently hooked by an agent, a compact live stream of that agent's recent activity
- **Raw Data**: Expandable section showing the raw bead JSON for debugging

#### Agent Detail (slide-over panel or full page)

Click any agent:

- **Identity**: Name, role, rig, full identity string, BD_ACTOR equivalent
- **Current State**: Status, current hook (bead), last activity, session info
- **Conversation Stream**: Full real-time or historical conversation log
- **Work History (CV)**: List of completed beads with completion time, quality signal, model used
- **Mail**: Recent sent/received mail messages
- **Performance**: Beads closed, average completion time, escalation rate, model comparison

#### Convoy Detail (slide-over or full page)

Click any convoy:

- **Progress**: Visual progress bar (`4/7 beads closed`), estimated completion
- **Tracked Beads**: List of all beads across all rigs, each with status badge and assignee. Beads are grouped by rig.
- **Timeline**: Event history — created, beads added, beads closed, landed
- **Notification Subscribers**: Who gets notified on landing

### Real-Time Streaming Architecture

The UI must feel alive. Three real-time channels:

1. **Agent conversation streams** — WebSocket per agent. Uses the existing `createWebSocketManager` infrastructure with ticket-based auth. The container's control server (`/agents/:agentId/stream-ticket`) provides tickets, and the dashboard connects directly. Events are normalized via `event-normalizer.ts` into the standard Cloud Agent message format, so the agent stream viewer can reuse the same `MessageBubble`, `MessageContent`, and `ToolExecutionCard` components.

2. **Town-wide event stream** — SSE or WebSocket from the Gastown Worker (backed by DO state changes). When any bead changes status, any agent spawns/dies, any mail is sent, any convoy updates — the event is pushed to all connected town dashboards. This drives the Activity Feed and all real-time badge/count updates. Implementation: DO writes to a durable event log; the worker exposes an SSE endpoint (`/api/towns/:townId/events`) that tails the log. Alternatively, use Cloudflare's WebSocket hibernation API on a dedicated DO for fan-out.

3. **Mayor conversation stream** — WebSocket to the MayorDO's kilo serve session. Same architecture as agent streams but persistent (the session doesn't die between messages). The Mayor chat component maintains a single long-lived WebSocket connection, reusing the existing `useCloudAgentStreamV2` hook pattern.

### Integrations: Connecting Repos to Rigs

Rig creation should leverage Kilo's existing integrations system rather than requiring raw git URLs:

- **Existing pattern**: The user has already installed the Kilo GitHub App (or connected GitLab) via `/integrations`. The platform knows their repositories.
- **Rig creation flow**: When creating a rig, the dialog shows a searchable list of connected repositories (from the existing `PlatformRepository` type). Selecting a repo auto-fills `gitUrl`, `defaultBranch`, and stores the integration reference for token management.
- **Token management**: The container needs git auth tokens to clone private repos. Since the user's GitHub App installation is already tracked, the backend can mint installation tokens on demand — the same `getGithubTokenForIntegration()` path used by Cloud Agent sessions. These tokens are short-lived and refreshed by the DO when arming agent dispatch.
- **Webhook integration**: Optionally, GitHub webhooks (already handled by the existing `webhook-handler.ts` infrastructure) can create beads automatically — e.g., new GitHub issues become Gastown beads, PRs merged externally update bead status. This is a natural extension of the existing webhook routing.

### The Local CLI Bridge (Future)

A stretch goal that makes the system dramatically more powerful: connecting your local Kilo CLI to your cloud Gastown instance.

**Concept**: You run `kilo` locally on your laptop. Instead of operating as a standalone agent, your local Kilo instance authenticates against your cloud Gastown town and becomes a **Crew member**. You get all the coordination benefits (beads, mail, identity, attribution, convoy tracking) while running locally with full filesystem access and your own dev environment.

**How it would work**:

- `kilo gastown connect <town-url>` authenticates and registers your local instance as a crew agent
- The gastown tool plugin loads with your cloud credentials (`GASTOWN_API_URL`, `GASTOWN_SESSION_TOKEN`)
- Your local Kilo session appears in the cloud dashboard as an active agent
- You can check mail, hook beads, send mail to cloud agents, participate in convoys
- Your work is attributed via `BD_ACTOR` through the cloud system
- The Witness can see your activity; you appear in the town's health monitoring

This bridges the gap between "fully cloud-hosted" and "I want to work locally but with cloud coordination." It's not required for the MVP but should inform the API design — the tool plugin's HTTP API surface is the same whether the agent runs in a Cloudflare Container or on someone's laptop.

---

**Key design decisions:**

- All orchestration state lives in Durable Objects (SQLite) + Postgres (read replica for dashboard)
- Agents interact with gastown via **tool calls** backed by DO RPCs — no filesystem coordination, no `gt`/`bd` binaries
- Each town gets a **Cloudflare Container** that runs all agent processes (Kilo CLI instances) — one container per town, not one per agent
- The DO is the **scheduler**: alarms scan for pending work and signal the container to start/stop agent processes
- The container is the **execution runtime**: it receives commands from the DO, spawns Kilo CLI processes, and routes tool calls back to the DO
- LLM calls route through the Kilo gateway (`KILO_API_URL`) using the owner's `kilocodeToken` (user JWT generated at rig creation)
- **Mayor is a town-level singleton** with a persistent conversational session in a dedicated `MayorDO` (keyed by `townId`). Messages to the mayor do NOT create beads — the mayor decides when to delegate work via tools (`gt_sling`, `gt_list_rigs`, etc.)
- **Rig-level agents** (Witness, Refinery, Polecats) are bead-driven and managed by the Rig DO alarm cycle
- Watchdog/health monitoring uses DO alarms — the DO can independently verify container health and re-dispatch work if the container dies
- The container uses **`kilo serve`** (Kilo's built-in HTTP server) instead of raw stdin/stdout process management — each agent is a session within a server instance, enabling structured messaging via HTTP API, real-time observability via SSE events, and clean session abort

**Architecture overview:**

```
┌──────────────┐     tRPC      ┌──────────────────┐
│   Dashboard  │◄─────────────►│   Next.js Backend │
│   (Next.js)  │               │                   │
└──────────────┘               └────────┬─────────┘
                                        │ internal auth
                                        ▼
                               ┌──────────────────┐
                               │  Gastown Worker   │
                               │  (Hono router)    │
                               └────────┬─────────┘
                                        │ DO RPC
                   ┌────────────────────┼────────────────────┐
                   ▼                    ▼                    ▼
             ┌──────────┐        ┌──────────┐         ┌──────────┐
             │  Rig DO  │        │ Mayor DO │         │ Town DO  │
             │ (SQLite) │        │(per town)│         │(convoys) │
             └─────┬────┘        └─────┬────┘         └──────────┘
                   │                   │
                   │ alarm fires → fetch()
                   ▼                   ▼
             ┌──────────────────────────────┐
             │       Town Container         │
             │  ┌────────────────────────┐  │
             │  │    Control Server      │  │
             │  └───────────┬────────────┘  │
             │              │               │
             │  ┌───────────┴────────────┐  │
             │  │    Agent Processes     │  │
             │  │  ┌──────────────────┐  │  │
             │  │  │ Mayor (session)  │  │  │  ◄── persistent, conversational
             │  │  │ Polecat1         │  │  │  ◄── bead-driven, ephemeral
             │  │  │ Polecat2         │  │  │
             │  │  │ Refinery         │  │  │
             │  │  └──────────────────┘  │  │
             │  └────────────────────────┘  │
             └──────────────────────────────┘
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

### PR 6.5: Container — Adopt `kilo serve` for Agent Management

**Status:** Next up. See `docs/gt/opencode-server-analysis.md` for the full analysis. Tracked as #305.

**Goal:** Replace the container's stdin/stdout-based agent process management with Kilo's built-in HTTP server (`kilo serve`). Currently, the container spawns `kilo code --non-interactive` as fire-and-forget child processes and communicates via raw stdin pipes. This is fragile and provides no structured observability into agent activity.

#### Architecture Change

```
Current:
  Container Control Server (port 8080)
    └── Bun.spawn('kilo code --non-interactive') × N agents
        └── stdin/stdout pipes

Proposed:
  Container Control Server (port 8080)
    └── kilo serve (port 4096+N) × M server instances (one per worktree)
        └── HTTP API for session management
        └── SSE for real-time events
```

Each agent becomes a **session** within a `kilo serve` instance rather than its own raw process. The control server becomes a thin proxy that:

- Starts `kilo serve` instances (one per worktree/repo context) using `createOpencodeServer()` from `@kilocode/sdk`
- Creates sessions for each agent via `POST /session`
- Sends prompts via `POST /session/:id/message` or `POST /session/:id/prompt_async`
- Subscribes to `/event` SSE streams for real-time observability (tool calls, completions, errors)
- Forwards structured status to the Gastown worker API heartbeat
- Uses `POST /session/:id/abort` for clean shutdown instead of SIGTERM

#### Component Changes

| Component                                 | Current                                           | After                                                             |
| ----------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `process-manager.ts`                      | Raw `Bun.spawn` child process management          | `kilo serve` instances via SDK, session-based agent tracking      |
| `agent-runner.ts`                         | Builds CLI args for `kilo code --non-interactive` | Creates sessions on running server, sends initial prompt via HTTP |
| `control-server.ts` `/agents/start`       | Spawns a process                                  | Creates a session on an existing (or new) server instance         |
| `control-server.ts` `/agents/:id/message` | Writes to stdin pipe                              | `POST /session/:id/message`                                       |
| `control-server.ts` `/agents/:id/status`  | Process lifecycle (pid, exit code)                | Session-level status with tool/message detail                     |
| `heartbeat.ts`                            | Reports process alive/dead                        | Reports session status + active tool calls from SSE events        |

#### What Stays the Same

- Git clone/worktree management (`git-manager.ts`)
- Container control server (port 8080) — same interface for TownContainer DO
- Agent environment variable setup for gastown plugin config
- Dockerfile — still needs `kilo` installed globally

#### Key Benefits

1. **Structured messaging** — HTTP API with typed request/response instead of raw stdin text
2. **Real-time observability** — SSE event stream gives visibility into tool calls, file edits, and errors
3. **Clean abort** — `POST /session/:id/abort` instead of SIGTERM
4. **Session lifecycle** — Fork, revert, diff inspection, todo tracking via server API
5. **SDK support** — `@kilocode/sdk` provides `createOpencodeServer()` for managed server lifecycle

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

  // -- Send message to Mayor (routes to MayorDO, no bead created) --
  sendMessage: protectedProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        message: z.string(),
        model: z.string().default('kilo/auto'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Routes to MayorDO.sendMessage() — NO bead created.
      // The mayor's persistent session receives the message as a follow-up.
      // The mayor decides whether to delegate work via tools (gt_sling, etc.)
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

### PR 8: Dashboard UI — Town Home, Rig Detail, and Mayor Chat

**Goal:** The primary user-facing surface. This is not a "basic" dashboard — it's the product. See the "Product Vision" section above for the full design rationale. Phase 1 implements the core screens with real-time streaming.

#### Pages

| Route                            | Component  | Purpose                                                   |
| -------------------------------- | ---------- | --------------------------------------------------------- |
| `/gastown`                       | Town list  | List user's towns, create new town                        |
| `/gastown/[townId]`              | Town home  | Split view: Mayor chat (left) + town dashboard (right)    |
| `/gastown/[townId]/rigs/[rigId]` | Rig detail | Bead board, agent roster, merge queue, agent stream panel |

#### Town Home — Mayor Chat + Dashboard

The town home is a split-pane layout:

**Left pane: Mayor Chat** — A full-featured conversational chat interface. Reuses the existing Cloud Agent chat architecture:

- Jotai atom store for message state (`CloudAgentProvider` pattern)
- WebSocket streaming via `createWebSocketManager` with ticket-based auth
- `MessageBubble` components with user/assistant layouts, markdown rendering
- `ToolExecutionCard` for mayor tool calls (`gt_sling`, `gt_list_rigs`, etc.) — these expand to show what the Mayor delegated and to which rig/agent
- Status indicator showing mayor session state (idle/active/starting)
- `sendMessage` tRPC mutation routes to `MayorDO.sendMessage()`, no bead created

**Right pane: Town Dashboard** — Real-time overview:

- **Rig cards**: One card per rig (name, repo link, agent count badge, active bead count, refinery queue depth). Click navigates to rig detail.
- **Active convoys**: Progress bars with `closed/total` counts, time elapsed. Click opens convoy detail panel.
- **Activity feed**: Live-streaming event timeline (SSE from gastown worker). Events: bead state changes, agent spawns/exits, mail sent, molecules advancing, merges, escalations. Each event is clickable → navigates to the relevant object.
- **Escalation banner**: Surfaces unacknowledged escalations at the top with severity badges.

#### Rig Detail

- **Bead board**: Kanban columns (`Open` → `In Progress` → `In Review` → `Closed`). Each bead card: title, assignee avatar + name, priority badge, labels, time-in-status. Click opens bead detail slide-over.
- **Agent roster**: Horizontal agent cards. Each: name, role badge, status indicator (animated for working), current hook bead title, last activity time, "Watch" button.
- **Merge queue**: Compact list of pending reviews (branch, polecat, status, time).
- **Agent stream panel**: Opens when "Watch" is clicked. Read-only real-time conversation stream — reuses `MessageBubble`, `MessageContent`, `ToolExecutionCard` components from Cloud Agent chat in observer mode. WebSocket via `getAgentStreamUrl` → container stream ticket.

#### Slide-Over Detail Panels

Click any object in the UI to open a detail panel (sheet component from existing shadcn/ui):

- **Bead detail**: ID, type/status/priority badges, body (markdown), connections (assignee, convoy, molecule), event timeline (append-only ledger), raw JSON toggle.
- **Agent detail**: Identity, current state, conversation stream (live or historical), work history (CV — completed beads with time/quality), recent mail, performance stats.
- **Convoy detail**: Progress bar, tracked beads grouped by rig with status badges, timeline, notification subscribers.

#### Rig Creation via Integrations

The "Create Rig" dialog uses Kilo's existing integrations to browse connected repos:

- If user has GitHub App installed: show searchable repo list from `PlatformRepository`
- Selecting a repo auto-fills `gitUrl`, `defaultBranch`
- Stores integration reference for container token management (reuse `getGithubTokenForIntegration()`)
- Falls back to manual git URL entry if no integration connected

#### Real-Time Event Stream (Town-Wide)

New tRPC subscription or SSE endpoint: `GET /api/towns/:townId/events`

- Backed by DO state changes — when any bead/agent/mail/convoy updates, event is pushed
- Drives the activity feed, all badge/count updates, and bead board auto-refresh
- Implementation options: (a) SSE from gastown worker tailing a DO event log, (b) WebSocket hibernation API on a dedicated fan-out DO. Option (a) for Phase 1.

#### New tRPC Procedures Needed

| Procedure               | Type             | Purpose                                    |
| ----------------------- | ---------------- | ------------------------------------------ |
| `getConvoys`            | query            | List convoys for a town (with bead counts) |
| `getConvoy`             | query            | Single convoy with all tracked beads       |
| `getBeadEvents`         | query            | Append-only event history for a bead       |
| `getAgentHistory`       | query            | Completed beads for an agent (CV)          |
| `getAgentMail`          | query            | Recent mail for an agent                   |
| `getTownEvents`         | subscription/SSE | Real-time event stream for the town        |
| `acknowledgeEscalation` | mutation         | Mark escalation as acknowledged            |

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

### PR 10.5: Town Configuration — Environment Variables & Settings

**Goal:** A configuration screen that lets users set environment variables and settings at the town level and per-agent, enabling manual token configuration (e.g., GitHub/GitLab API tokens for git operations) and other runtime configuration before the full integrations-based flow exists.

This is the **highest priority item in Phase 2** because it unblocks manual configuration of git auth tokens that the container's `git-manager.ts` needs for clones and pushes to private repos. Until the integrations-based repo connection (PR 10.6) is complete, users need a way to manually provide a GitHub PAT or GitLab token.

#### Configuration Model

Town configuration lives in two places:

1. **Town-level config** — Stored in the Town DO (and mirrored to Postgres `gastown_towns.config`). Applies to all agents in all rigs unless overridden.
2. **Agent-level overrides** — Stored per-agent in the Rig DO. Overrides town-level values for a specific agent.

```typescript
type TownConfig = {
  // Environment variables injected into all agent processes
  env_vars: Record<string, string>;

  // Git authentication (used by git-manager.ts for clone/push)
  git_auth?: {
    github_token?: string; // GitHub PAT or installation token
    gitlab_token?: string; // GitLab PAT or OAuth token
    gitlab_instance_url?: string; // For self-hosted GitLab
  };

  // Default model for new agent sessions
  default_model?: string;

  // Polecat limits
  max_polecats_per_rig?: number;

  // Refinery configuration
  refinery?: {
    gates: string[]; // e.g., ["npm test", "npm run build"]
    auto_merge: boolean;
    require_clean_merge: boolean;
  };

  // Alarm intervals (seconds)
  alarm_interval_active?: number; // Default: 30
  alarm_interval_idle?: number; // Default: 300

  // Container settings
  container?: {
    sleep_after_minutes?: number; // Default: 30
  };
};

type AgentConfigOverrides = {
  env_vars?: Record<string, string>; // Merged with town-level (agent wins)
  model?: string; // Override default model
};
```

#### Configuration Inheritance

When the container starts an agent process, environment variables are resolved in order (last wins):

1. System defaults (GASTOWN_API_URL, GASTOWN_SESSION_TOKEN, etc.)
2. Town-level `env_vars`
3. Town-level `git_auth` (mapped to GIT_TOKEN, GITLAB_TOKEN, etc.)
4. Agent-level `env_vars` overrides

This means a user can set `GITHUB_TOKEN` at the town level and all polecats/refinery agents will use it for git operations. Or they can override it per-agent if different repos need different tokens.

#### Container Integration

The `git-manager.ts` currently calls `git clone` without auth. With town config:

1. The Rig DO reads town config (via Town DO RPC or cached) when dispatching an agent
2. `git_auth.github_token` is passed as an env var to the container's agent process
3. `git-manager.ts` uses the token to construct authenticated git URLs:
   - GitHub: `https://x-access-token:{token}@github.com/{owner}/{repo}.git`
   - GitLab: `https://oauth2:{token}@gitlab.com/{owner}/{repo}.git`

#### Dashboard UI

A new **Settings** page in the town sidebar (`/gastown/[townId]/settings`):

- **Environment Variables** — Key-value editor with add/remove. Sensitive values (tokens) are masked after save. Supports both town-level and per-rig/per-agent overrides.
- **Git Authentication** — Dedicated section with labeled inputs for GitHub token, GitLab token, GitLab instance URL. Helper text explaining what each token is used for and how to generate one.
- **Agent Defaults** — Default model selector, max polecats per rig slider, alarm intervals.
- **Refinery Gates** — List editor for quality gate commands.
- **Container** — Sleep timeout configuration.

#### tRPC Procedures

| Procedure           | Type     | Purpose                                  |
| ------------------- | -------- | ---------------------------------------- |
| `getTownConfig`     | query    | Read town configuration                  |
| `updateTownConfig`  | mutation | Update town-level config (partial merge) |
| `getAgentConfig`    | query    | Read agent-level overrides               |
| `updateAgentConfig` | mutation | Update per-agent overrides               |

#### Security

- Sensitive values (tokens, secrets) are stored encrypted in the DO and Postgres.
- The dashboard masks sensitive values after save (show last 4 chars only).
- Agent-level overrides are restricted to the town owner.
- Environment variable keys are validated (alphanumeric + underscore, no reserved prefixes like `GASTOWN_`).

---

### PR 10.6: Integrations-Based Repo Connection

**Goal:** Allow users to connect rigs to repositories via Kilo's existing integrations system (GitHub App, GitLab OAuth) instead of raw git URLs, enabling automatic token management and repo discovery.

This builds on the manual token configuration from PR 10.5 — once integrations are wired, the git auth tokens are managed automatically and the manual `git_auth` config becomes a fallback for repos not covered by an integration.

#### How It Works

Kilo already has a mature integrations system:

- **GitHub**: Users install the KiloConnect GitHub App (standard or lite). The platform stores the `platform_installation_id`. Tokens are generated on-demand via `generateGitHubInstallationToken()` using the App's private key — no tokens stored in the database.
- **GitLab**: Users connect via OAuth. Access/refresh tokens are stored in `platform_integrations.metadata`. Tokens are auto-refreshed when expired via `getValidGitLabToken()`.

The integration system is already used by Cloud Agent sessions for git auth. Gastown rigs should use the same path.

#### Rig Creation Flow (Updated)

When creating a rig, the dialog offers two paths:

1. **Integration-based** (preferred): If the user has a GitHub App or GitLab OAuth integration active, show a searchable repo picker populated from `PlatformRepository[]` cached on the integration. Selecting a repo auto-fills:
   - `git_url` (constructed from the platform + repo full_name)
   - `default_branch` (fetched from the platform API)
   - `platform_integration_id` (FK to `platform_integrations.id`)

2. **Manual** (fallback): Raw git URL input + manual branch. Requires a token in town config (PR 10.5) for private repos.

#### Token Lifecycle for Rigs

When the Rig DO needs to dispatch an agent:

1. Check if the rig has a `platform_integration_id`
2. If yes:
   - **GitHub**: Call `generateGitHubInstallationToken(installationId, appType)` to mint a short-lived token. Pass to the container as `GIT_TOKEN` env var.
   - **GitLab**: Call `getValidGitLabToken(integration)` to get/refresh the OAuth token. Pass to the container as `GIT_TOKEN` env var.
3. If no: Fall back to town-level `git_auth` config from PR 10.5.

Token refresh for long-running containers: The control server periodically requests fresh tokens from the gastown worker API (which proxies to the integration helpers). This is needed because GitHub installation tokens expire after 1 hour and GitLab OAuth tokens have configurable expiry.

#### Schema Changes

Add to `gastown_rigs` (both Postgres and Rig DO SQLite):

```sql
ALTER TABLE gastown_rigs ADD COLUMN platform_integration_id UUID
  REFERENCES platform_integrations(id);
```

The rig stores which integration was used to connect it. This is used at dispatch time to determine how to mint git tokens.

#### Worker Changes

New internal endpoint on the gastown worker:

```
POST /api/internal/rigs/:rigId/git-token
```

Called by the control server inside the container when it needs a fresh git token. The worker:

1. Reads the rig's `platform_integration_id` from the Rig DO
2. Loads the integration from Postgres
3. Mints/refreshes a token using the existing helpers
4. Returns `{ token, expires_at }`

The control server caches tokens and refreshes 5 minutes before expiry.

#### Dashboard Changes

- **Create Rig dialog**: Integration-aware repo picker (reuse existing `RepositorySelector` component pattern from Cloud Agent). Falls back to manual URL input.
- **Rig settings**: Show which integration is connected, with a "Reconnect" option if the integration is suspended/removed.
- **Town settings**: "Connect Integration" link that navigates to `/integrations` if no integration exists.

#### Webhook Integration (Future Enhancement)

Once rigs are connected via integrations, GitHub/GitLab webhooks can automatically create beads:

- New GitHub issue → create Gastown bead
- PR merged externally → update bead status
- Push to default branch → trigger refinery check

This reuses the existing `webhook-handler.ts` infrastructure. Not in scope for this PR but the `platform_integration_id` FK enables it.

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

### PR 8: MayorDO — Town-Level Conversational Agent (#338)

> **Revised (Feb 2026):** The Mayor was previously designed as a per-rig, demand-spawned ephemeral agent (old #222). This has been superseded. The Mayor is now a **town-level singleton** with a **persistent conversational session** in a dedicated `MayorDO`, matching the [Gastown architecture spec](https://docs.gastownhall.ai/design/architecture/).

**Goal:** Extract the Mayor to a dedicated `MayorDO` keyed by `townId`. The mayor maintains a persistent kilo serve session across messages. User messages route directly to the session — no bead is created. The mayor uses tools to delegate work when it decides to.

#### MayorDO Design

```typescript
type MayorConfig = {
  townId: string;
  userId: string;
  kilocodeToken?: string;
};

type MayorSession = {
  agentId: string; // mayor agent ID in the container
  sessionId: string; // kilo serve session ID
  status: 'idle' | 'active' | 'starting';
  lastActivityAt: string;
};
```

Key RPC methods: `configureMayor`, `sendMessage`, `getMayorStatus`, `destroy`.

#### Message Flow (Before → After)

**Before:** `sendMessage` → create bead → hook to mayor → alarm → dispatch → new session → complete → destroy
**After:** `sendMessage` → `MayorDO.sendMessage()` → follow-up to existing session → mayor responds conversationally

The mayor session is created on first message and reused for all subsequent messages. No bead is created. The mayor decides when to delegate work via tools.

#### Wrangler Changes

New DO binding `MAYOR` for `MayorDO`, new migration tag `v3`.

---

### PR 8.5: Mayor Tools — Cross-Rig Delegation (#339)

**Goal:** Give the Mayor tools to delegate work across rigs. Without tools, the mayor is just a chatbot. With tools, it becomes the town coordinator.

#### Tools

| Tool               | Description                                 | Proxies to                    |
| ------------------ | ------------------------------------------- | ----------------------------- |
| `gt_sling`         | Sling a task to a polecat in a specific rig | `RigDO.slingBead(rigId, ...)` |
| `gt_list_rigs`     | List all rigs in the town                   | `GastownUserDO.listRigs()`    |
| `gt_list_beads`    | List beads in a rig (filterable by status)  | `RigDO.listBeads(filter)`     |
| `gt_list_agents`   | List agents in a rig                        | `RigDO.listAgents(filter)`    |
| `gt_mail_send`     | Send mail to an agent in any rig            | `RigDO.sendMail(...)`         |
| `gt_convoy_create` | Create a convoy tracking multiple beads     | Future — convoy system        |

Tools are HTTP endpoints on the Gastown worker, called by the mayor's kilo serve process using `GASTOWN_SESSION_TOKEN` for auth. The mayor's system prompt describes available tools and when to use them.

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

### PR 20: Dashboard — Deep Drill-Down and Visualization

**Goal:** Elevate the dashboard from functional to genuinely great. Every Gastown concept should be visually represented and interactively explorable.

#### Sidebar

When you launch a Town's UI, our main app's sidebar nav should smoothly animate its contents to reveal the new Gastown Town sidebar UI (with a back to towns link which will slide the normal kilo nav back in).

Inside of this sidebar will be all of the important items for your town:

- Overview
- Mail
- Beads
- Merge Queue
- Agents
- Observability (this would be logs, metrics, analytics, etc)
- ... And anything else you think is important or top-level interaction

#### Fullscreen App

Unlike other sections of the kilo dash, Gastown should behave like an information-dense, full screen application. With information flowing autonomously and smoothly animating throughout. The user should see the objects of the system, know how to manipulate them, and intuitively be able to trace the flow from one object to another through a graph/pane interface that allows for seamless navigation.

#### Convoy Visualization

- **Convoy timeline view**: A horizontal timeline showing bead completion events over time, with agent avatars at each completion point. Shows velocity and parallelism.
- **Convoy dependency graph**: If beads have dependencies, render them as a DAG. Completed nodes are green, in-progress yellow, blocked red.
- **Stranded convoy detection**: Surface convoys where beads are open but no agents are assigned. Prompt user to sling.

#### Agent Conversation History

- **Full conversation replay**: Store agent conversation events in R2 (keyed by `townId/rigId/agentId/sessionId`). The agent detail panel can load and replay any past session.
- **Search across conversations**: Full-text search over agent conversations within a rig. "What did Toast do about the auth module?"
- **Session timeline**: Show all sessions for a polecat identity (Toast session 1, 2, 3...) with handoff points marked.

#### System Topology View

- **Town map**: A visual graph showing the town's topology — Mayor at the center, rigs radiating outward, agents within each rig, with animated connections showing active mail/communication flows. This is the "see the machine working" view.
- **Mail flow visualization**: Arrows between agents showing recent mail. Click an arrow to see the message. POLECAT_DONE → MERGE_READY → MERGED flow becomes visually obvious.

#### Cost and Performance

- **Cost dashboard**: LLM cost per town/rig/agent/bead. Breakdown by model. Comparison over time.
- **Performance cards**: Agent performance (beads closed, avg time, quality rate), model comparison (same work type, different models → which performs better).
- **Cost per bead**: LLM usage from gateway, attributed to specific agents and beads.
- **Container cost**: Cloudflare container uptime cost attributed to the town.

#### Molecule Visualization

- **Molecule progress stepper**: When a bead has an attached molecule, show a step-by-step progress indicator (like a checkout flow) in the bead detail panel. Completed steps show summary, current step pulses, future steps are dimmed.
- **Formula library browser**: Browse available formulas with descriptions and step previews.

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

**Goal:** A user with zero Gastown knowledge should go from sign-in to watching an agent write code in under 2 minutes.

#### "Create Your First Town" Wizard

1. **Name your town** — Single text input with sensible default (e.g., user's name + "-town"). One click.
2. **Connect a repo** — If GitHub App already installed: show repo picker (existing `PlatformRepository` search). If not: "Install GitHub App" button → OAuth flow → return to picker. GitLab path identical. Manual git URL as escape hatch.
3. **First task** — Pre-populated prompt: "Describe something you'd like done in this repo." Large textarea, feels like the start of a conversation. Submit button says "Tell the Mayor".
4. **Watch it work** — Redirect to town home. Mayor chat shows the message being processed. Right pane shows the activity feed lighting up: agent spawning, bead created, work starting. The "aha moment" happens here — the user sees the machine come alive.

#### Progressive Feature Discovery

After the first task completes:

- **Tooltip on convoy**: "This tracked your task. Create convoys to batch related work."
- **Tooltip on agent card**: "This polecat worked on your task. Click to see its full conversation."
- **Tooltip on merge queue**: "Your code changes are reviewed here before merging."
- **Prompt in Mayor chat**: "You can also ask me to work on multiple things at once, check on progress, or coordinate across repos."

The goal is not documentation. It's in-context discovery as the user naturally explores.

### PR 25: Documentation & API Reference

- Internal: architecture doc, DO state schemas, tool plugin API, container control server API
- External: user guide for hosted gastown

---

## Open Questions

1. **Container sizing**: A `standard-4` (4 vCPU, 12 GiB, 20 GB disk) may not be enough for towns with many concurrent agents. Custom instance types now support up to 4 vCPU max. For large towns, we may need to shard across multiple containers (container-per-rig instead of container-per-town). This should be measured in stress testing (PR 21) before over-engineering.

2. **Agent event streaming architecture**: How do we stream Kilo CLI output from the container to the dashboard? Options:
   - **(a) Container WebSocket per agent, dashboard connects directly** — Simplest for Phase 1. Each agent has a stream ticket. Dashboard opens one WebSocket per watched agent. Uses existing `createWebSocketManager` infrastructure. Downside: events lost if container restarts mid-stream.
   - **(b) Container → DO → Dashboard via WebSocket hibernation API** — More durable. Container forwards all events to the DO. DO persists to event log and fans out to connected dashboard clients via hibernatable WebSocket. Events survive container restart. More complex but enables conversation replay.
   - **(c) Hybrid** — Phase 1 uses (a) for live streaming. R2 persists events for replay. Town-wide event stream uses SSE from the worker (not per-agent WebSocket). Phase 3 migrates to (b) for full durability.
   - **Recommendation**: Option (c). Live agent streams connect directly to container (fast, simple). Town-wide activity feed uses SSE from the worker. R2 stores conversation history for replay.

3. **Git auth in the container**: The container needs to clone private repos. Options:
   - Pass GitHub App installation tokens via env vars (short-lived, minted by the Next.js backend when arming the alarm)
   - Store encrypted tokens in DO, container fetches on startup
   - Use a service binding to the existing GitHub token infrastructure
   - **Recommendation**: Reuse the existing `getGithubTokenForIntegration()` path from Cloud Agent. The rig stores its integration reference (GitHub App installation ID). The DO mints tokens on demand when dispatching agents. Tokens are passed as env vars to kilo serve processes. For long-running containers, the control server refreshes tokens periodically via the gastown worker API.

4. **Container cold start impact**: When a container sleeps and wakes, all repos need to be re-cloned. For large repos this could take minutes. Mitigations:
   - Aggressive `sleepAfter` (30+ min) so active towns don't sleep
   - Shallow clones (`--depth 1`) for initial clone, fetch full history only when needed
   - R2 git bundle snapshots for fast restore
   - Pre-warm containers when a user navigates to their town dashboard

5. **DO storage limits**: Durable Object SQLite has a 10GB limit. A rig with thousands of beads over months could approach this. Archival strategy: periodically move closed beads to Postgres and purge from DO SQLite. The DO is the hot path; Postgres is the cold archive.

6. **Billing model**: Per-agent-session LLM costs are already tracked via the gateway. Container costs are per-town (metered by Cloudflare). Do we add gastown-specific billing (per-bead, per-convoy, per-town monthly fee) or just pass through LLM + container costs?

7. **Refinery quality gates**: Should quality gates run inside the refinery agent's Kilo CLI session (agent runs `npm test`)? Or should they be a separate deterministic step (container runs tests directly, only invokes AI if tests fail)? The latter is cheaper and faster for the common case (tests pass). The AI agent is only needed for reasoning about failures.

8. **Local CLI bridge API surface**: The tool plugin's HTTP API (`GASTOWN_API_URL` + JWT) is the same whether the agent runs in a Cloudflare Container or on someone's laptop. Should we design the API with the local bridge in mind from day one? This means: (a) the gastown worker needs a public-facing auth mode (not just internal + container JWT), (b) agent registration needs to support "external" agents that don't run in the container, (c) the Witness needs to tolerate agents it can't directly observe via the container. Recommendation: design the API for it now, implement the local bridge later.

9. **Mayor chat UX for long-running delegation**: When the Mayor decides to delegate (calls `gt_sling`), the polecat may take 10+ minutes. The Mayor should respond immediately ("I've assigned Toast to work on that. You can watch progress in the dashboard.") rather than blocking the chat. This means the Mayor's tool calls must be non-blocking from the user's perspective — the Mayor responds conversationally about what it did, and the dashboard shows the async result. This is a system prompt / tool design concern, not just a UI concern.

---

## Architecture Assessment: Will This Work?

> This section is a critical assessment of the current implementation and proposed architecture, measured against the full scope of what Gastown actually is (as documented in the "What Is Gastown?" section) and the UI vision (as documented in the "Product Vision" section). The question: does the current architecture get us where we need to go, or are there structural problems?

### What's Built and Working Well

The core loop is solid. The Rig DO is a well-implemented state machine (~1,585 lines) with alarm-based scheduling, witness patrol, circuit breaker for dispatch failures, and the full beads/agents/mail/review-queue data model in SQLite. The container implementation is genuinely impressive — it has fully adopted `kilo serve` with proper session management, SSE event consumption, per-worktree server instances, and a clean agent runner that handles git clone → worktree → start. The tool plugin (8 tools) is production-quality with comprehensive tests, JWT auth, and prompt injection security. The Mayor DO has a working persistent conversational session model. The integration tests cover the critical paths.

**In short**: the plumbing works. A user can sling a bead, the alarm fires, a polecat spawns in the container, works on the code via kilo serve, and reports back. This is a functional MVP core loop.

### Structural Issues That Need Addressing

#### 1. The Witness is Not an Agent — It's Hardcoded in the Alarm

In real Gastown, the Witness is a **per-rig persistent AI agent** that monitors polecats, nudges stuck workers, handles cleanup, and triggers escalations. It runs in its own tmux session, receives `POLECAT_DONE` mail, verifies work, sends `MERGE_READY` to the Refinery, and can be nudged/communicated with.

In the cloud implementation, the Witness is **not an agent at all**. It's a Go-style function (`witnessPatrol()`) hardcoded into the Rig DO's alarm handler. It checks for dead/stale agents, resets them to idle, and sends GUPP_CHECK mail. This is the "ZFC" pattern from Gastown's daemon — mechanical transport, not intelligent triage.

**Why this matters**: The Witness's value in Gastown is its ability to _reason about why an agent is stuck_ — is it thinking deeply, waiting on a long tool call, or actually hung? A Go-style function can only check thresholds. For the cloud product, where users are watching the dashboard, a visible Witness agent that can be observed making decisions ("I noticed Toast hasn't made progress in 20 minutes, sending a nudge") is dramatically more transparent than a silent alarm handler.

**Recommendation**: For Phase 1, the alarm-based witness is fine. For Phase 2+, the Witness should become an actual agent session in the container — a kilo serve session with a witness system prompt and patrol molecule. It receives mail, checks polecats, sends mail. Its conversation stream is visible in the dashboard.

#### 2. The Refinery Has No Implementation

The review queue exists in the Rig DO (5 methods: submit, pop, complete). The alarm handler calls `processReviewQueue()` which calls `startMergeInContainer()`. But the container's control server has **no `/merge` endpoint** — the call will 404. There is no refinery agent, no quality gate logic, no merge execution.

This is acknowledged as Phase 2 work, but it means the full polecat→done→merge→closed loop is broken. Polecats can call `gt_done`, work gets submitted to the review queue, and then it sits there forever. The bead never reaches `closed` status through the merge path.

**Recommendation**: PR 9 (Manual Merge Flow) needs to be prioritized before the product is usable. At minimum: a `/merge` endpoint on the control server that does a deterministic `git merge --no-ff`, and the alarm handler that calls it. The AI refinery agent can come later.

#### 3. No Town DO Means No Cross-Rig Coordination

The proposal lists a Town DO for convoy lifecycle, escalation routing, and cross-rig coordination. In the current implementation, there is no Town DO — `GastownUserDO` handles town/rig CRUD but has zero coordination logic. Convoys don't exist in the system at all (the `convoy_id` column exists on beads but nothing populates it).

For a single-rig town, this is fine. For the "talk to the Mayor and it coordinates across multiple repos" vision, this is a structural gap.

**Recommendation**: The Town DO should be implemented before multi-rig support. The convoy system is core to the Gastown experience and the dashboard (convoy progress bars, landing detection, cross-rig tracking). Without convoys, work is tracked per-rig with no cross-rig visibility.

#### 4. The Mayor Has No Tools

The MayorDO has a working persistent conversational session. The `sendMessage` flow works: user types → MayorDO → container → kilo serve → Mayor responds. But the Mayor has no tools to actually do anything. It's a chatbot, not a coordinator.

PR 8.5 (Mayor Tools — `gt_sling`, `gt_list_rigs`, `gt_list_beads`, `gt_list_agents`, `gt_mail_send`) is listed as the next uncompleted issue (#339). Without these tools, the Mayor cannot delegate work, which is the entire point of the chat-first interaction model in the product vision.

**Recommendation**: Mayor tools are the highest-priority remaining work for the product vision. The Mayor chat is the primary interaction surface — if it can't delegate, the product doesn't function.

#### 5. No Postgres Read Replica — Dashboard Reads Hit DOs Directly

The proposal describes Postgres as a read replica for the dashboard. In reality, there are **zero Gastown tables in Postgres**. All dashboard reads go: `tRPC → gastown-client → worker → DO RPC`. This means every dashboard page load sends HTTP requests to the Cloudflare worker, which does DO RPCs to get data.

For a single user with one town, this is fine. But:

- DO RPCs are billed per-request. Heavy dashboard polling multiplies cost.
- There's no way to do cross-town queries (e.g., "show all my beads across all rigs") without fanning out to every DO.
- The activity feed (real-time event stream) has nowhere to read from — there's no event log in the DOs, and no SSE endpoint on the worker.

**Recommendation**: For Phase 1, direct DO reads are acceptable. But the town-wide event stream needed for the activity feed requires either: (a) the Rig DO writing events to a log table that the worker can tail via SSE, or (b) a dedicated event fan-out DO. This should be designed now, not deferred to Phase 4.

#### 6. Agent Streaming Is Incomplete

The container creates stream tickets (UUIDs with 60s TTL), and the worker handler constructs stream URLs. But the actual WebSocket endpoint that would consume these tickets and stream SSE events to the browser **does not exist** in the container. The `AgentStream.tsx` component connects via EventSource to a URL that returns nothing.

This is the most visible gap for the product vision. The "watch an agent work" experience requires working streaming.

**Recommendation**: This needs to be unblocked. The container already consumes SSE from kilo serve and tracks events per-session. The missing piece is a `GET /agents/:agentId/stream` endpoint on the control server that validates a stream ticket and proxies the relevant kilo serve SSE events. This is a moderate implementation effort with a high product impact.

#### 7. The Polecat System Prompt Is Not Used

There is a detailed polecat system prompt (`prompts/polecat-system.prompt.ts`) that includes GUPP instructions, tool documentation, and workflow guidance. But the Rig DO's `systemPromptForRole('polecat')` returns a different, much simpler prompt. The detailed prompt is unused.

**Recommendation**: Wire the detailed prompt into the dispatch path. The polecat's effectiveness depends heavily on its system prompt — the GUPP principle, molecule navigation, and tool usage instructions are critical.

#### 8. Molecules Exist in Schema Only

The `molecules` table is created in every Rig DO, and `MoleculeStatus` exists in types, and `molecule_id` exists on beads. But no RPC methods create, query, or advance molecules. The `gt_mol_current` and `gt_mol_advance` tools don't exist in the plugin.

Molecules are how Gastown breaks complex work into trackable multi-step workflows. Without them, polecats get a single bead with a title and body, and have no structured way to navigate complex tasks.

**Recommendation**: Molecules are Phase 2 (PR 14) in the proposal. This is reasonable — single-step beads work for the MVP. But the molecule system is core to Gastown's "MEOW" principle and should be designed to work with the UI (molecule progress stepper, step-by-step visualization).

#### 9. The `kilo serve` Server-Sharing Problem

Multiple agents in the same worktree share a single `kilo serve` process. The plugin reads `GASTOWN_AGENT_ID` from `process.env`, which is set once when the server starts. If two polecats share a server, the second agent's sessions will see the first agent's ID in the plugin.

In practice, each polecat gets its own branch and worktree, so server sharing shouldn't occur for polecats. But the Witness and Refinery, if implemented as agent sessions, would share the rig's main branch worktree. If they're both sessions on the same kilo serve instance, their plugins will read the wrong agent ID.

**Recommendation**: Either ensure each agent role gets its own worktree (even if Witness and Refinery use main), or pass `GASTOWN_AGENT_ID` per-session rather than per-server. The latter requires a plugin change to read from session config instead of process.env.

#### 10. No Event Log for the Dashboard

The product vision requires a live activity feed showing "beads created, agents spawned, mail sent, molecules advancing, merges completed." But there is no event log anywhere in the system. The Rig DO mutates state (creates beads, updates statuses, sends mail) but doesn't write an append-only event stream. The `gastown_bead_events` table exists in the Postgres schema in the _proposal_ but not in the actual DO SQLite or anywhere in the implementation.

**Recommendation**: Add a `bead_events` table to the Rig DO SQLite (append-only: `{id, bead_id, agent_id, event_type, old_value, new_value, metadata, created_at}`). Every state mutation writes an event. The worker exposes a `/api/rigs/:rigId/events?since=<timestamp>` endpoint. The town-wide feed fans out across all rig DOs. This is the backbone of the real-time dashboard.

### Assessment Summary

| Aspect                                                    | Status         | Verdict                                                        |
| --------------------------------------------------------- | -------------- | -------------------------------------------------------------- |
| Core loop (sling → alarm → dispatch → agent works → done) | ✅ Implemented | Works, needs Refinery endpoint to close the loop               |
| Rig DO state machine                                      | ✅ Solid       | Production-quality, well-tested                                |
| Container + kilo serve                                    | ✅ Solid       | Fully adopted, clean architecture                              |
| Tool plugin                                               | ✅ Complete    | 8 tools, good tests, security boundaries                       |
| Mayor persistent session                                  | ✅ Working     | Session lifecycle, health monitoring                           |
| Mayor tools (delegation)                                  | ❌ Missing     | #339 — highest priority for product vision                     |
| Agent streaming to browser                                | ❌ Incomplete  | Stream tickets exist but no WebSocket/SSE endpoint serves them |
| Refinery / merge flow                                     | ❌ Missing     | Container has no `/merge` endpoint; review queue is a dead end |
| Witness as agent                                          | ⚠️ Alarm-only  | Works mechanically but not transparent/observable              |
| Town DO / convoys                                         | ❌ Missing     | No cross-rig coordination, no convoy tracking                  |
| Event log for dashboard                                   | ❌ Missing     | No append-only event stream for real-time feed                 |
| Postgres read replica                                     | ❌ Not started | All reads go through DO RPCs                                   |
| Molecules                                                 | ⚠️ Schema only | Table exists, no business logic                                |
| Polecat system prompt                                     | ⚠️ Not wired   | Detailed prompt exists but isn't used                          |
| Identity / attribution                                    | ⚠️ Partial     | `GIT_AUTHOR_NAME` is set but no CV / AgentIdentity tracking    |

### Recommended Priority Adjustments

The current phase ordering puts UI (PR 8), merge flow (PR 9), and multi-agent (Phase 2) in sequence. Given the product vision, the priorities should shift:

1. **Mayor tools (#339)** — Without tools, the chat-first experience doesn't work.
2. **Agent streaming endpoint** — Without streaming, "watch an agent work" doesn't work.
3. **Merge endpoint on container** — Without this, the polecat→merge→closed loop is broken.
4. **Event log in Rig DO** — Required for the real-time activity feed.
5. **Wire the detailed polecat system prompt** — Low effort, high impact on agent quality.
6. **Dashboard UI (PR 8)** — Now viable because the above unblocks the core experience.
7. **Town DO + convoys** — Required for multi-rig coordination and convoy dashboard.

The architecture is fundamentally sound. The DO-as-scheduler, container-as-runtime split is correct. The kilo serve adoption was the right call. The gaps are mostly about completing the implementation rather than rearchitecting — with two notable exceptions: the event log (needed for the dashboard vision) and the Witness-as-agent question (which affects how transparent the system feels to users).

## Things me, the human, thinks we should do eventually

- Infra
  - Mint tokens from within the gastown service itself using the jwt secret
  - Make the whole UI live in the gastown service, use SolidJS so that integrating with kilo's existing web UI's is easier
- Feature
  - Mayor should be a persistent chat interface across the town
    - Perhaps we use xterm.js to just use the cli
  - Mayor should automatically check in after creating a town and tell you what's going on
  - Give the Mayor tools to control the UI
    - Say you create a town
    - The mayor should see you've got some github repos connected and should suggest adding a rig
    - You say "yeah go ahead and add the cloud repo rig"
    - The mayor should be able to do that and the user should see it happening the UI in realtime
    - We've basically already gotten a ws connection plumbed through to the container, so this sort of two-way rpc should be pretty easy to implement
  - Agent evolution and evaluation
    - The CV sort of covers this, but we should give the agents the ability to modify their system prompts
    - After each work item is completed, we should have another agent grade their work
    - Punish/reward the agents for their prompt changes
    - Give agents a rating and review system (let users see that a particular agent has 4.5/5 stars)
    - Let users "fire" agents and "hire" new ones
    - Agent personas
