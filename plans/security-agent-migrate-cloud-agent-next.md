# Security Agent: Migrate from cloud-agent to cloud-agent-next

## Background

The security agent's Tier 2 sandbox analysis currently uses the **old `cloud-agent`** SSE-based streaming API (`client.initiateSessionStream()`). This needs to migrate to **`cloud-agent-next`**, which uses a two-step `prepareSession` + `initiateFromPreparedSession` pattern with callback-based completion notifications instead of SSE streaming.

### Current integration (3 import points)

| File                                                              | Import                               | Role                                                           |
| ----------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `src/lib/security-agent/services/analysis-service.ts`             | `createCloudAgentClient`             | Creates old cloud-agent client for Tier 2 sandbox analysis     |
| `src/lib/security-agent/services/analysis-service.ts`             | `StreamEvent`, `SystemKilocodeEvent` | Old SSE stream event types consumed in `processAnalysisStream` |
| `src/routers/security-agent-router.ts`                            | `getGitHubTokenForUser`              | Shared GitHub helper (lives in old directory, stays unchanged) |
| `src/routers/organizations/organization-security-agent-router.ts` | `getGitHubTokenForOrganization`      | Shared GitHub helper (lives in old directory, stays unchanged) |

### Current flow (Tier 2 only)

```
startSecurityAnalysis()
  → createCloudAgentClient(authToken)
  → client.initiateSessionStream({ githubRepo, githubToken, prompt, mode, model })
  → Returns AsyncGenerator<StreamEvent>
  → Fire-and-forget: processAnalysisStream()
      → Consumes SSE stream events:
          'status'      → capture cloudAgentSessionId, update DB
          'kilocode'    → capture cliSessionId from session_created event, update DB
          'error'       → mark analysis failed
          'interrupted' → mark analysis failed
          'complete'    → fetch result from R2 blob via cli_sessions table
      → Fetch from R2: cli_sessions.ui_messages_blob_url → getBlobContent()
      → Parse RawCliMessage[] → extract completion_result or last text message
      → Tier 3: extractSandboxAnalysis() → direct LLM call
      → Store analysis, attempt auto-dismiss
```

### Target flow

```
startSecurityAnalysis()
  → createCloudAgentNextClient(authToken)
  → client.prepareSession({
      prompt, mode: 'code', model, githubRepo, githubToken,
      kilocodeOrganizationId,
      callbackTarget: { url, headers }
    })
  → Returns { cloudAgentSessionId, kiloSessionId }
  → Update DB with both session IDs
  → client.initiateFromPreparedSession({ cloudAgentSessionId })
  → Returns immediately (fire-and-forget)

  ... cloud-agent-next executes the analysis ...

  → cloud-agent-next POSTs ExecutionCallbackPayload to callbackTarget.url
     (payload includes kiloSessionId)
  → Callback handler (new internal API route):
      → Validates secret header
      → On 'completed': fetch session export from ingest service using kiloSessionId,
        extract last assistant message text (raw markdown),
        write raw markdown to `analysis` field in security_findings table,
        run Tier 3
      → On 'failed'/'interrupted': mark analysis failed
      → Store structured analysis, attempt auto-dismiss
```

### Critical requirement: populating the `analysis` field

The old cloud-agent flow's `processAnalysisStream()` fetches the raw markdown content from the R2 blob on stream completion and writes it to the `analysis` column in the `security_findings` table. **This `analysis` field is what powers the summary shown to users when they click on an auto-dismissed security finding** — without it, dismissed findings appear with no explanation.

The migration to cloud-agent-next replaces the SSE stream with a callback-based pattern, but this introduces a gap: the callback handler must explicitly ensure the `analysis` field gets populated with the markdown analysis content after cloud-agent-next completes its work. Specifically:

1. When the callback fires with `status: 'completed'`, the handler fetches the session export from the ingest service and extracts the last assistant message (raw markdown).
2. This raw markdown content **must** be written to the `analysis` field in the `security_findings` table — this is the user-facing analysis summary.
3. The Tier 3 structured extraction (`extractSandboxAnalysis()`) then runs on this same content to produce the structured `isExploitable` / `severity` / `explanation` fields, but the raw markdown in `analysis` is what the UI displays.

This requirement is addressed in Phase 2.2 step 4a below.

### Architecture decision: session-ingest vs cloud-agent-next for result retrieval

The analysis result is retrieved from the **session-ingest service** (`cloudflare-session-ingest`), NOT from cloud-agent-next's stored events. Reasons:

1. **Compacted data**: The ingest service stores final-state messages (UPSERT by item ID), while cloud-agent-next stores an append-only log of streaming deltas. The ingest export provides the complete assistant text directly — no delta reconstruction needed.

2. **Existing API**: The ingest service already has `GET /api/session/:sessionId/export` with JWT auth. No new endpoints needed.

3. **Canonical source**: The ingest service is the long-term home for session data. Cloud-agent-next may stop storing CLI events in the future.

4. **Session ID alignment**: The ingest service uses `kiloSessionId` (available from `prepareSession` response and the callback payload), not `cloudAgentSessionId`.

The export returns a `SharedSessionSnapshot` with `{ info, messages: [{ info: { role, ... }, parts: [{ type, text, ... }] }] }`. Extracting the final result is trivial: find the last message with `role === 'assistant'`, concatenate its `text`-type parts.

---

## Phase 1: Add session-ingest export helper and result extraction

No changes to the cloud-agent-next worker or session-ingest worker are needed. This phase adds a small helper in the Next.js app to call the ingest service's existing export API.

### 1.1 Add session-ingest export client

**File:** `src/lib/session-ingest/client.ts` (new)

A helper module that:

- Takes a `kiloSessionId` and `userId`
- Generates a JWT using `NEXTAUTH_SECRET` + `JWT_TOKEN_VERSION` (same pattern as `generateGdprDeletionToken` in `external-services.ts`)
- Calls `GET ${SESSION_INGEST_WORKER_URL}/api/session/${kiloSessionId}/export`
- Returns the parsed `SharedSessionSnapshot` or `null` if not found
- Handles errors with Sentry capture

```ts
import { SESSION_INGEST_WORKER_URL, NEXTAUTH_SECRET } from '@/lib/config.server';
import jwt from 'jsonwebtoken';
import { JWT_TOKEN_VERSION } from '@/lib/tokens';
import { captureException } from '@sentry/nextjs';

type SharedSessionSnapshot = {
  info: Record<string, unknown>;
  messages: Array<{
    info: { id: string; role?: string; [key: string]: unknown };
    parts: Array<{ id: string; type?: string; text?: string; [key: string]: unknown }>;
  }>;
};

function generateIngestToken(userId: string): string {
  return jwt.sign({ kiloUserId: userId, version: JWT_TOKEN_VERSION }, NEXTAUTH_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
}

async function fetchSessionExport(
  kiloSessionId: string,
  userId: string
): Promise<SharedSessionSnapshot | null> {
  if (!SESSION_INGEST_WORKER_URL) {
    throw new Error('SESSION_INGEST_WORKER_URL not configured');
  }

  const token = generateIngestToken(userId);
  const response = await fetch(
    `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(kiloSessionId)}/export`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Ingest export failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
```

### 1.2 Add result extraction helper

**File:** Same module

```ts
function extractLastAssistantMessage(snapshot: SharedSessionSnapshot): string | null {
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const msg = snapshot.messages[i];
    if (msg.info.role === 'assistant') {
      const text = msg.parts
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text)
        .join('');
      if (text.length > 0) return text;
    }
  }
  return null;
}
```

This replaces the current `fetchLastAssistantMessage` (~95 lines querying R2 blobs) with ~15 lines.

### 1.3 Write tests

Test `fetchSessionExport`:

- Mock fetch, verify JWT is generated with correct `kiloUserId` and `version`
- 200 response → returns parsed snapshot
- 404 response → returns `null`
- 500 response → throws error

Test `extractLastAssistantMessage`:

- Snapshot with no messages → `null`
- Snapshot with no assistant messages → `null`
- Snapshot with one assistant message with text parts → returns concatenated text
- Snapshot with multiple assistant messages → returns last one
- Snapshot with assistant message having mixed part types (text + tool) → returns only text
- Snapshot with assistant message having empty text → skips to next

---

## Phase 2: Create internal callback endpoint

### 2.1 Create the callback route

**New file:** `src/app/api/internal/security-analysis-callback/[findingId]/route.ts`

This endpoint receives the `ExecutionCallbackPayload` from cloud-agent-next when the sandbox analysis completes, fails, or is interrupted.

**Pattern:** follows existing internal API convention (see `src/app/api/internal/code-review-status/[reviewId]/route.ts`):

```ts
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { captureException } from '@sentry/nextjs';

type ExecutionCallbackPayload = {
  sessionId: string;
  cloudAgentSessionId: string;
  executionId: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  kiloSessionId?: string;
  lastSeenBranch?: string;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ findingId: string }> }
) {
  // 1. Validate X-Internal-Secret header
  const secret = req.headers.get('X-Internal-Secret');
  if (secret !== INTERNAL_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { findingId } = await params;
  const payload: ExecutionCallbackPayload = await req.json();

  // 2. Validate required fields
  // 3. Dispatch based on status:
  //    - 'completed' → handleAnalysisCompleted(findingId, payload)
  //    - 'failed' | 'interrupted' → handleAnalysisFailed(findingId, payload)
  // 4. Return { success: true }
}
```

### 2.2 Implement `handleAnalysisCompleted`

When status is `'completed'`:

1. Look up the finding from DB to get metadata (model, owner, userId, correlationId, organizationId) — stored in `finding.analysis` when analysis starts (see Phase 3)
2. Extract `kiloSessionId` from the callback payload (confirmed present for prepared sessions)
3. Call `fetchSessionExport(kiloSessionId, userId)` to get the session snapshot from the ingest service
4. Call `extractLastAssistantMessage(snapshot)` to get the raw markdown result
   - a. **Write the raw markdown to the `analysis` field** in the `security_findings` table. This is critical — the `analysis` field is what the UI displays when a user clicks on an auto-dismissed finding to see the summary. The old flow populated this via `processAnalysisStream()`; the callback handler must do the equivalent. Use `updateAnalysisStatus(findingId, 'running', { analysis: rawMarkdown })` or a direct DB update to persist the raw content before proceeding to Tier 3.
5. If no result found, retry up to 3 times with 5s delay (handles timing race where ingest hasn't finished processing yet)
6. Run Tier 3: `extractSandboxAnalysis()` on the raw markdown — unchanged from current code
7. Store the structured analysis via `updateAnalysisStatus(findingId, 'completed', { analysis })` — this merges the Tier 3 structured fields (isExploitable, severity, explanation) into the analysis JSON alongside the raw markdown already written in step 4a
8. Attempt auto-dismiss if `isExploitable === false`
9. Track PostHog completion event

### 2.3 Implement `handleAnalysisFailed`

When status is `'failed'` or `'interrupted'`:

1. Update finding: `updateAnalysisStatus(findingId, 'failed', { error: payload.errorMessage })`
2. Track PostHog failure event

### 2.4 Store analysis context for callback retrieval

The callback endpoint needs context that was available during `startSecurityAnalysis` but isn't in the callback payload.

**Approach:** Store context in the existing `analysis` JSON field when starting the analysis. The callback handler reads it back from the finding.

```ts
const partialAnalysis: SecurityFindingAnalysis = {
  triage,
  analyzedAt: new Date().toISOString(),
  modelUsed: model,
  triggeredByUserId: user.id,
  correlationId,
};
await updateAnalysisStatus(findingId, 'pending', { analysis: partialAnalysis });
```

The callback handler retrieves `model`, `triggeredByUserId`, `correlationId` from `finding.analysis`. The `organizationId` and `owner` can be derived from the finding's ownership fields. **No schema changes needed.**

For the auth token: since the callback may arrive minutes later, the callback handler generates a fresh token for the ingest service using the `userId` from `finding.analysis.triggeredByUserId`. For the Tier 3 LLM call, it loads the user from DB and generates a fresh `generateApiToken()`.

---

## Phase 3: Rewrite Tier 2 in analysis-service.ts

### 3.1 Replace client creation and session initiation

**File:** `src/lib/security-agent/services/analysis-service.ts`

**Old code:**

```ts
const client = createCloudAgentClient(authToken);
const streamGenerator = client.initiateSessionStream({
  githubRepo, githubToken, kilocodeOrganizationId: organizationId,
  prompt, mode: 'code', model,
});
void processAnalysisStream(findingId, streamGenerator, model, owner, ...);
```

**New code:**

```ts
import { createCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import { APP_URL } from '@/lib/constants';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

const client = createCloudAgentNextClient(authToken);

const callbackUrl = `${APP_URL}/api/internal/security-analysis-callback/${findingId}`;

const { cloudAgentSessionId, kiloSessionId } = await client.prepareSession({
  prompt,
  mode: 'code',
  model,
  githubRepo,
  githubToken,
  kilocodeOrganizationId: organizationId,
  callbackTarget: {
    url: callbackUrl,
    headers: { 'X-Internal-Secret': INTERNAL_API_SECRET },
  },
});

// Store session IDs immediately (before initiation)
await updateAnalysisStatus(findingId, 'running', {
  sessionId: cloudAgentSessionId,
  cliSessionId: kiloSessionId,
});

await client.initiateFromPreparedSession({ cloudAgentSessionId });
```

### 3.2 Store analysis context for callback

When updating the finding to `'pending'` with partial analysis, include the context the callback handler will need (see Phase 2.4).

### 3.3 Handle `prepareSession` / `initiateFromPreparedSession` errors

Wrap both calls in try/catch:

- `prepareSession` failure → `updateAnalysisStatus(findingId, 'failed', { error })`
- `initiateFromPreparedSession` failure → same, plus clean up via `client.deleteSession(cloudAgentSessionId)`
- `InsufficientCreditsError` → propagate up (same as current behavior)

---

## Phase 4: Delete dead code

### 4.1 Remove `processAnalysisStream` function

**File:** `src/lib/security-agent/services/analysis-service.ts` (lines 352-557)

This ~200-line function is entirely replaced by the callback handler. Delete it.

### 4.2 Remove `fetchLastAssistantMessage` function

**File:** `src/lib/security-agent/services/analysis-service.ts` (lines 143-237)

This function fetches results from R2 blobs via the old `cli_sessions` table. No longer needed — results come from the ingest service export. Delete it.

### 4.3 Remove helper types and functions

**File:** `src/lib/security-agent/services/analysis-service.ts`

- `RawCliMessage` type (lines 119-127) — R2 blob message format, no longer needed
- `getCliMessageContent` function (lines 132-137) — R2 blob helper, no longer needed
- `isSessionCreatedEvent` function (lines 108-110) — old SSE event helper, no longer needed

### 4.4 Remove old imports

**File:** `src/lib/security-agent/services/analysis-service.ts`

Remove:

```ts
import { createCloudAgentClient } from '@/lib/cloud-agent/cloud-agent-client';
import type { StreamEvent, SystemKilocodeEvent } from '@/components/cloud-agent/types';
import { cliSessions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getBlobContent } from '@/lib/r2/cli-sessions';
```

### 4.5 Move `finalizeAnalysis` to callback handler

The `finalizeAnalysis` function (lines 249-339) contains the Tier 3 extraction + storage + auto-dismiss logic. This logic needs to move into (or be called from) the callback handler's `handleAnalysisCompleted`. It can remain as an exported function in `analysis-service.ts` and be imported by the callback route.

---

## Phase 5: Update frontend session links

### 5.1 Verify link format compatibility

The `/cloud/chat?sessionId=` URL already auto-routes between old and new UIs based on the session ID prefix:

- Old cloud-agent session IDs: no `ses_` prefix → routes to old `CloudChatPageWrapper`
- cloud-agent-next session IDs: `ses_` prefix → routes to new `CloudChatPageWrapperNext`

**File:** `src/app/(app)/cloud/chat/page.tsx` (line 14): `isNewSession(sessionId)` checks for `ses_` prefix.

Since `prepareSession` returns a `kiloSessionId` with a `ses_` prefix, the existing link format **already works** — no URL structure change needed.

### 5.2 Update security findings to use `kiloSessionId`

The `cli_session_id` field in `security_findings` currently stores the old cli session ID (UUID format). After migration, it will store the `kiloSessionId` from `prepareSession` (which has `ses_` prefix). The frontend components that read `cli_session_id` to construct the link don't need changes — they just pass the ID as a query param.

**Verify:** no changes needed to:

- `src/components/security-agent/FindingDetailDialog.tsx`
- `src/components/security-agent/AnalysisJobsCard.tsx`

---

## Summary of files changed

| File                                                                   | Change                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/session-ingest/client.ts`                                     | **New** — helper to fetch session export from ingest service + extract assistant message                                       |
| `src/app/api/internal/security-analysis-callback/[findingId]/route.ts` | **New** — callback endpoint for cloud-agent-next execution completion                                                          |
| `src/lib/security-agent/services/analysis-service.ts`                  | Major rewrite: replace old client + SSE stream with cloud-agent-next prepare+initiate+callback; delete ~400 lines of dead code |
| `src/components/security-agent/FindingDetailDialog.tsx`                | Verify only — links should work as-is with `ses_` prefixed session IDs                                                         |
| `src/components/security-agent/AnalysisJobsCard.tsx`                   | Verify only — same as above                                                                                                    |

## Files NOT changed

| File                                                              | Reason                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `cloud-agent-next/` (any file)                                    | No worker changes needed — uses existing callback + ingest service                     |
| `src/lib/cloud-agent-next/cloud-agent-client.ts`                  | No new methods needed — `prepareSession` + `initiateFromPreparedSession` already exist |
| `cloudflare-session-ingest/` (any file)                           | No ingest worker changes needed — uses existing `/api/session/:id/export`              |
| `src/routers/security-agent-router.ts`                            | `getGitHubTokenForUser` is a shared utility, not cloud-agent-specific                  |
| `src/routers/organizations/organization-security-agent-router.ts` | Same — `getGitHubTokenForOrganization` stays                                           |
| `src/lib/security-agent/services/triage-service.ts`               | Tier 1 uses direct LLM calls, no cloud-agent                                           |
| `src/lib/security-agent/services/extraction-service.ts`           | Tier 3 uses direct LLM calls, no cloud-agent                                           |
| DB schema for `security_findings`                                 | Existing `session_id` and `cli_session_id` columns reused with new values              |

## Risks and considerations

1. **Auth token lifetime:** The callback may arrive minutes after the original request. The stored `authToken` may be expired. The callback handler generates a fresh JWT for the ingest service using `NEXTAUTH_SECRET` (no user-specific token needed). For the Tier 3 LLM call, it loads the user from DB and generates a fresh `generateApiToken()`.

2. **Timing race — ingest vs callback:** The callback fires when cloud-agent-next's execution completes, but the ingest service receives events from the CLI via a separate path. The callback could theoretically arrive before the last CLI events are ingested. Mitigations:
   - The Cloudflare Queue delivers callbacks with base 60s retry and exponential backoff — this provides natural delay.
   - The CLI flushes events before exiting, and the execution only completes after the CLI exits.
   - The callback handler retries fetching the export up to 3 times with 5s delay if no assistant message is found.

3. **Reliability improvement:** The callback pattern with Cloudflare Queue (5 retries, exponential backoff) is more reliable than the current SSE stream, which can silently fail if the Next.js process loses the connection.

4. **Feature flag / gradual rollout:** Consider gating the migration behind a feature flag or rolling it out per-organization. This allows fallback to the old cloud-agent path if issues arise. The triage-only path (Tier 1) is unaffected and continues working regardless.

5. **Backwards compatibility of session links:** Old findings analyzed before the migration will still have old-format session IDs in `cli_session_id`. The `/cloud/chat` page already handles both formats (line 14 of `page.tsx` checks `isNewSession`), so old links continue working.

6. **`analysis` field must be populated (migration gap):** The old flow's `processAnalysisStream()` writes the raw markdown analysis content to the `analysis` field in `security_findings` on stream completion. This field powers the user-facing summary shown when clicking on an auto-dismissed finding. The callback-based flow must explicitly replicate this — the callback handler in Phase 2.2 (step 4a) writes the raw markdown from the ingest service export to the `analysis` field before running Tier 3. If this step is missed, auto-dismissed findings will have no visible explanation in the UI.

---

## PR and Deployment Strategy

This migration only requires changes to the Next.js app. No worker deployments needed.

### PR 1: Add session-ingest export helper + result extraction

**Scope:** Phase 1 (helper module + tests)

**Files changed:**

- `src/lib/session-ingest/client.ts` (new)
- Tests

**Deploy:** Merges to the Next.js app. Purely additive — adds a helper nobody calls yet. Zero risk.

### PR 2: Security agent migration (main PR)

**Scope:** Phases 2, 3, 4, 5

**Files changed:**

- `src/app/api/internal/security-analysis-callback/[findingId]/route.ts` (new)
- `src/lib/security-agent/services/analysis-service.ts` (major rewrite)

**Prerequisite:** PR 1 merged.

This is the critical PR. It switches the security agent from old cloud-agent to cloud-agent-next. Everything in this PR is behind the existing Tier 2 code path (only runs when `forceSandbox || triage.needsSandboxAnalysis`), so Tier 1 triage-only analyses are completely unaffected.

**Deploy:** Standard Next.js deploy. Once live, all new Tier 2 analyses use cloud-agent-next.

**Verification:**

1. Trigger an analysis on a finding that requires sandbox analysis (either via `forceSandbox: true` or a finding that triage routes to Tier 2)
2. Confirm the callback endpoint receives the completion notification
3. Confirm the result is extracted from the ingest service and stored correctly
4. Confirm the `analysis` field in `security_findings` contains the raw markdown content (this powers the user-facing summary for auto-dismissed findings)
5. Confirm the "View agent session" link in the UI opens the correct cloud-agent-next chat view

### Deployment order

```
PR 1 (helper) ──merge──→ ingest client helper available
                            │
                            ▼
PR 2 (migration) ──merge + deploy──→ Security agent uses cloud-agent-next
```

### Rollback plan

- **PR 2 rollback:** Revert the Next.js deploy. The old cloud-agent is still running and the old code path works. Findings that had analysis started via cloud-agent-next during the brief window will show as `failed` (callback arrives but the handler is gone) — these can be re-analyzed.
- **PR 1 is safe to leave** — it's a helper module with no callers once PR 2 is reverted.

### Feature flag consideration

The migration could be gated behind a feature flag (e.g., `security-agent-cloud-agent-next`) in `startSecurityAnalysis`. The flag would control which client to use — old `createCloudAgentClient` + SSE stream path vs new `createCloudAgentNextClient` + callback path. Given that the security agent is relatively low-traffic (runs per-finding, not per-request), a flag may be overkill — but it's available if the team prefers it.

### Cleanup PR (optional, after confidence)

Once the migration is verified in production:

- Remove the feature flag if one was added
- Consider whether the `getGitHubTokenForUser`/`getGitHubTokenForOrganization` helpers should be moved out of the `cloud-agent/` directory into a shared location
