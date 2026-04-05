# Kilo Auto Triage Worker

Cloudflare Worker that orchestrates the auto-triage process for GitHub issues using Durable Objects.

## Architecture

This worker follows the same pattern as the code review worker:

- **HTTP API**: Receives triage requests from Next.js backend via [`index.ts`](src/index.ts:1)
- **Durable Objects**: [`TriageOrchestrator`](src/triage-orchestrator.ts:24) manages the lifecycle of each triage ticket
- **Fire-and-forget**: Returns 202 immediately, processes in background using `waitUntil()`
- **Concurrency control**: Handled by Next.js dispatch system (10 concurrent per owner)

## Features

- **Duplicate Detection**: Calls Next.js API to check for similar issues using vector similarity search
- **Issue Classification**: Uses Cloud Agent with AI models to classify issues as bug/feature/question/unclear
- **PR Creation**: Automatically creates PRs via Cloud Agent for high-confidence actionable issues
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

## How It Works

### Request Flow

1. **Next.js dispatches triage request** → `POST /triage`
2. **Worker creates Durable Object** using ticketId as unique name
3. **Immediate response** (202 Accepted) returned to Next.js
4. **Background processing** starts via `waitUntil()`:
   - Duplicate check (calls Next.js API)
   - If duplicate → update status and exit
   - If not duplicate → classify issue (via Cloud Agent)
   - Based on classification:
     - **Question/Unclear** → update status (TODO: post comment)
     - **Bug/Feature (high confidence)** → create PR via Cloud Agent async
     - **Bug/Feature (low confidence)** → request clarification

### Classification Process

1. Worker calls Next.js to get configuration (model, GitHub token, custom instructions)
2. [`PromptBuilder`](src/services/prompt-builder.ts:30) creates structured classification prompt
3. [`CloudAgentClient`](src/services/cloud-agent-client.ts:30) initiates streaming session with Cloud Agent
4. [`SSEStreamProcessor`](src/services/sse-stream-processor.ts:19) processes SSE stream and accumulates text
5. [`ClassificationParser`](src/parsers/classification-parser.ts:14) extracts JSON classification from response
6. Result includes: classification type, confidence score, intent summary, related files

### PR Creation Process

1. Worker calls Next.js to get PR configuration (model, branch settings, GitHub token)
2. [`PromptBuilder`](src/services/prompt-builder.ts:80) creates PR creation prompt with issue context
3. [`CloudAgentClient`](src/services/cloud-agent-client.ts:77) initiates async session with callback URL
4. [`SSEStreamProcessor`](src/services/sse-stream-processor.ts:19) extracts sessionId from stream
5. Worker updates status with sessionId and exits
6. Cloud Agent processes PR creation in background
7. Cloud Agent calls back to Next.js when PR is created
8. Next.js updates triage ticket status to 'actioned'

### Timeouts

To prevent agents from running indefinitely, the worker implements timeouts for different operations:

- **Classification Timeout**: 5 minutes
  - Quick analysis to determine issue type
  - Fails fast if taking too long
  - Error: "Classification timeout - exceeded 5 minute limit"

- **PR Creation Timeout**: 15 minutes
  - More complex operation involving code changes
  - Needs more time than classification
  - Error: "PR creation timeout - exceeded 15 minute limit"

When a timeout occurs:

- The triage ticket status is set to `'failed'`
- A descriptive error message is stored
- Detailed logs are written for debugging
- Users can retry the operation

### Key Design Decisions

- **Fire-and-forget with `waitUntil()`**: Avoids 15-minute wall time limit on Durable Object requests
- **Modular services**: Clean separation of concerns for parsing, API calls, and prompt building
- **Async PR creation**: Long-running PR creation happens in Cloud Agent with callbacks
- **Streaming classification**: Synchronous streaming for fast classification results
- **State persistence**: All state stored in Durable Object storage for reliability
- **Operation-specific timeouts**: Different timeout values for classification (5 min) and PR creation (15 min)

## Development

## Authentication

The worker uses two authentication mechanisms:

1. **Incoming requests** (from Next.js): Bearer token authentication via `BACKEND_AUTH_TOKEN`
   - All endpoints except `/health` require `Authorization: Bearer <token>` header
   - Implemented using Hono's [`bearerAuth`](src/index.ts:42) middleware

2. **Outgoing callbacks** (to Next.js): Shared secret via `INTERNAL_API_SECRET`
   - All callbacks to Next.js include `X-Internal-Secret` header
   - Used for duplicate checks, config fetching, and status updates

3. **Cloud Agent requests**: Bearer token from incoming request
   - Worker forwards the `authToken` from the triage request to Cloud Agent
   - Enables Cloud Agent to access user's repositories and resources

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
CLOUD_AGENT_URL=http://localhost:8788
```

**Note**: Ensure the secrets match between this worker and your Next.js backend configuration.

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
4. **Classification** ([`classifyIssue()`](src/triage-orchestrator.ts:144)): Uses Cloud Agent to analyze issue with AI
5. **Action**: Takes appropriate action based on classification:
   - **Duplicate** ([`closeDuplicate()`](src/triage-orchestrator.ts:210)): Updates status with duplicate info
   - **Question** ([`answerQuestion()`](src/triage-orchestrator.ts:227)): Posts answer comment (TODO)
   - **Unclear** ([`requestClarification()`](src/triage-orchestrator.ts:244)): Requests more info (TODO)
   - **Bug/Feature** (high confidence) ([`createPR()`](src/triage-orchestrator.ts:262)): Creates PR via Cloud Agent async session

### Service Classes

The orchestrator uses modular service classes for clean separation of concerns:

- **[`ClassificationParser`](src/parsers/classification-parser.ts:10)**: Extracts and validates classification results from AI responses
  - Tries multiple parsing strategies (code blocks, JSON objects)
  - Validates classification types and confidence scores
  - Handles nested JSON and malformed responses

- **[`CloudAgentClient`](src/services/cloud-agent-client.ts:21)**: Encapsulates Cloud Agent API interactions
  - [`initiateSession()`](src/services/cloud-agent-client.ts:30): For streaming classification responses
  - [`initiateSessionAsync()`](src/services/cloud-agent-client.ts:77): For async PR creation with callbacks
  - Handles URL construction, authentication, and error handling

- **[`PromptBuilder`](src/services/prompt-builder.ts:26)**: Builds AI prompts for different tasks
  - [`buildClassificationPrompt()`](src/services/prompt-builder.ts:30): Creates structured classification prompts
  - [`buildPRPrompt()`](src/services/prompt-builder.ts:80): Creates PR creation prompts with context
  - Supports custom instructions from configuration

- **[`SSEStreamProcessor`](src/services/sse-stream-processor.ts:15)**: Generic SSE stream processing
  - Handles buffer management and line parsing
  - Extracts sessionId, text content, and completion events
  - Provides event-based callbacks for stream processing

## Integration with Next.js

The worker calls back to Next.js for:

- **Duplicate detection**: `POST /api/internal/triage/check-duplicates`
- **Classification config**: `POST /api/internal/triage/classify-config` (gets model, GitHub token, custom instructions)
- **PR config**: `POST /api/internal/triage/pr-config` (gets model, branch settings, GitHub token, custom instructions)
- **Status updates**: `POST /api/internal/triage-status/:ticketId`
- **PR callbacks**: `POST /api/internal/triage/pr-callback` (called by Cloud Agent when PR is created)

All callbacks use the `INTERNAL_API_SECRET` for authentication via `X-Internal-Secret` header.

## Environment Variables

### Public (in wrangler.jsonc)

- `API_URL`: Next.js backend URL (e.g., `http://localhost:3000` or `https://api.kilocode.com`)
- `CLOUD_AGENT_URL`: Cloud Agent URL for AI-powered classification and PR creation

### Secrets (via wrangler secret)

- `INTERNAL_API_SECRET`: Shared secret for authenticating callbacks to Next.js (sent as `X-Internal-Secret` header)
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
    ├── cloud-agent-client.ts         # Cloud Agent API client
    ├── prompt-builder.ts             # AI prompt templates
    └── sse-stream-processor.ts       # SSE stream processing utility
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
  - Stores sessionId for Cloud Agent tracking
  - Contains error messages and action metadata

- **[`SessionInput`](src/types.ts:30)**: Configuration for triage session
  - GitHub issue details (repo, number, title, body)
  - Thresholds for duplicate detection and auto-PR creation
  - Model selection and custom instructions
  - Branch configuration for PR creation

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

Monitor timeout occurrences to identify performance issues:

```bash
# Check logs for timeout errors
wrangler tail --format pretty | grep "timeout"

# Look for specific timeout types
wrangler tail --format pretty | grep "Classification timeout"
wrangler tail --format pretty | grep "PR creation timeout"
```

Key metrics to track:

- Classification timeout rate (should be < 5%)
- PR creation timeout rate (should be < 5%)
- Average classification duration
- Average PR creation duration

## Troubleshooting

### Classification Timeouts

If classification is timing out frequently:

1. **Check model performance**: Some models may be slower than others
2. **Review issue complexity**: Very large issues may take longer to analyze
3. **Check Cloud Agent health**: Ensure Cloud Agent is responding quickly
4. **Consider increasing timeout**: If legitimate cases need more time

### PR Creation Timeouts

If PR creation is timing out frequently:

1. **Check repository size**: Large repositories take longer to clone and analyze
2. **Review issue complexity**: Complex changes may require more time
3. **Check Cloud Agent resources**: Ensure adequate CPU/memory for code generation
4. **Monitor callback delivery**: Ensure callbacks are being received even after timeout

### Debugging Timeout Issues

When investigating timeout issues, check the logs for:

```typescript
// Timeout detection in logs
{
  ticketId: "uuid",
  error: "Classification timeout - exceeded 5 minute limit",
  isTimeout: true,
  isClassificationTimeout: true,
  isPRTimeout: false
}
```

The error handling distinguishes between:

- **Classification timeouts**: Issue analysis took too long
- **PR creation timeouts**: Code generation took too long
- **Connection errors**: Network or Cloud Agent issues
