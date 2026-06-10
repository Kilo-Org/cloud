# Wasteland CLI (`wl`) Reference

Reference for the `wl` CLI that runs inside the Wasteland container. Source lives in a
separate repo (`github.com/gastownhall/wasteland`), written in Go. This document
captures the architecture, data model, and key workflows so the cloud service team can
work on gastown/wasteland integration without needing the CLI repo open.

## Overview

Wasteland is a federation protocol for Gas Towns. Towns share a **wanted board** (work
items / bounties) via DoltHub — "Git for data." The `wl` CLI is the primary interface
for participating in a wasteland, and the container image bundles it with a web UI
served via `wl serve --hosted`.

- **Language**: Go 1.26+, Cobra CLI framework
- **Build**: Makefile + GoReleaser, cross-compiled linux/darwin amd64/arm64
- **Container**: multi-stage Dockerfile (bun → Go → distroless)
- **Web UI**: React/Vite, embedded into the Go binary via `go:embed`

## Architecture

```
cmd/wl/              CLI entry + ~40 Cobra command handlers
internal/
├── api/             HTTP REST server (web UI + JSON API)
├── backend/         DB abstraction layer
│   ├── local.go     LocalDB  — shells out to `dolt` CLI
│   └── remote.go    RemoteDB — DoltHub REST API (no local dolt needed)
├── commons/         Wanted board CRUD, lifecycle transitions, queries
├── dolthubauth/     DoltHub auth-service client for hosted mode
├── federation/      Core protocol: join, leave, create, config, sync
├── githubcache/     Rig-handle → GitHub-username persistent cache
├── hosted/          Multi-tenant hosted mode (sessions, auth)
├── inference/       Verifiable distributed LLM inference via Ollama
├── observability/   OpenTelemetry tracing + metrics
├── pile/            Read-only DoltHub client for profile viewer
├── remote/          Provider abstraction for fork/PR operations
│   ├── dolthub.go   DoltHub REST + GraphQL APIs
│   ├── github.go    GitHub via `gh` CLI
│   ├── file.go      file:// dolt remotes (offline testing)
│   └── git.go       bare git repos (LAN/SSH)
├── sdk/             High-level SDK shared by CLI, TUI, and web UI
├── style/           Terminal styling (lipgloss)
├── tui/             Full-screen terminal UI (Bubbletea)
└── xdg/             XDG base directory support
web/                 React SPA frontend
schema/              SQL DDL (commons.sql)
```

### Layering

The **SDK** (`internal/sdk/`) is the central shared layer. CLI, TUI, and web UI all
go through it — nothing talks to the database directly. The SDK wraps the backend with
mode-aware mutation orchestration, branch management, and action computation.

The **backend** layer provides a `DB` interface with two implementations:

| Backend | How it works | Used when |
|---|---|---|
| `LocalDB` | Shells out to `dolt` CLI | Self-hosted, local development |
| `RemoteDB` | DoltHub REST API | Hosted mode (our container) |

The **remote** layer provides a `Provider` interface for fork/PR operations:

| Provider | Description |
|---|---|
| `DoltHubProvider` | Production — REST + GraphQL APIs |
| `GitHubProvider` | Uses `gh` CLI for forks and PRs |
| `FileProvider` | `file://` dolt remotes (offline testing) |
| `GitProvider` | Bare git repos (LAN/SSH) |

## Database Schema

The underlying storage is [Dolt](https://doltdb.com) — a MySQL-compatible database
with Git-style branching and merging. Schema version 1.2, defined in
`schema/commons.sql` (embedded via `go:embed`).

### Tables

**`_meta`** — key-value metadata (schema version, wasteland name)

**`rigs`** — registered participants

```
handle PK, display_name, dolthub_org, hop_uri, owner_email,
gt_version, trust_level, registered_at, last_seen, rig_type, parent_rig
```

**`wanted`** — the bounty board (core table)

```
id PK, title, description, project, type, priority, tags JSON,
posted_by, claimed_by, status, effort_level, evidence_url,
sandbox_required, sandbox_scope JSON, sandbox_min_tier,
created_at, updated_at
```

**`completions`** — evidence of completed work

```
id PK, wanted_id, completed_by, evidence, validated_by,
stamp_id, parent_completion_id, block_hash, hop_uri,
completed_at, validated_at
```

**`stamps`** — reputation stamps (issued on accept)

```
id PK, author, subject, valence JSON, confidence, severity,
context_id, context_type, skill_tags JSON, message,
prev_stamp_hash, block_hash, hop_uri, created_at
```

**`badges`**, **`boot_blocks`**, **`chain_meta`**, **`rig_links`** — ancillary tables
for reputation, identity, and federation.

### ID Generation

| Entity | Format | Derivation |
|---|---|---|
| Wanted | `w-<10-hex>` | SHA-256 of `title:timestamp:random` |
| Completion | `c-<16-hex>` | SHA-256 of `wantedID\|rigHandle\|timestamp` |
| Stamp | `s-<16-hex>` | SHA-256 of `wantedID\|rigHandle\|timestamp` |

### Item Lifecycle

```
open ──→ claimed ──→ in_review ──→ completed
  │         │                        ↑
  │         ↓                        ├── accept (+ stamp)
  │      (unclaim → open)            └── close  (no stamp)
  │
  ↓
withdrawn (soft-delete)
```

Transitions are validated by `internal/commons/lifecycle.go`.

## CLI Commands

### Federation

| Command | Description |
|---|---|
| `wl create <org/db>` | Create a new wasteland commons |
| `wl join [upstream]` | Fork commons, register rig |
| `wl leave [upstream]` | Leave a wasteland |
| `wl list` | List joined wastelands |

### Wanted Board CRUD

| Command | Description |
|---|---|
| `wl post` | Post a new wanted item (`--title` required) |
| `wl browse` | Browse with filters (`--project`, `--type`, `--status`, `--priority`, `--limit`, `--json`) |
| `wl status <id>` | Show full item details |
| `wl update <id>` | Update an open item |

### Lifecycle Transitions

| Command | Description |
|---|---|
| `wl claim <id>` | Claim an open item |
| `wl unclaim <id>` | Release back to open |
| `wl done <id>` | Submit evidence (`--evidence` required) |
| `wl accept <id>` | Accept and issue stamp (`--quality` required) |
| `wl reject <id>` | Reject back to claimed |
| `wl close <id>` | Close without stamp |
| `wl delete <id>` | Withdraw (soft-delete) |

### PR/Review Workflow

| Command | Description |
|---|---|
| `wl review [branch]` | List or diff PR-mode branches |
| `wl approve <branch>` | Approve a branch |
| `wl request-changes` | Request changes (`--comment` required) |
| `wl merge <branch>` | Merge reviewed branch |
| `wl pending` | List pending upstream PRs |

### Upstream Approval (Hosted Maintainer Flow)

| Command | Description |
|---|---|
| `wl accept-upstream <id> <rig>` | Accept a fork submission |
| `wl reject-upstream <id> <rig>` | Reject (close PR) a fork submission |
| `wl close-upstream <id> <rig>` | Close without stamp |

### Utility

| Command | Description |
|---|---|
| `wl sync` | Pull upstream into fork |
| `wl config get\|set` | Read/write config |
| `wl doctor` | Check setup health |
| `wl serve` | Start web UI server (`--hosted` for container mode) |
| `wl tui` | Launch terminal UI |
| `wl profile [handle]` | Profile lookup |
| `wl me` | Personal dashboard |
| `wl leaderboard` | Rig rankings |

## Web API (Served by `wl serve`)

Default port: 8999. The container runs `wl serve --hosted`.

### Read Endpoints

| Route | Description |
|---|---|
| `GET /api/bootstrap` | Auth state + joined wastelands |
| `GET /api/wanted` | Browse with query filters |
| `GET /api/wanted/{id}` | Item detail |
| `GET /api/dashboard` | Personal dashboard |
| `GET /api/config` | Rig/mode config |
| `GET /api/leaderboard` | Rig rankings |
| `GET /api/scoreboard` | Public scoreboard |
| `GET /api/profile/{handle}` | Profile lookup |

### Mutation Endpoints

| Route | Description |
|---|---|
| `POST /api/wanted` | Create item |
| `PATCH /api/wanted/{id}` | Update item |
| `DELETE /api/wanted/{id}` | Delete item |
| `POST /api/wanted/{id}/claim` | Claim |
| `POST /api/wanted/{id}/unclaim` | Unclaim |
| `POST /api/wanted/{id}/done` | Submit evidence |
| `POST /api/wanted/{id}/accept` | Accept + stamp |
| `POST /api/wanted/{id}/reject` | Reject |
| `POST /api/wanted/{id}/close` | Close without stamp |
| `POST /api/wanted/{id}/accept-upstream` | Accept fork submission |
| `POST /api/wanted/{id}/reject-upstream` | Reject fork submission |

### Branch Endpoints

| Route | Description |
|---|---|
| `GET /api/branches/diff/{branch}` | Branch diff |
| `POST /api/branches/apply/{branch}` | Merge branch |
| `DELETE /api/branches/{branch}` | Discard branch |
| `POST /api/branches/pr/{branch}` | Create PR |

### Hosted Auth Endpoints

| Route | Description |
|---|---|
| `POST /api/auth/connect` | Begin DoltHub connection |
| `POST /api/auth/connect-session` | Establish session |
| `GET /api/auth/status` | Check auth state |
| `POST /api/auth/join` | Join a wasteland |
| `DELETE /api/auth/wastelands/{upstream}` | Leave |

### Caching & Rate Limiting

- Read cache: 30s TTL, keyed by query string / ID. Invalidated on mutation.
- Rate limits: auth endpoints 10 req/min, general 120 req/min (token bucket per IP).

## Authentication

### Hosted Mode (Container)

The container runs in hosted mode with an external DoltHub auth service:

1. `POST /api/auth/connect` → initiates DoltHub connection
2. `POST /api/auth/connect-session` → establishes HMAC-signed session cookie (24h TTL)
3. Per-request client resolution from session state
4. Credential delegation to `dolthubauth.Client`

### Self-Sovereign Mode

- `DOLTHUB_TOKEN` — DoltHub API token
- `DOLTHUB_ORG` — user's DoltHub org/username
- `DOLTHUB_SESSION_TOKEN` — browser session cookie for GraphQL fork API (optional)

## Key Workflows

### Join

1. Fork the upstream commons to user's DoltHub org (retry + backoff)
2. Clone the fork locally (local backend) or register remote access (remote backend)
3. Create registration branch, insert into `rigs` table
4. Push branch, create PR for registration
5. Save config to `~/.config/wasteland/wastelands/{org}/{db}.json`

### PR-Mode Mutation (how most writes work)

1. Compute branch name: `wl/{rig-handle}/{wanted-id}`
2. Check main status for delta computation
3. Execute DML on the branch (creates/reuses branch from main)
4. Read branch state for result
5. Push branch to fork (unless `--no-push`)
6. Auto-cleanup: if mutation reverted to main status, delete branch + close PR
7. Auto-submit PR: if branch survived and no PR exists, create one

Before each mutation, an idempotency check prevents duplicate commits when the branch
already has the target status.

### Pending Upstream Detection

Detects which wanted items have pending fork submissions:

1. List all open PRs on the upstream repo (paginated)
2. Fetch detail for each PR (parallel, max 10 concurrent)
3. For each unique source branch: query `dolt_diff` tables for status/claimed_by changes
4. Compare diff results against upstream main to eliminate stale entries
5. For in_review/completed items: query fork branch's `completions` table for evidence

### Sync

PR mode: resets local main to upstream main. Wild-west mode: pulls upstream changes.

## Configuration

Per-wasteland JSON config stored at `~/.config/wasteland/wastelands/{org}/{db}.json`:

```
Upstream       string     // e.g. "hop/wl-commons"
ProviderType   string     // "dolthub", "file", "git", "github"
ForkOrg        string     // user's DoltHub org
ForkDB         string     // database name
RigHandle      string     // user's handle
Mode           string     // "pr" (default) or "wild-west"
Backend        string     // "remote" or "local"
Signing        bool       // GPG-sign commits
```

Settings: `wl config set mode pr|wild-west`, `wl config set signing true|false`.

## Environment Variables

| Variable | Description |
|---|---|
| `DOLTHUB_TOKEN` | DoltHub API token |
| `DOLTHUB_ORG` | DoltHub org/username |
| `DOLTHUB_SESSION_TOKEN` | Browser session for GraphQL fork |
| `PORT` | Override listen port for `wl serve` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | OTLP traces endpoint |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | OTLP metrics endpoint |
| `WL_ENVIRONMENT` | Staging env (shows impersonation banner) |
