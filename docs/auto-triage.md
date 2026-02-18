# Auto-Triage

## Overview

Auto-triage is an AI-powered GitHub issue classification system. When a GitHub issue is opened or reopened, it automatically:

1. Detects **duplicates** via vector similarity search (Mistral embeddings + Milvus)
2. **Classifies** the issue as `bug`, `feature`, `question`, or `unclear` using a Cloud Agent session
3. **Takes action** on GitHub: posts comments, adds labels, and optionally triggers auto-fix

The feature is gated behind the `auto-triage-feature` PostHog feature flag and works for both personal users and organizations.

### Where to look in code

| Area                                                                            | Path                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Shared library (schemas, DB ops, dispatch, webhook processing)                  | `src/lib/auto-triage/`                                                                                       |
| Cloudflare Worker (orchestration, AI classification, SSE streaming)             | `cloudflare-auto-triage-infra/`                                                                              |
| Internal API routes (status callbacks, duplicate check, config, GitHub actions) | `src/app/api/internal/triage*/`                                                                              |
| tRPC routers (org + personal)                                                   | `src/routers/organizations/organization-auto-triage-router.ts`, `src/routers/personal-auto-triage-router.ts` |
| React UI (config form, ticket list)                                             | `src/components/auto-triage/`                                                                                |
| Pages                                                                           | `src/app/(app)/auto-triage/`, `src/app/(app)/organizations/[id]/auto-triage/`                                |
| Webhook entry point                                                             | `src/lib/integrations/platforms/github/webhook-handlers/issue-handler.ts`                                    |
| Database schema                                                                 | `src/db/schema.ts` (search for `auto_triage_tickets`)                                                        |

## Architecture

The system is split across two runtimes:

- **Next.js app** — webhook reception, DB operations, concurrency control, duplicate detection, internal APIs, UI
- **Cloudflare Worker** (`kilo-auto-triage-worker`) — stateful orchestration via a Durable Object, AI classification via Cloud Agent, GitHub label/comment actions via callbacks to Next.js

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            NEXT.JS APP                                  │
│                                                                         │
│  GitHub Webhook ──► issue-handler.ts ──► IssueWebhookProcessor          │
│       (issue opened/reopened)                │                          │
│                                              ▼                          │
│                                     Config validation                   │
│                                     (repo allowlist,                    │
│                                      skip/required labels)             │
│                                              │                          │
│                                              ▼                          │
│                                   createTriageTicket()                  │
│                                     (DB: status=pending)               │
│                                              │                          │
│                                              ▼                          │
│                                 tryDispatchPendingTickets()              │
│                                   (FIFO, concurrency slots)            │
│                                              │                          │
│                                              ▼                          │
│                                  prepareTriagePayload()                 │
│                                  (auth token, session input)           │
│                                              │                          │
└──────────────────────────────────────────────┼──────────────────────────┘
                                               │ POST /triage
                                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       CLOUDFLARE WORKER (Durable Object)                │
│                                                                         │
│  TriageOrchestrator.runTriage()                                         │
│       │                                                                 │
│       ├── 1. checkDuplicates() ──► POST /api/internal/triage/           │
│       │      (vector search)        check-duplicates                    │
│       │      If duplicate found:                                        │
│       │        ► post comment ──► POST .../post-comment                 │
│       │        ► add labels  ──► POST .../add-label                     │
│       │        ► status=actioned ──► POST .../triage-status/:id         │
│       │        ► STOP                                                   │
│       │                                                                 │
│       ├── 2. classifyIssue()                                            │
│       │      a. GET config ──► POST .../classify-config                 │
│       │      b. GET repo labels ──► GitHub API                          │
│       │      c. Build prompt (PromptBuilder)                            │
│       │      d. Stream SSE ──► Cloud Agent                              │
│       │      e. Parse JSON classification (ClassificationParser)        │
│       │                                                                 │
│       └── 3. Act on result                                              │
│              bug/feature + high confidence → add "kilo-auto-fix" label  │
│              question → mark actioned (answering is TODO)               │
│              unclear / low confidence → needs clarification             │
│              Always: apply AI-selected labels + "kilo-triaged"          │
│                                                                         │
│       All status updates ──► POST /api/internal/triage-status/:id       │
│       On terminal state, Next.js re-triggers dispatch for next ticket   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Lifecycle of a Triage Ticket

```
  GitHub webhook
  (issue opened/reopened)
        │
        ▼
  ┌──────────┐    skip: bots, disabled config,
  │  SKIP?   │──► repo not in allowlist,
  └──────────┘    wrong labels, existing ticket
        │ no
        ▼
  ┌──────────┐
  │ PENDING  │    DB record created, queued for dispatch
  └──────────┘
        │ concurrency slot available
        ▼
  ┌───────────┐
  │ ANALYZING │   Worker running: duplicate check → classification → action
  └───────────┘
       / \
      /   \
     ▼     ▼
┌──────┐ ┌────────┐
│ACTIONED│ │ FAILED │   Terminal states; triggers dispatch of next ticket
└──────┘ └────────┘
```

**Statuses**: `pending` → `analyzing` → `actioned` | `failed` | `skipped`

**Actions** (stored on terminal `actioned` tickets):

- `closed_duplicate` — duplicate detected, comment posted linking to original
- `pr_created` — auto-fix PR was triggered
- `comment_posted` — question answered (TODO) or info posted
- `needs_clarification` — low confidence or unclear classification

## Concurrency Model

Dispatch uses a **per-owner FIFO queue** with a slot-based concurrency limit:

- `MAX_CONCURRENT_TICKETS_PER_OWNER`: **10** (from `core/constants.ts`)
- Pending tickets are dispatched in creation order
- When a ticket reaches a terminal state, the status callback re-triggers `tryDispatchPendingTickets()` to fill freed slots
- Individual dispatch failures are caught and logged (other tickets continue)

## Duplicate Detection

Duplicate detection runs **before** AI classification in the Cloudflare Worker and calls back to the Next.js internal API:

1. **Preprocess**: Strip code blocks, inline code, links, markdown formatting from issue title + body; truncate to 32,000 chars
2. **Embed**: Generate a 1024-dim vector using Mistral (`mistral-embed`) via `createEmbeddingService`
3. **Store**: Upsert into the `auto_triage_tickets` Milvus collection, partitioned by `organization_id` with cosine distance
4. **Search**: Query Milvus for similar vectors scoped to the same org and repo, excluding self-match
5. **Decide**:
   - Similarity ≥ **0.9** → flag as duplicate, set `action_taken = 'closed_duplicate'`, post comment linking to original issue, apply `kilo-duplicate` label
   - Similarity ≥ **0.8** (configurable `duplicate_threshold`) → return as similar but don't auto-close
   - Below threshold → not a duplicate, proceed to classification

The Milvus point ID is an MD5 hash of `organizationId|repoFullName|issueNumber`.

## AI Classification

Classification is performed by the Cloud Agent via a streaming SSE session:

1. **Fetch config** from Next.js: model slug, custom instructions, GitHub token, excluded labels
2. **Fetch repo labels** from GitHub API (paginated, up to 500 labels)
3. **Build prompt** (`PromptBuilder`): includes issue content in XML tags, classification rules for `bug`/`feature`/`question`/`unclear`, confidence calibration guidelines, available labels, optional custom instructions, and required JSON output format
4. **Stream SSE** from Cloud Agent: collects `say` text events and all text events
5. **Parse classification** (`ClassificationParser`):
   - Strategy 1: Extract from markdown ` ```json ``` ` code blocks (last-to-first)
   - Strategy 2: Extract raw JSON objects using balanced brace matching
   - Fallback: Try both strategies on last 5,000 chars
   - Validate with Zod schema

Classification result schema:

```typescript
{
  classification: 'bug' | 'feature' | 'question' | 'duplicate' | 'unclear',
  confidence: number,       // 0.0–1.0
  intentSummary: string,
  relatedFiles?: string[],
  reasoning?: string,
  selectedLabels: string[], // from repo's available labels
}
```

**Confidence thresholds**:

- `auto_fix_threshold` (default **0.8**): bug/feature above this → apply `kilo-auto-fix` label (triggers auto-fix system)
- `MIN_CONFIDENCE_FOR_ACTION` (**0.7**): below this → `needs_clarification`

## Configuration

Stored in the `agent_configs` table with `agent_type = 'auto_triage'` and `platform = 'github'`.

| Field                             | Default                       | Description                                       |
| --------------------------------- | ----------------------------- | ------------------------------------------------- |
| `enabled_for_issues`              | `false`                       | Master toggle                                     |
| `repository_selection_mode`       | `'all'`                       | `'all'` or `'selected'`                           |
| `selected_repository_ids`         | `[]`                          | GitHub repo IDs when mode is `'selected'`         |
| `skip_labels`                     | `[]`                          | Issues with any of these labels are skipped       |
| `required_labels`                 | `[]`                          | All must be present on the issue to proceed       |
| `model_slug`                      | `anthropic/claude-sonnet-4.5` | AI model for classification                       |
| `duplicate_threshold`             | `0.8`                         | Similarity threshold for duplicate detection      |
| `auto_fix_threshold`              | `0.8`                         | Confidence threshold for triggering auto-fix      |
| `max_classification_time_minutes` | `5`                           | Timeout (1–15 min)                                |
| `custom_instructions`             | `null`                        | Optional operator-provided guidelines for the LLM |

Config is managed via tRPC procedures (`saveAutoTriageConfig`, `toggleAutoTriageAgent`) accessible from the UI.

## Internal API Routes

All routes require `X-Internal-Secret` header. Called by the Cloudflare Worker.

| Route                                    | Method | Purpose                                                                                                  |
| ---------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `/api/internal/triage-status/[ticketId]` | POST   | Status update callback. Updates DB, re-triggers dispatch on terminal states.                             |
| `/api/internal/triage/check-duplicates`  | POST   | Vector similarity search. Embeds issue, stores in Milvus, searches for duplicates.                       |
| `/api/internal/triage/classify-config`   | POST   | Returns model slug, custom instructions, GitHub token, excluded labels.                                  |
| `/api/internal/triage/add-label`         | POST   | Adds labels to GitHub issue. Creates label if missing (color `#faf74f`). Returns 207 on partial failure. |
| `/api/internal/triage/post-comment`      | POST   | Posts a comment on the GitHub issue.                                                                     |

## Timeout & Safety Nets

| Mechanism                    | Value                          | Location                                                                 |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| Worker HTTP dispatch timeout | 10s                            | `WORKER_FETCH_TIMEOUT` in `core/constants.ts`                            |
| Classification timeout       | configurable, default 5 min    | `max_classification_time_minutes` in agent config                        |
| SSE stream timeout           | 20 min                         | Hardcoded in `SSEStreamProcessor`                                        |
| Durable Object alarm         | classification timeout + 2 min | Safety net in `TriageOrchestrator`; auto-fails stuck `analyzing` tickets |

## Database

The `auto_triage_tickets` table stores all ticket state. Key columns:

| Column                                          | Type           | Notes                                                                     |
| ----------------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| `id`                                            | UUID PK        |                                                                           |
| `owned_by_organization_id` / `owned_by_user_id` | FK             | Exactly one must be set (check constraint)                                |
| `repo_full_name`                                | text           | e.g. `owner/repo`                                                         |
| `issue_number`                                  | int            |                                                                           |
| `issue_title`, `issue_body`, `issue_author`     | text           | Issue metadata                                                            |
| `status`                                        | text           | `pending`, `analyzing`, `actioned`, `failed`, `skipped`                   |
| `classification`                                | text           | `bug`, `feature`, `question`, `duplicate`, `unclear`                      |
| `confidence`                                    | decimal(3,2)   | 0.00–1.00                                                                 |
| `intent_summary`                                | text           | AI-generated summary                                                      |
| `is_duplicate`                                  | bool           |                                                                           |
| `duplicate_of_ticket_id`                        | UUID FK (self) |                                                                           |
| `similarity_score`                              | decimal(3,2)   |                                                                           |
| `should_auto_fix`                               | bool           |                                                                           |
| `action_taken`                                  | text           | `pr_created`, `comment_posted`, `closed_duplicate`, `needs_clarification` |
| `qdrant_point_id`                               | text           | MD5 hash used as Milvus vector ID                                         |
| `session_id`                                    | text           | Cloud Agent session ID                                                    |

Unique constraint on `(repo_full_name, issue_number)`. Relationship: `auto_fix_tickets.triage_ticket_id` → `auto_triage_tickets.id` (on delete: set null).

## Relationship to Auto-Fix

Auto-triage and auto-fix are separate but connected systems sharing the same architectural pattern:

- When a triage classification is `bug` or `feature` with confidence ≥ `auto_fix_threshold`, the worker applies the `kilo-auto-fix` label to the GitHub issue
- The `kilo-auto-fix` label triggers the auto-fix webhook handler (`issue-handler.ts` routes `labeled` events to auto-fix)
- `auto_fix_tickets.triage_ticket_id` links back to the originating triage ticket

Both systems use the same skeleton: Cloudflare Worker with Durable Object → SSE streaming from Cloud Agent → status callbacks to Next.js → concurrency-controlled dispatch. The service code (`SSEStreamProcessor`, `CloudAgentClient`) is duplicated, not shared.
