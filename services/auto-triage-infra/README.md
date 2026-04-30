# Kilo Auto Triage Worker

Cloudflare Worker that orchestrates the auto-triage process for GitHub issues using Durable Objects.

## Architecture

This worker follows the same pattern as the auto-fix worker:

- **HTTP API**: Receives triage requests from Next.js backend via [`index.ts`](src/index.ts:1)
- **Durable Objects**: [`TriageOrchestrator`](src/triage-orchestrator.ts:24) manages the lifecycle of each triage ticket
- **Fire-and-forget**: Returns 202 immediately, processes in background using `waitUntil()`
- **Concurrency control**: Handled by Next.js dispatch system (10 concurrent per owner)
- **Async classification**: `prepareSession` + `initiateFromPreparedSession` on cloud-agent-next, with the terminal result delivered to a callback route on this worker

### Sequence

```
Next.js dispatch
    │ POST /triage
    ▼
auto-triage worker  ── runTriage() ──► DO
                                        │
                                        │ duplicate check (Next.js)
                                        │ if duplicate: labels + comment, done
                                        │
                                        │ classify-config (Next.js)
                                        │ mint per-ticket callbackSecret
                                        │ prepareSession  (cloud-agent-next)
                                        │   callbackTarget.headers['X-Callback-Secret']
                                        │     = callbackSecret
                                        │ initiateFromPreparedSession (cloud-agent-next)
                                        │ setAlarm(timeout + 2m)
                                        │ RETURN
                                        │
              ┌─ cloud-agent-next ◄─────┘  (runs session)
              ▼
         callback queue
              │  POST <SELF_URL>/tickets/:id/classification-callback
              │    X-Callback-Secret: <minted-secret>   ← relayed verbatim
              ▼
auto-triage worker
              │  waitUntil(stub.completeClassification(secret, payload))
              │  returns 202 immediately
              ▼
            DO.completeClassification(providedSecret, payload)
              │  constant-time compare providedSecret vs state.callbackSecret
              │  verify payload.cloudAgentSessionId == state.cloudAgentSessionId
              │  idempotency check (already terminal?)
              │
              ├─ parse → apply labels (Next.js)
              ├─ post comment / mark actioned (Next.js)
              └─ clear alarm
```

## Features

- **Duplicate Detection**: Calls Next.js API to check for similar issues using vector similarity search
- **Issue Classification**: Uses cloud-agent-next with AI models to classify issues as bug/feature/question/unclear via prepare + initiate + callback
- **Label Application**: Applies AI-selected labels plus action-tracking labels (kilo-triaged, kilo-auto-fix) via the Next.js API
- **Status Updates**: Real-time callbacks to Next.js API for status tracking
- **Modular Services**: Clean separation of concerns with dedicated service classes

## API Endpoints

### POST /triage

Start a new triage session.

**Request:**

```json
{
  "ticketId": "uuid",
  "authToken": "token",
  "sessionInput": {
    "repoFullName": "owner/repo",
    "issueNumber": 123,
    "issueTitle": "Issue title",
    "issueBody": "Issue description",
    "duplicateThreshold": 0.8,
    "autoCreatePrThreshold": 0.9,
    "modelSlug": "claude-sonnet-4.5",
    "baseBranch": "main",
    "branchPrefix": "auto-triage",
    "customInstructions": "Optional custom instructions"
  },
  "owner": {
    "type": "org",
    "id": "org-uuid",
    "userId": "user-id"
  }
}
```

**Response:** `202 Accepted`

```json
{
  "ticketId": "uuid",
  "status": "pending"
}
```

### GET /tickets/:ticketId/events

Get events for a triage session (currently returns stored events from Durable Object state).

**Response:** `200 OK`

```json
{
  "events": [
    {
      "timestamp": "2024-12-11T21:00:00Z",
      "eventType": "duplicate_check",
      "message": "Checking for duplicates...",
      "content": "Detailed event content",
      "sessionId": "session-uuid"
    }
  ]
}
```

### GET /health

Health check endpoint.

**Response:** `200 OK`

```json
{
  "status": "ok",
  "service": "auto-triage-worker"
}
```

### POST /tickets/:ticketId/classification-callback

Terminal-status callback from cloud-agent-next. Bypasses the backend-auth
middleware; authenticated instead by a per-ticket secret in the
`X-Callback-Secret` header, which is compared in constant time against the
secret persisted in the Durable Object at prepare-session time.

**Headers:** `X-Callback-Secret: <per-ticket UUID>`

**Request body:** subset of `ExecutionCallbackPayload` from cloud-agent-next
(`cloudAgentSessionId`, `status`, `errorMessage`, `lastAssistantMessageText`).

**Response:** `202 Accepted` — the classification is processed in the
background via `waitUntil()`; errors inside the DO are covered by the
stuck-ticket alarm.

## How It Works

### Request Flow

1. **Next.js dispatches triage request** → `POST /triage`
2. **Worker creates Durable Object** using ticketId as unique name
3. **Immediate response** (202 Accepted) returned to Next.js
4. **Background processing** starts via `waitUntil()`:
   - Duplicate check (calls Next.js API)
   - If duplicate → apply labels, post comment, update status and exit
   - If not duplicate → prepare + initiate a classification session in cloud-agent-next and return
5. **cloud-agent-next runs the session**, then POSTs a terminal callback to the worker at
   `POST /tickets/:ticketId/classification-callback`
6. **Callback route** validates the per-ticket secret, resolves the DO, and invokes
   `completeClassification()` which parses the assistant output and acts on it:
   - **Question/Unclear** → update status (TODO: post comment)
   - **Bug/Feature (high confidence)** → apply `kilo-auto-fix` label so auto-fix picks it up
   - **Bug/Feature (low confidence)** → request clarification

### Classification Process

1. Worker calls Next.js to get configuration (model, GitHub token, custom instructions, excluded labels)
2. Worker fetches repository labels from GitHub and filters out excluded labels
3. [`PromptBuilder`](src/services/prompt-builder.ts:30) creates a structured classification prompt
4. Worker mints a per-ticket `callbackSecret` (UUID) and persists it to DO state together with the available labels and classify config
5. Worker calls `prepareSession` on cloud-agent-next with `callbackTarget.headers['X-Callback-Secret']`
6. Worker calls `initiateFromPreparedSession` and returns
7. cloud-agent-next runs the agent to completion and POSTs an `ExecutionCallbackPayload` to `/tickets/:ticketId/classification-callback` with the secret header relayed verbatim
8. The callback route performs a constant-time secret compare inside the DO, verifies `cloudAgentSessionId`, and runs [`ClassificationParser`](src/parsers/classification-parser.ts:14) on `lastAssistantMessageText`
9. Result includes: classification type, confidence score, intent summary, related files, selected labels

### PR Creation Process

PR creation is not handled in this worker. When a classification is
high-confidence, the worker applies the `kilo-auto-fix` label to the
issue; the separate `auto-fix-infra` worker subscribes to that label
and creates PRs independently.

### Timeouts

Classification runs asynchronously end-to-end (prepare → initiate →
callback), so there is no inline SSE timeout in this worker. The
safety net is a Durable Object alarm:

- **Alarm budget**: `maxClassificationTimeMinutes * 60s + 120s`
  (default 5 min + 2 min buffer)
- If the callback hasn't landed within the budget, the alarm fires
  and marks the ticket `failed` with `"Triage timed out (alarm recovery)"`.

Budget covers: cloud-agent-next queue latency, agent startup + run,
callback delivery, and post-classification label/comment API calls.

### Key Design Decisions

- **Fire-and-forget with `waitUntil()`**: Avoids 15-minute wall time limit on Durable Object requests
- **Modular services**: Clean separation of concerns for parsing, API calls, and prompt building
- **Async classification via callback**: `prepareSession` + `initiateFromPreparedSession` return immediately; the terminal result is delivered to the worker's own callback route. No SSE stream held open across the run.
- **Per-ticket callback secret**: Each triage mints a UUID stored in DO state and relayed via `callbackTarget.headers['X-Callback-Secret']`. Compared in constant time inside the DO. A leak from cloud-agent-next's callback queue only compromises a single ticket's in-flight callback.
- **State persistence**: All state stored in Durable Object storage for reliability
- **Alarm safety net**: A single DO alarm covers the full classification end-to-end so stuck tickets are recovered automatically.

## Development

## Authentication

The worker uses four authentication mechanisms:

1. **Incoming requests from Next.js** (POST /triage, GET /tickets/:ticketId/events): Bearer token via `BACKEND_AUTH_TOKEN`. Enforced by Hono's `backendAuthMiddleware`.

2. **Incoming classification callbacks from cloud-agent-next** (POST /tickets/:ticketId/classification-callback): per-ticket secret via `X-Callback-Secret` header. The secret is a UUID minted by the DO at `prepareSession` time and compared in constant time inside `completeClassification()`. This route is mounted BEFORE `backendAuthMiddleware` so it bypasses Bearer auth.

3. **Outgoing calls to Next.js** (duplicate check, classify-config, add-label, post-comment, status updates): shared secret via `INTERNAL_API_SECRET` in `X-Internal-Secret` header.

4. **Outgoing calls to cloud-agent-next** (`prepareSession`, `initiateFromPreparedSession`): `Authorization: Bearer <authToken>` (user/bot auth token propagated from the triage request) plus `x-internal-api-key: <INTERNAL_API_SECRET>`.

Note that `INTERNAL_API_SECRET` is intentionally _not_ used to authenticate the classification callback. A leak of the callback queue contents should only compromise a single ticket's in-flight callback, not future callbacks for every ticket.

### Prerequisites

- Node.js 18+
- pnpm
- Wrangler CLI (`npm install -g wrangler`)

### Setup

1. Install dependencies:

```bash
pnpm install
```

2. Copy environment variables:

```bash
cp .dev.vars.example .dev.vars
```

3. Configure `.dev.vars`:

```bash
API_URL=http://localhost:3000
INTERNAL_API_SECRET=your-secret-here
BACKEND_AUTH_TOKEN=your-backend-auth-token
CLOUD_AGENT_URL=http://localhost:8794
SELF_URL=http://localhost:8791
```

**Note**: Ensure the secrets match between this worker and your Next.js backend configuration. `SELF_URL` must be reachable from cloud-agent-next; for local dev use a public tunnel (e.g. `ngrok http 8791`) and paste the tunnel URL here.

### Local Development

**Important**: When developing locally and connecting to other local workers (like the Cloud Agent), you need to be aware of network restrictions:

#### Options 1: Use your LAN IP address (Recommended)

This is the recommended approach for local development with the Cloud Agent.

If you need to use LAN IP addresses, ensure:

1. Your Cloud Agent is running in local mode on your machine
2. Your local network allows connections between workers
3. You've configured your `.dev.vars` with the correct LAN IP addresses

```bash
CLOUD_AGENT_URL=http://192.168.1.100:8788
```

Then run the worker in local mode:

```bash
pnpm dev
```

#### Option 2: Use localhost URLs

In your `.dev.vars`, use `localhost` instead of LAN IP addresses:

```bash
CLOUD_AGENT_URL=http://localhost:8788
```

Then run the worker in local mode:

```bash
pnpm dev
```

The worker will be available at `http://127.0.0.1:8791`

#### Option 3: Use remote mode

If you need to use LAN IP addresses or connect to services on your local network, run the worker in remote mode:

```bash
pnpm dev --remote
```

#### Troubleshooting

If you see errors like "Network connection lost" when connecting to the Cloud Agent:

1. Check your `.dev.vars` file - ensure `CLOUD_AGENT_URL` uses the correct format:
   - Local mode: `http:/localhost:8788` ✅
   - Remote mode: Use a public URL or ngrok tunnel ✅
2. Verify the Cloud Agent is running on the expected port
3. Check that both workers are running in compatible modes (both local or both remote)

### Type Checking

```bash
pnpm typecheck
```

### Testing

Currently no automated tests. Manual testing via:

- Local development with Next.js backend
- Cloudflare dashboard logs
- Direct API calls with curl/Postman

### Deployment

```bash
# Set secrets (first time only)
wrangler secret put INTERNAL_API_SECRET
wrangler secret put BACKEND_AUTH_TOKEN

# Optional: Set Sentry DSN for error tracking
wrangler secret put SENTRY_DSN

# Deploy to production
pnpm deploy
```

The deployment will:

- Build TypeScript to JavaScript
- Upload to Cloudflare Workers
- Create/update Durable Object bindings
- Make worker available at configured route

## Durable Object: TriageOrchestrator

The [`TriageOrchestrator`](src/triage-orchestrator.ts:24) Durable Object manages the lifecycle of a single triage ticket:

### Lifecycle Flow

1. **Initialization** ([`start()`](src/triage-orchestrator.ts:33)): Saves ticket state to Durable Object storage
2. **Background Processing** ([`runTriage()`](src/triage-orchestrator.ts:52)): Executes via `waitUntil()` to avoid 15-min wall time limit
3. **Duplicate Detection** ([`checkDuplicates()`](src/triage-orchestrator.ts:121)): Calls Next.js API for vector similarity search
4. **Classification** ([`classifyIssue()`](src/triage-orchestrator.ts:144)): Prepares + initiates a cloud-agent-next session; terminal result arrives via callback
5. **Callback Completion** ([`completeClassification()`](src/triage-orchestrator.ts:100)): Validates callback secret, parses the assistant output, and applies labels/status based on the result:
   - **Duplicate** ([`closeDuplicate()`](src/triage-orchestrator.ts:210)): Updates status with duplicate info
   - **Question** ([`answerQuestion()`](src/triage-orchestrator.ts:227)): Posts answer comment (TODO)
   - **Unclear** ([`requestClarification()`](src/triage-orchestrator.ts:244)): Requests more info (TODO)
   - **Bug/Feature** (high confidence): Applies `kilo-auto-fix` label for the auto-fix worker to pick up

### Service Classes

The orchestrator uses modular service classes for clean separation of concerns:

- **[`ClassificationParser`](src/parsers/classification-parser.ts:10)**: Extracts and validates classification results from AI responses
  - Tries multiple parsing strategies (code blocks, JSON objects)
  - Validates classification types and confidence scores
  - Handles nested JSON and malformed responses

- **`createCloudAgentNextFetchClient`** (from `@kilocode/worker-utils`):
  Shared typed fetch client for cloud-agent-next tRPC endpoints. We use
  `prepareSession` and `initiateFromPreparedSession` with per-call
  `Authorization: Bearer <authToken>` and `x-internal-api-key: <INTERNAL_API_SECRET>` headers.

- **[`PromptBuilder`](src/services/prompt-builder.ts:26)**: Builds AI prompts for different tasks
  - [`buildClassificationPrompt()`](src/services/prompt-builder.ts:30): Creates structured classification prompts
  - Supports custom instructions from configuration

## Integration with Next.js

The worker calls back to Next.js for:

- **Duplicate detection**: `POST /api/internal/triage/check-duplicates`
- **Classification config**: `POST /api/internal/triage/classify-config` (gets model, GitHub token, custom instructions, excluded labels)
- **Add label**: `POST /api/internal/triage/add-label`
- **Post comment**: `POST /api/internal/triage/post-comment`
- **Status updates**: `POST /api/internal/triage-status/:ticketId`

All callbacks to Next.js use the `INTERNAL_API_SECRET` for authentication via `X-Internal-Secret` header.

## Environment Variables

### Public (in wrangler.jsonc)

- `API_URL`: Next.js backend URL (e.g., `http://localhost:3000` or `https://app.kilo.ai`)
- `CLOUD_AGENT_URL`: cloud-agent-next URL used for AI-powered classification
- `SELF_URL`: public URL of this worker, used as the callback target for cloud-agent-next

### Secrets (via wrangler secret)

- `INTERNAL_API_SECRET`: Shared secret for authenticating callbacks to Next.js (sent as `X-Internal-Secret` header) and for the `x-internal-api-key` header on cloud-agent-next tRPC calls. **Not** used to authenticate the classification callback — that uses a per-ticket secret instead.
- `BACKEND_AUTH_TOKEN`: Bearer token for authenticating incoming requests from Next.js

### Optional

- `SENTRY_DSN`: Sentry DSN for error tracking (production only)
- `CF_VERSION_METADATA`: Cloudflare version metadata for deployment tracking

## Code Structure

```
src/
├── index.ts                          # HTTP API and worker entry point
├── triage-orchestrator.ts            # Main Durable Object orchestrator
├── types.ts                          # TypeScript type definitions
├── parsers/
│   └── classification-parser.ts      # Parses AI classification responses
└── services/
    ├── github-labels-service.ts      # Fetches repo labels from GitHub
    └── prompt-builder.ts             # AI prompt templates
```

## Type System

The worker uses a comprehensive type system defined in [`types.ts`](src/types.ts:1):

### Core Types

- **[`TriageStatus`](src/types.ts:7)**: `'pending' | 'analyzing' | 'actioned' | 'failed' | 'skipped'`
- **[`TriageClassification`](src/types.ts:9)**: `'bug' | 'feature' | 'question' | 'duplicate' | 'unclear'`
- **[`TriageAction`](src/types.ts:11)**: `'pr_created' | 'comment_posted' | 'closed_duplicate' | 'needs_clarification'`

### Data Models

- **[`TriageTicket`](src/types.ts:53)**: Complete state stored in Durable Object
  - Includes session input, owner info, status, classification results
  - Tracks timestamps (startedAt, completedAt, updatedAt)
  - Stores `cloudAgentSessionId`, `callbackSecret`, snapshotted `availableLabels` and `classifyConfig` so the classification callback can complete without a second round-trip to Next.js
  - Contains error messages and action metadata

- **[`SessionInput`](src/types.ts:30)**: Configuration for triage session
  - GitHub issue details (repo, number, title, body)
  - Thresholds for duplicate detection and auto-fix label application
  - Model selection and custom instructions

- **[`ClassificationResult`](src/types.ts:106)**: AI classification output
  - Classification type and confidence score (0-1)
  - Intent summary and reasoning
  - Related files for context

- **[`DuplicateResult`](src/types.ts:99)**: Duplicate detection output
  - Boolean flag and similarity score
  - Reference to duplicate ticket
  - Reasoning for duplicate determination

- **[`Env`](src/types.ts:117)**: Worker environment bindings
  - Durable Object namespace binding
  - Environment variables and secrets
  - Optional Sentry configuration

## Monitoring

- Cloudflare Analytics Dashboard
- Durable Object metrics and storage
- Custom logging via `console.log` (viewable in Cloudflare dashboard)
- Sentry error tracking (production)

### Timeout Monitoring

Monitor alarm-driven timeout recovery to catch stuck callbacks:

```bash
# Check logs for the alarm-based recovery path
wrangler tail --format pretty | grep "Triage timed out"

# Look for silently-missed callbacks
wrangler tail --format pretty | grep "classification-callback"
```

Key metrics to track:

- Stuck-ticket alarm firing rate (should be near zero — indicates missing callbacks)
- Average classification wall time end-to-end
- Callback 2xx rate from cloud-agent-next into this worker

## Troubleshooting

### Stuck tickets / missing callbacks

If tickets are getting marked failed with `"Triage timed out (alarm recovery)"`:

1. **Check cloud-agent-next callback queue** for deliveries to `POST /tickets/:ticketId/classification-callback`
2. **Verify `SELF_URL`** in `wrangler.jsonc` points at a publicly reachable URL (not Access-gated)
3. **Check the agent session** completed — if it ran longer than the alarm budget the callback may have been dropped
4. **Consider raising `maxClassificationTimeMinutes`** in the session input if legitimate runs need more time

### Callback auth failures

401 responses on `/tickets/:ticketId/classification-callback`:

- Ensure the `X-Callback-Secret` header is still being relayed by cloud-agent-next
- Mismatches are logged as `"Callback secret mismatch"` inside the DO (not the HTTP layer) — search DO logs
