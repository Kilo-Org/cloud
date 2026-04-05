# Kilocode Cloud Worker

A Cloudflare Worker that provides a secure, scalable API for running [Kilocode](https://kilo.ai) AI coding tasks in isolated sandbox environments with GitHub integration.

## Development Setup

### Building the Development Docker Image

The `Dockerfile.dev` is used for local development and testing. It requires a pre-built `kilo` binary from the [kilo-cli](https://github.com/kilocode/kilo-cli) repository.

**Prerequisites:**

- [Bun](https://bun.sh) 1.3+
- Docker
- Clone of the kilo-cli repository

**Build the kilo binary and Docker image:**

```bash
# Set the path to your kilo-cli checkout (required)
export KILO_CLI_DIR=/path/to/kilo-cli

# From the cloud-agent directory
./cloud-agent-build.sh

# Use it
pnpm run dev
```

The `cloud-agent-build.sh` script:

1. Builds kilo-cli from source (all targets including linux-x64)
2. Copies the `linux-x64` binary to `./kilo`

By default, the script looks for kilo-cli at `$HOME/projects/kilo-cli`. Override with `KILO_CLI_DIR` environment variable.

**What's in Dockerfile.dev:**

- Base image: `cloudflare/sandbox:0.6.7`
- Pre-built `kilo` binary (from `cloud-agent-build.sh`)
- GitHub CLI (`gh`) and GitLab CLI (`glab`)
- Wrapper bundle built inside the container

## API Documentation

### Overview

The recommended V2 flow is:

1. **Prepare Session** - Pre-create session with all configuration (supports prompts up to 100KB)
2. **Initiate Prepared Session (V2)** - Start execution using stored configuration (ack + WebSocket)
3. **Send Messages (V2)** - Queue follow-up messages to the same session

**Deprecated (legacy SSE/V1):**

- `initiateSessionStream`
- `sendMessageStream`
- `initiateFromKilocodeSession` (SSE)
- `initiateSessionAsync`

**V2 (current):**

- `prepareSession`
- `prepareLegacySession`
- `getSession`
- `initiateFromKilocodeSessionV2`
- `sendMessageV2` (output via `/stream` WebSocket)

### Authentication

All endpoints require a kilocode api token except `/stream` which uses short lived ws tickets.

## Usage Examples

### TypeScript Client (Recommended)

```typescript
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from './router';

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: 'https://your-worker.dev/trpc',
      headers: {
        Authorization: `Bearer ${KILOCODE_TOKEN}`,
      },
    }),
  ],
});

// 1) Prepare a session first (backend-to-backend)
const prepared = await client.prepareSession.mutate({
  githubRepo: 'facebook/react',
  kilocodeOrganizationId: 'your-org-id-here',
  prompt: 'Analyze the project structure',
  mode: 'architect',
  model: 'gpt-4o-mini',
});

// 2) Initiate the prepared session via V2
const ack = await client.initiateFromKilocodeSessionV2.mutate({
  cloudAgentSessionId: prepared.cloudAgentSessionId,
});

// 3) Obtain a stream ticket (short-lived JWT for WebSocket auth)
// Option A: If using Next.js prepareSession API, ticket is included in response
// Option B: Call /stream-ticket endpoint with cloudAgentSessionId
const ticketResponse = await fetch(
  'https://your-backend.com/api/cloud-agent/sessions/stream-ticket',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${USER_SESSION_TOKEN}`,
    },
    body: JSON.stringify({ cloudAgentSessionId: ack.cloudAgentSessionId }),
  }
);
const { ticket } = await ticketResponse.json();

// 4) Connect to /stream with ticket query parameter
const ws = new WebSocket(`wss://your-worker.dev${ack.streamUrl}&ticket=${ticket}`);
ws.onmessage = event => {
  const payload = JSON.parse(event.data);
  console.log('Stream event:', payload.streamEventType, payload.data);
};

// 5) Queue follow-up messages (FIFO)
await client.sendMessageV2.mutate({
  cloudAgentSessionId: ack.cloudAgentSessionId,
  prompt: 'Implement the improvements',
  mode: 'code',
  model: 'gpt-4o-mini',
});
```

### Legacy Resume (prepareLegacySession + getSession)

Use this flow when a session has a `cloudAgentSessionId` in the DB but is not prepared in the DO
(e.g., sessions created via legacy SSE flows).

```typescript
// 1) Preflight once to detect legacy session state
const session = await client.getSession.query({
  cloudAgentSessionId: 'agent_123e4567-e89b-12d3-a456-426614174000',
});

if (!session.preparedAt) {
  // 2) Backfill DO state using existing IDs and the user's first prompt
  await client.prepareLegacySession.mutate({
    cloudAgentSessionId: session.sessionId,
    kiloSessionId: session.kiloSessionId ?? '',
    ...regular prepareSessionInputs
  });

  // 3) Initiate the prepared legacy session (first prompt is consumed here)
  await client.initiateFromKilocodeSessionV2.mutate({
    cloudAgentSessionId: session.sessionId,
  });
}
```

### Advanced Configuration

Customize the sandbox environment with environment variables, setup commands, and MCP servers. All configurations are set during `prepareSession` and persist across the session lifecycle.

```typescript
const prepared = await client.prepareSession.mutate({
  githubRepo: 'pandemicsyn/velocillama.com',
  kilocodeOrganizationId: '9d278969-5453-4ae3-a51f-a8d2274a7b56', // Optional: omit for personal accounts
  prompt: 'Check if the repo has any open pull requests using the GitHub MCP',
  mode: 'code',
  model: 'anthropic/claude-sonnet-4.5',

  // Optional: Checkout a specific upstream branch instead of creating session/<sessionId>
  upstreamBranch: 'develop',

  // Environment variables - available to all commands and CLI executions
  envVars: {
    SPECIAL_KEY: 'my-name-is-jeff',
    GITHUB_PAT: 'github_pat_11adfadfsomestuff',
  },

  // Setup commands - run during init and on cold starts (after reclone)
  setupCommands: ['npm install', 'npm install -g some-tool'],

  // MCP servers - supports stdio (local), sse, and streamable-http transports
  mcpServers: {
    github: {
      type: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: {
        Authorization: 'Bearer ${env:GITHUB_PAT}',
      },
      timeout: 120,
    },
  },
});

await client.initiateFromKilocodeSessionV2.mutate({
  cloudAgentSessionId: prepared.cloudAgentSessionId,
});
```

**Configuration Details:**

- **upstreamBranch**: Specify an existing branch to work on (optional)
  - Default: Creates and uses `session/<sessionId>` branch
  - Upstream branch behavior: Must exist remotely, fetch + checkout only (no automatic pull between invocations)
  - Session branch behavior: Tries remote first, creates fresh if not found, lenient pull
  - Validation: Git-compatible names (alphanumeric, dots, dashes, underscores, slashes)
  - Use cases: Working on `main`, `develop`, or existing feature branches
  - Note: Cold starts trigger the initial fetch + checkout from a clean state
- **envVars**: Injected into session environment, persist across sandbox restarts
  - Limits: Max 50 variables, keys/values max 256 chars
- **encryptedSecrets**: Encrypted environment variables for sensitive values (backend-to-backend only)
  - Format: RSA+AES envelope encryption per secret (see below)
  - Behavior: Decrypted just-in-time when injecting into CLI environment
  - Security: Never stored unencrypted; requires `AGENT_ENV_VARS_PRIVATE_KEY` worker secret
- **setupCommands**: Run in workspace directory with access to env vars
  - Behavior: Fail-fast on `initiate` (returns 422 with `sessionId`), lenient on `resume`
  - Execution: Only re-run on cold starts (when repo is recloned)
  - Limits: Max 20 commands (500 chars each), 2-minute timeout per command
- **mcpServers**: Written to `.kilocode/cli/global/settings/mcp_settings.json`
  - Types: `stdio` (local process), `sse` (Server-Sent Events), `streamable-http`
  - Limits: Max 20 servers

**Lifecycle:**

1. Session initiation → Config stored in Durable Object
2. Session resume → Config restored; setup/MCP only re-applied if repo was recloned
3. Environment variables → Always injected into every execution

### Encrypted Secrets (Backend-to-Backend)

For sensitive environment variables like API keys and tokens, the `encryptedSecrets` field provides end-to-end encryption. Secrets are encrypted by the backend before being sent to the cloud-agent worker, stored encrypted in the Durable Object, and only decrypted at the moment they're injected into the CLI process environment.

**Envelope Format:**

Each secret uses RSA+AES envelope encryption:

```typescript
{
  encryptedData: string; // Base64-encoded: IV (16 bytes) + ciphertext + authTag (16 bytes)
  encryptedDEK: string; // Base64-encoded RSA-OAEP encrypted data encryption key
  algorithm: 'rsa-aes-256-gcm';
  version: 1;
}
```

**Encryption Flow:**

1. **Backend encrypts** each secret value:
   - Generate random 256-bit DEK (data encryption key)
   - Encrypt secret with AES-256-GCM using the DEK
   - Encrypt DEK with RSA-OAEP (SHA-256) using the worker's public key
   - Package as envelope with `encryptedData` and `encryptedDEK`

2. **Worker stores** encrypted envelopes in Durable Object metadata

3. **At execution time**, worker decrypts:
   - Decrypt DEK using `AGENT_ENV_VARS_PRIVATE_KEY` (RSA private key)
   - Decrypt secret using DEK with AES-256-GCM
   - Merge decrypted secrets with `envVars` into CLI environment

**Worker Configuration:**

The worker requires the `AGENT_ENV_VARS_PRIVATE_KEY` secret to decrypt secrets:

```bash
# Generate RSA key pair (if not already done)
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem

# Set the private key as a worker secret
wrangler secret put AGENT_ENV_VARS_PRIVATE_KEY < private.pem
```

**Security Properties:**

- Secrets are **never stored unencrypted** in the Durable Object
- Decryption happens **just-in-time** when starting CLI process
- Each secret has its own DEK (no key reuse across secrets)
- AES-GCM provides authenticated encryption (integrity + confidentiality)

### Session Preparation (Backend-to-Backend)

The preparation endpoints enable pre-creating sessions before execution starts. This pattern is useful for:

- Large prompts (up to 100KB, avoiding URL size limits)
- Showing "pending" sessions in UI before execution
- Updating session configuration between creation and execution

**Authentication:** These endpoints require dual authentication:

- `x-internal-api-key` header matching `INTERNAL_API_SECRET` env var (server-to-server trust)
- Standard customer token via `Authorization: Bearer <token>` (user identity)

#### `prepareSession`

Creates a session in "prepared" state with all configuration stored in the Durable Object. Note that **you probably don't want to call this directly** SERIOUSLY - and instead call kilocode-backends prepare-session endpoint which will call this endpoint filled out appropriately.

**Example:**

```typescript
const result = await client.prepareSession.mutate({
  prompt: 'Your task description here...', // Up to 100KB
  mode: 'code',
  model: 'anthropic/claude-sonnet-4.5',
  githubRepo: 'facebook/react',
  kilocodeOrganizationId: 'your-org-id', // Optional
  envVars: { API_KEY: 'secret' }, // Optional
  setupCommands: ['npm install'], // Optional
  mcpServers: {
    /* ... */
  }, // Optional
  upstreamBranch: 'main', // Optional
  autoCommit: true, // Optional
  callbackTarget: {
    type: 'http',
    url: 'https://example.com/callbacks/cloud-agent',
  }, // Optional
});

console.log('Session prepared:', result.cloudAgentSessionId);
// cloudAgentSessionId: 'agent_123e4567-e89b-12d3-a456-426614174000'
```

**Input:**

- `prompt` (required): Task prompt (max 100KB)
- `mode` (required): Agent mode (`code`, `architect`, `ask`, `debug`, `orchestrator`)
- `model` (required): AI model identifier
- `githubRepo` or `gitUrl` (required): Repository to work on
- `githubToken` or `gitToken` (optional, deprecated): Pre-generated authentication token for private repos
- `kilocodeOrganizationId` (optional): Organization ID
- `envVars` (optional): Environment variables (max 50, keys/values max 256 chars)
- `encryptedSecrets` (optional): Encrypted environment variables for sensitive values (see below)
- `setupCommands` (optional): Setup commands (max 20, each max 500 chars)
- `mcpServers` (optional): MCP server configurations (max 20)
- `upstreamBranch` (optional): Existing branch to checkout before execution
- `autoCommit` (optional): Auto-commit and push changes after execution
- `callbackTarget` (optional): Callback configuration for execution completion

**Output:**

- `cloudAgentSessionId`: Generated session identifier for later initiation
- `kiloSessionId`: Generated Kilo CLI session ID

#### `prepareLegacySession`

Backfills DO state for legacy sessions that already have a `cloudAgentSessionId`
and `kiloSessionId` (no new CLI session is created).

**Input:**

- All `prepareSession` fields, plus:
- `cloudAgentSessionId` (required): Existing cloud-agent session ID
- `kiloSessionId` (required): Existing Kilo CLI session ID

#### `updateSession`

Updates a prepared (but not yet initiated) session.

**Example:**

```typescript
await client.updateSession.mutate({
  cloudAgentSessionId: 'agent_123e4567-e89b-12d3-a456-426614174000',
  mode: 'architect', // Update mode
  envVars: { NEW_VAR: 'value' }, // Add/update env vars
  // Or clear fields:
  githubToken: null, // Clear token
  setupCommands: [], // Clear all setup commands
});
```

**Input:**

- `cloudAgentSessionId` (required): Session ID from `prepareSession`
- `mode` (optional): Update mode (`null` to clear, `undefined` to skip)
- `model` (optional): Update model (`null` to clear, `undefined` to skip)
- `githubToken` (optional): Update GitHub token (`null` to clear)
- `gitToken` (optional): Update git token (`null` to clear)
- `autoCommit` (optional): Update auto-commit setting (`null` to clear)
- `envVars` (optional): Update environment variables (`{}` to clear all)
- `setupCommands` (optional): Update setup commands (`[]` to clear all)
- `mcpServers` (optional): Update MCP servers (`{}` to clear all)

**Update semantics:**

- `undefined`: Field is not changed
- `null`: Scalar field is cleared
- `{}` or `[]`: Collection is cleared
- Non-empty value: Field is updated

**State machine:**

- Only works on prepared sessions (after `prepareSession`, before initiation)
- Returns error if session hasn't been prepared or has already been initiated

### Queue-Based V2 Endpoints

V2 endpoints enqueue work and return an immediate ack. Output is delivered via the
read-only `/stream` WebSocket for live updates and replay.

**Ack shape (all V2 mutations):**

```ts
{
  cloudAgentSessionId,
  executionId,
  status: 'queued' | 'started',
  streamUrl: `/stream?cloudAgentSessionId=${cloudAgentSessionId}`
}
```

**Endpoints:**

- `initiateFromKilocodeSessionV2`: Prepared-session only (expects `cloudAgentSessionId`).
- `sendMessageV2`: Follow-up messages (expects `cloudAgentSessionId`).

**Streaming output:**

- Obtain a stream ticket via `/stream-ticket` endpoint (or from Next.js `prepareSession` API response)
- Connect to `ws://.../stream?cloudAgentSessionId=...&ticket=<jwt>` with the ticket as a query parameter
- Optional replay: `fromId=<eventId>` to resume from the last seen event

### Stream Event Types

All streaming events use the `streamEventType` discriminator field for type-safe event handling. The API emits:

**1. `streamEventType: 'kilocode'` - Kilocode CLI Events**

Wraps JSON events from the Kilocode CLI, preserving all original fields:

```typescript
{
  streamEventType: 'kilocode',
  payload: {
    type: 'tool_use',           // CLI event type
    tool: 'read_file',           // Tool name
    input: { path: 'test.ts' }   // Tool arguments
  },
  sessionId?: 'agent_123e4567-e89b-12d3-a456-426614174000'  // Optional session binding
}
```

Common `payload.type` values:

- `'tool_use'` - Tool execution (read_file, write_to_file, execute_command, etc.)
- `'progress'` - Step-by-step progress updates
- `'status'` - Status messages from Kilocode
- See [Kilocode CLI documentation](https://github.com/kilocode/kilocode) for complete event types

**2. `streamEventType: 'status'` - System Status**

Infrastructure status messages (initialization, branch operations, configuration):

```typescript
{
  streamEventType: 'status',
  message: 'Cloning repository facebook/react...',
  timestamp: '2025-11-03T22:00:00.000Z',
  sessionId?: 'agent_123e4567-e89b-12d3-a456-426614174000'
}
```

**3. `streamEventType: 'output'` - System Output**

Non-JSON stdout/stderr from CLI execution (ANSI escape sequences automatically stripped):

```typescript
{
  streamEventType: 'output',
  content: 'Installing dependencies...',
  source: 'stdout' | 'stderr',
  timestamp: '2025-11-03T22:00:00.000Z',
  sessionId?: 'agent_123e4567-e89b-12d3-a456-426614174000'
}
```

**4. `streamEventType: 'error'` - System Errors**

System-level error events (exit codes, stream failures):

```typescript
{
  streamEventType: 'error',
  error: 'CLI exited with code 1',
  details?: any,                         // Optional error context
  timestamp: '2025-11-03T22:00:00.000Z',
  sessionId?: 'agent_123e4567-e89b-12d3-a456-426614174000'
}
```

**5. `streamEventType: 'complete'` - Task Completion**

Final event with execution results (no task history included in streaming):

```typescript
{
  streamEventType: 'complete',
  taskId: 'task_abc123',
  sessionId: 'agent_123e4567-e89b-12d3-a456-426614174000',  // Always present
  exitCode: 0,
  metadata: {
    executionTimeMs: 45230,
    workspace: '/workspace/org-id/user-id/sessions/agent_123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-id',
    startedAt: '2025-11-03T22:00:00.000Z',
    completedAt: '2025-11-03T22:00:45.230Z'
  }
}
```

### Session Management

Endpoints for querying and managing session state without streaming.

#### `getSession`

Retrieves session metadata without secrets. This query enables the frontend to check session state before initiating, supporting idempotent session execution where page refreshes don't restart already-initiated sessions.

**Type:** Query (not mutation)

**Authentication:** Standard customer token only (`protectedProcedure`) — no backend key required.

**Example:**

```typescript
// Check if session has already been initiated
const session = await client.getSession.query({
  cloudAgentSessionId: 'agent_123e4567-e89b-12d3-a456-426614174000',
});

if (session.initiatedAt) {
  console.log('Session already initiated at:', new Date(session.initiatedAt));
  // Connect to existing session instead of re-initiating
} else if (session.preparedAt) {
  console.log('Session prepared but not initiated, safe to start');
}
```

**Input:**

- `cloudAgentSessionId` (required): Session ID to query

**Output (sanitized — no secrets returned):**

```typescript
{
  // Session identifiers
  sessionId: string;              // Cloud-agent session ID
  kiloSessionId?: string;         // Linked Kilocode CLI session UUID
  userId: string;                 // Owner user ID
  orgId?: string;                 // Organization ID (if org account)

  // Repository info (no tokens)
  githubRepo?: string;            // e.g., 'facebook/react'
  gitUrl?: string;                // Raw git URL (without credentials)

  // Execution params
  prompt?: string;                // Task prompt
  mode?: 'architect' | 'code' | 'ask' | 'debug' | 'orchestrator';
  model?: string;                 // AI model identifier
  autoCommit?: boolean;           // Auto-commit setting
  upstreamBranch?: string;        // Branch being worked on

  // Configuration metadata (counts only, no values)
  envVarCount?: number;           // Number of configured env vars
  setupCommandCount?: number;     // Number of setup commands
  mcpServerCount?: number;        // Number of MCP servers

  // Lifecycle timestamps (critical for idempotency)
  preparedAt?: number;            // Unix timestamp when prepared
  initiatedAt?: number;           // Unix timestamp when initiated

  // Versioning
  timestamp: number;              // Last update timestamp
  version: number;                // Optimistic concurrency version
}
```

**Error Cases:**

- `NOT_FOUND`: Session not found (either doesn't exist or belongs to different user)

**Security Notes:**

- Returns metadata only — no secrets (tokens, env var values, etc.)
- Configuration counts (envVarCount, setupCommandCount, mcpServerCount) instead of actual values
- Enforces user ownership — cannot query other users' sessions

**Use Cases:**

- **Idempotent initiation**: Check `initiatedAt` before calling `initiateFromKilocodeSessionV2`
- **UI state sync**: Display session status after page refresh
- **Progress tracking**: Show preparation vs initiation state in UI

#### `interruptSession`

Kills all running Kilocode processes associated with a session. The session remains active and can be used for subsequent tasks.

**Example:**

```typescript
// Interrupt a running session
const result = await client.interruptSession.mutate({
  sessionId: 'agent_123e4567-e89b-12d3-a456-426614174000',
});

console.log('Interrupt result:', result);
// {
//   success: true,
//   killedProcessIds: ['proc_123', 'proc_456'],
//   failedProcessIds: [],
//   message: 'Interrupted execution: killed 2 process(es)'
// }
```

**Response:**

```typescript
interface InterruptResult {
  success: boolean;
  killedProcessIds: string[]; // IDs of successfully killed processes
  failedProcessIds: string[]; // IDs of processes that failed to kill
  message: string; // Human-readable summary
}
```

**Notes:**

- Idempotent: Safe to call multiple times; returns success even if no processes are running
- Non-destructive: Session remains active and can continue to be used
- Process identification: Only kills processes with `kilocode` in their command and matching workspace path
- Use case: Cancel stuck operations, stop unintended long-running tasks, or reset session state
- Streaming behavior: Interrupts emit `streamEventType: 'interrupted'` and short-circuit post-exec steps (auto-commit, task discovery). A `complete` event with `taskId` is not sent when an execution is interrupted.

## Development

### Prerequisites

- Cloudflare Workers CLI (`wrangler`)

### Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment variables:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your credentials
# The worker will reuse the Authorization bearer token as the kilo code api token (because thats what it is).
```

3. Run locally:

```bash
pnpm --filter cloud-agent
```

### Local Development with Dockerfile.dev

For development with a local/custom Kilocode CLI build, use the `dev` environment which uses `Dockerfile.dev` to create a sandbox image with your CLI changes.

#### Prerequisites

1. Clone and build the Kilocode CLI from the [kilocode repository](https://github.com/Kilo-Org/kilocode):

```bash
# In the kilocode repo directory
cd kilocode
pnpm install
pnpm cli:bundle
cd cli && npm pack ./dist
mv kilocode-cli-*.tgz ../kilocode-cli.tgz
```

2. Copy the CLI tarball to the cloud-agent directory:

```bash
cp kilocode/kilocode-cli.tgz cloud-agent/
```

#### The Dev Environment

The `dev` named environment in [`wrangler.jsonc`](wrangler.jsonc:128) automatically:

- Uses `./Dockerfile.dev` for the sandbox container image
- Sets `KILOCODE_BACKEND_BASE_URL=http://localhost:3000` you will almost certainly want to override this.

#### Building the Dev Image

When you run the dev environment, Cloudflare will build `Dockerfile.dev` automatically.

#### Environment Variables

Copy and configure `.dev.vars`:

```bash
cp .dev.vars.example .dev.vars
```

#### Running

```bash
# Start the worker in dev mode with the dev environment
pnpm --filter cloud-agent dev -- --env dev

# Or directly with wrangler:
cd cloud-agent && wrangler dev --env dev
```

### GitHub Actions Deployment

This project also ships with an on-demand GitHub Action (`Deploy Cloud Agent`) located at
`.github/workflows/deploy-cloud-agent.yml`. To trigger it:

1. In GitHub, open the **Actions** tab and select **Deploy Cloud Agent**.
2. Click **Run workflow**, choose the target environment (`dev` or `prod`), and confirm.
3. The workflow checks out the repo, installs dependencies with pnpm, and runs
   `wrangler deploy --env <environment>` inside `cloud-agent/`.

Required secrets:

- `CLOUDFLARE_API_TOKEN` — must have permission to deploy the worker for the selected environment.

### Testing

This project uses a dual testing approach with separate configurations for unit and integration tests:

#### Unit Tests (Node.js)

Fast tests that run in Node.js with full mocking support. Use these for testing pure business logic, utilities, and functionality that doesn't require the Cloudflare Workers runtime.

```bash
# Run unit tests (src/**/*.test.ts)
pnpm --filter cloud-agent test

# Watch mode
pnpm --filter cloud-agent test:watch
```

**When to use:** Testing pure TypeScript logic, utility functions, type guards, data transformations, and any code that doesn't directly interact with Cloudflare Workers APIs (Durable Objects, queues, KV, etc.).

#### Integration Tests (Cloudflare Workers Runtime)

Tests that run in the actual Cloudflare Workers runtime via Miniflare using `@cloudflare/vitest-pool-workers`. These tests have access to real Durable Objects, queues, and other Workers APIs through the `cloudflare:test` module.

```bash
# Run integration tests (test/**/*.test.ts)
pnpm --filter cloud-agent test:integration

# Watch mode
pnpm --filter cloud-agent test:integration:watch

# Run both unit and integration tests
pnpm --filter cloud-agent test:all
```

**When to use:** Testing Durable Object behavior, queue consumers, WebSocket handling, SQLite storage, alarms, and any functionality that depends on the Cloudflare Workers runtime. Integration tests use utilities like `runInDurableObject`, `createMessageBatch`, and `getQueueResult` from `cloudflare:test`.

#### Other Quality Checks

```bash
# Type checking
pnpm --filter cloud-agent typecheck

# Linting
pnpm --filter cloud-agent lint
pnpm --filter cloud-agent lint:fix
```

## Architecture

### Multi-Session Model

The cloud agent uses a **one sandbox (container) per organization/user** architecture with **N sessions per sandbox**:

- **Sandbox**: Isolated container with scope based on account type:
  - **Organization accounts**: `${organizationId}__${userId}` (e.g., `org-123__user-456`)
  - **Personal accounts**: `user:${userId}__${userId}` (e.g., `user:abc-123__abc-123`)
  - **Bot/service isolation**: Optional `__bot:${botId}` suffix (e.g., `org-123__user-456__bot:reviewer`)
  - One sandbox per unique org/user or user/bot combination
  - Multiple users in same org get separate sandboxes
  - Sandboxes persist across HTTP requests and share filesystem
- **Sessions**: Like bash shell execution contexts within a sandbox. Think of them like terminal tabs or panes in the same container.
  - Multiple sessions can run concurrently in the same sandbox
  - Each session has its own working directory, HOME, and git workspace
  - Sessions maintain separate shell state (env vars, cwd) but share the container filesystem

This architecture enables efficient resource utilization while maintaining strong isolation between organizations, users, bots, and sessions.

### Session Management

The `SessionService` orchestrates session lifecycle:

- **Initiate (V2: `prepareSession` + `initiateFromKilocodeSessionV2`)**
  - Creates a session-specific HOME (`/home/<sessionId>`) so the Kilocode CLI keeps config/logs/tasks per session
  - Calls `setupWorkspace` to build `/workspace/${organizationId}/${userId}/sessions/${sessionId}`
  - Clones the requested repository directly into the workspace path using the session service
  - Ensures a git branch (either `session/<sessionId>` or the specified `upstreamBranch`)
  - Runs setup commands and configures MCP servers if provided
- **Resume (V2: `sendMessageV2`)**
  - Rehydrates the `SessionContext` for an existing workspace
  - Refreshes runtime config for the requested model/token
  - Reattaches/creates the Cloudflare session (branch ops only for prepared sessions)
  - Re-runs setup commands only on cold starts (when repo was recloned)

### Session Linking

Cloud-agent sessions are bidirectionally linked to Kilocode CLI sessions:

- **Cloud → Kilo**: `prepareSession` creates a CLI session and links IDs; `prepareLegacySession` preserves an existing link.
- **Kilo → Cloud**: The `cloud_agent_session_id` is stored in the backend's `cli_sessions` table for reverse lookup.

This enables:

- Resuming local Kilocode sessions in the cloud
- Finding which cloud-agent session corresponds to a Kilocode session
- Seamless transition between local and cloud development

**Identifiers:**

- **Cloud-Agent Session ID**: `agent_${uuid}` (e.g., `agent_123e4567-e89b-12d3-a456-426614174000`)
- **Kilocode CLI Session ID**: `${uuid}` (e.g., `601313d3-0dd7-4d4c-af24-5e0014398a86`)

### Identifiers & Paths

- **Session ID**: `agent_${uuid}` (e.g., `agent_123e4567-e89b-12d3-a456-426614174000`)
- **Sandbox ID**:
  - Organization accounts: `${organizationId}__${userId}`
  - Personal accounts: `user:${userId}__${userId}`
  - With bot isolation: `${organizationId}__${userId}__bot:${botId}`
- **Workspace Path**:
  - Organization accounts: `/workspace/${organizationId}/${userId}/sessions/${sessionId}`
  - Personal accounts: `/workspace/${userId}/sessions/${sessionId}`
- **Session HOME**: `/home/${sessionId}` (exported as `HOME` for all CLI invocations)
- **Branch**: `session/${sessionId}` (default) or specified upstream branch

### GitHub Integration

- Repository cloning happens during `SessionService.initiate` using the session service clone helpers
- Branch handling:
  - **Default**: Creates isolated `session/<sessionId>` branches for each session
  - **Upstream branches**: Use `upstreamBranch` to work on existing branches (e.g., `main`, `develop`)
  - Upstream branches must exist remotely; checkout only (no automatic pull)
  - Rationale: Fetch-only approach for upstream branches provides consistent, predictable state
  - Session branches support lenient pulls and can be created fresh if not found
- Works with both public and private repositories
- After cloning, git user/email defaults to `Kilo Code Cloud <cloud@kilocode.com>`

#### GitHub App Token Generation

For V2 routes (`sendMessageV2`, `initiateFromKilocodeSessionV2`), the cloud-agent generates GitHub App installation tokens on-demand.

**How it works:**

1. **Automatic installation lookup**: The worker automatically looks up the GitHub App installation ID from the database via Hyperdrive. The lookup verifies the user has access to the repository's organization.
2. **On-demand token generation**: When execution starts, `GitHubTokenService` generates a fresh token using `@octokit/auth-app`
3. **KV caching**: Tokens are cached in Cloudflare KV with 30-minute TTL (tokens valid for 1 hour)
4. **Cache key format**: `github-token:installation:{installationId}`

**Configuration:**

The worker requires these environment variables:

- `GITHUB_APP_ID`: GitHub App ID (configured in `wrangler.jsonc`)
- `GITHUB_APP_PRIVATE_KEY`: RSA private key for the GitHub App (set via `wrangler secret put`)
- `GITHUB_TOKEN_CACHE`: KV namespace binding for token caching
- `HYPERDRIVE`: Hyperdrive binding for database access (installation ID lookup)

**Benefits:**

- No need to pass `githubInstallationId` — automatically resolved from database
- Tokens generated closer to where they're used (reduced latency)
- Fresh tokens on-demand rather than at session start
- Rate limit protection via KV caching
- No token expiry issues during long sessions
