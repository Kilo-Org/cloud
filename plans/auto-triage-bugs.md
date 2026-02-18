# Auto-Triage Bug Report

> Generated: 2026-02-18
> Scope: All bugs discovered during auto-triage codebase analysis

## Summary Table

| Bug ID     | Severity | Title                                                                | File(s) Affected                                                                                                    |
| ---------- | -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| BUG-AT-001 | Medium   | Duplicate threshold hardcoded, ignoring configurable value           | `src/app/api/internal/triage/check-duplicates/route.ts`                                                             |
| BUG-AT-002 | Medium   | `action_taken` mislabeled as `comment_posted` when adding labels     | `src/app/api/internal/triage/add-label/route.ts`                                                                    |
| BUG-AT-003 | High     | Unimplemented `answerQuestion()` and `requestClarification()` stubs  | `cloudflare-auto-triage-infra/src/triage-orchestrator.ts`                                                           |
| BUG-AT-004 | High     | Owner `userId` set to `organization_id` in classify-config           | `src/app/api/internal/triage/classify-config/route.ts`                                                              |
| BUG-AT-005 | Medium   | Reopen webhook does not re-triage if ticket already exists           | `src/lib/auto-triage/application/webhook/issue-webhook-processor.ts`                                                |
| BUG-AT-006 | Low      | Retry inconsistency between shared factory and legacy router         | `src/lib/auto-triage/application/routers/shared-router-factory.ts`, `src/routers/auto-triage/auto-triage-router.ts` |
| BUG-AT-007 | Medium   | GitHub labels service only fetches first 100 labels                  | `cloudflare-auto-triage-infra/src/services/github-labels-service.ts`                                                |
| BUG-AT-008 | Medium   | Classification parser could match wrong JSON object                  | `cloudflare-auto-triage-infra/src/parsers/classification-parser.ts`                                                 |
| BUG-AT-009 | High     | SSE error events are non-fatal, could lead to partial classification | `cloudflare-auto-triage-infra/src/services/sse-stream-processor.ts`                                                 |
| BUG-AT-010 | High     | Terminal state guard race condition                                  | `src/app/api/internal/triage-status/[ticketId]/route.ts`                                                            |
| BUG-AT-011 | High     | Bot user missing causes silent dispatch failure                      | `src/app/api/internal/triage-status/[ticketId]/route.ts`                                                            |
| BUG-AT-012 | Critical | Worker client singleton throws at import time                        | `src/lib/auto-triage/client/triage-worker-client.ts`                                                                |
| BUG-AT-013 | Low      | Commented-out UI fields still send hardcoded defaults                | `src/components/auto-triage/AutoTriageConfigForm.tsx`                                                               |
| BUG-AT-014 | Low      | `edited` webhook action ignored — missing feature                    | `src/lib/integrations/platforms/github/webhook-handlers/issue-handler.ts`                                           |
| BUG-AT-015 | High     | Milvus collection not auto-created                                   | `src/app/api/internal/triage/check-duplicates/route.ts`                                                             |
| BUG-AT-016 | Medium   | `should_auto_fix` column never set                                   | `src/db/schema.ts`, all auto-triage code                                                                            |
| BUG-AT-017 | Low      | Label color hardcoded for all auto-created labels                    | `src/app/api/internal/triage/add-label/route.ts`                                                                    |

---

## BUG-AT-001: Duplicate threshold hardcoded, ignoring configurable value

**Severity:** Medium

**File(s) affected:**

- [`src/app/api/internal/triage/check-duplicates/route.ts`](src/app/api/internal/triage/check-duplicates/route.ts:240) — line ~240 (comparison), line ~30 (schema definition)

**Current behavior:**

The `isDuplicate` decision uses a hardcoded `0.9` threshold:

```ts
// line ~240
const isDuplicate = similarity > 0.9;
```

The `threshold` parameter is accepted in the request body via Zod schema (defaults to `0.8`) but is never referenced in the comparison logic.

**Expected behavior:**

The `isDuplicate` decision should use the configurable `threshold` value from the validated request body, allowing callers to control duplicate sensitivity.

**Root cause:**

The threshold was likely hardcoded during initial development and never updated when the configurable parameter was added to the schema.

**Fix instructions:**

1. In [`src/app/api/internal/triage/check-duplicates/route.ts`](src/app/api/internal/triage/check-duplicates/route.ts:240), locate the line where `isDuplicate` is computed (around line 240).
2. Replace the hardcoded `0.9` with the `threshold` variable extracted from the validated request body:

```ts
// Before
const isDuplicate = similarity > 0.9;

// After
const isDuplicate = similarity > threshold;
```

3. Verify that `threshold` is destructured from the validated body near the top of the handler.

**Testing:**

- Send a duplicate check request with `threshold: 0.5` and two issues with similarity `0.6`. Confirm they are flagged as duplicates.
- Send the same request with `threshold: 0.8`. Confirm they are NOT flagged as duplicates.
- Send a request without `threshold` and confirm the default `0.8` is used.

**Risk assessment:**

Low risk. The change is a single variable substitution. The only concern is that existing callers relying on the implicit `0.9` behavior may see more duplicates flagged if they send the default `0.8`. Verify that all callers are aware of the default threshold value.

---

## BUG-AT-002: `action_taken` mislabeled as `comment_posted` when adding labels

**Severity:** Medium

**File(s) affected:**

- [`src/app/api/internal/triage/add-label/route.ts`](src/app/api/internal/triage/add-label/route.ts:109) — line ~109

**Current behavior:**

The `actionTaken` field is hardcoded to `'comment_posted'` regardless of what the endpoint actually does:

```ts
// line ~109
actionTaken: 'comment_posted',
```

This endpoint adds labels to GitHub issues, not comments. The incorrect value corrupts the ticket's action history.

**Expected behavior:**

The `actionTaken` field should accurately reflect the action performed. When labels are applied, it should be `'labels_applied'` or a similarly descriptive value.

**Root cause:**

Copy-paste error or placeholder value that was never updated to reflect the actual action.

**Fix instructions:**

1. In [`src/app/api/internal/triage/add-label/route.ts`](src/app/api/internal/triage/add-label/route.ts:109), locate the `actionTaken` assignment around line 109.
2. Change the value to accurately describe the action:

```ts
// Before
actionTaken: 'comment_posted',

// After
actionTaken: 'labels_applied',
```

3. If the action type enum/union is defined elsewhere (e.g., in the DB schema or a shared types file), add `'labels_applied'` to the allowed values.
4. Check if any downstream code reads `actionTaken` and handles `'comment_posted'` specifically — update those consumers to also handle `'labels_applied'`.

**Testing:**

- Trigger the add-label endpoint and inspect the resulting ticket record in the database.
- Confirm `action_taken` is `'labels_applied'` (not `'comment_posted'`).
- Verify any UI or reporting that displays action history shows the correct action type.

**Risk assessment:**

Medium risk. Changing the action type value could break downstream consumers that filter or switch on `'comment_posted'`. Audit all references to `actionTaken` / `action_taken` before deploying.

---

## BUG-AT-003: Unimplemented `answerQuestion()` and `requestClarification()` stubs

**Severity:** High

**File(s) affected:**

- [`cloudflare-auto-triage-infra/src/triage-orchestrator.ts`](cloudflare-auto-triage-infra/src/triage-orchestrator.ts:340) — lines ~340 and ~357

**Current behavior:**

Both methods are TODO stubs that only update the ticket status but never post comments to GitHub:

```ts
// line ~340
private async answerQuestion() {
  // TODO: Post answer comment to GitHub
  await this.updateStatus('actioned');
}

// line ~357
private async requestClarification() {
  // TODO: Post clarification request to GitHub
  await this.updateStatus('actioned');
}
```

When classification is `'question'` or confidence is low, the issue author receives no feedback.

**Expected behavior:**

- `answerQuestion()` should post a comment on the GitHub issue containing the AI-generated answer.
- `requestClarification()` should post a comment asking the issue author for more details.

**Root cause:**

These methods were stubbed out during initial implementation and never completed.

**Fix instructions:**

1. In [`cloudflare-auto-triage-infra/src/triage-orchestrator.ts`](cloudflare-auto-triage-infra/src/triage-orchestrator.ts:340), implement `answerQuestion()`:

```ts
private async answerQuestion(classification: Classification) {
  const commentBody = this.formatAnswerComment(classification);
  await this.callBackend('/api/internal/triage/post-comment', {
    ticketId: this.ticketId,
    issueNumber: this.issueNumber,
    owner: this.owner,
    repo: this.repo,
    body: commentBody,
  });
  await this.updateStatus('actioned');
}
```

2. Implement `requestClarification()`:

```ts
private async requestClarification(classification: Classification) {
  const commentBody = this.formatClarificationComment(classification);
  await this.callBackend('/api/internal/triage/post-comment', {
    ticketId: this.ticketId,
    issueNumber: this.issueNumber,
    owner: this.owner,
    repo: this.repo,
    body: commentBody,
  });
  await this.updateStatus('actioned');
}
```

3. Add helper methods to format the comment bodies with appropriate markdown, including a disclaimer that the response is AI-generated.
4. Verify that the `/api/internal/triage/post-comment` endpoint exists and accepts the expected payload. If it doesn't exist, it needs to be created.

**Testing:**

- Create a GitHub issue phrased as a question. Verify the bot posts an answer comment.
- Create a vague GitHub issue. Verify the bot posts a clarification request comment.
- Verify the ticket status transitions to `'actioned'` after the comment is posted.
- Verify error handling: if the comment post fails, the ticket should transition to `'failed'`.

**Risk assessment:**

Medium risk. The main concern is the quality and tone of AI-generated comments posted publicly on GitHub issues. Consider adding a review/approval step or a confidence threshold below which no comment is posted. Also ensure rate limiting is in place to prevent spam.

---

## BUG-AT-004: Owner `userId` set to `organization_id` in classify-config

**Severity:** High

**File(s) affected:**

- [`src/app/api/internal/triage/classify-config/route.ts`](src/app/api/internal/triage/classify-config/route.ts:99) — line ~99

**Current behavior:**

For organization-owned tickets, the `userId` is set to the `owned_by_organization_id`:

```ts
// line ~99
userId: ticket.owned_by_organization_id,
```

This passes an organization ID where a user ID is expected, which could cause auth token generation to fail or generate tokens for the wrong entity.

**Expected behavior:**

The `userId` should be the actual bot user ID associated with the organization, not the organization ID itself.

**Root cause:**

The code incorrectly assumes the organization ID can be used as a user ID, likely due to a misunderstanding of the ownership model.

**Fix instructions:**

1. In [`src/app/api/internal/triage/classify-config/route.ts`](src/app/api/internal/triage/classify-config/route.ts:99), resolve the bot user for the organization before setting `userId`:

```ts
// Before
userId: ticket.owned_by_organization_id,

// After — resolve the bot user for the org
const botUser = await getBotUserForOrganization(ticket.owned_by_organization_id);
if (!botUser) {
  return NextResponse.json(
    { error: 'Bot user not found for organization' },
    { status: 500 }
  );
}
// ...
userId: botUser.id,
```

2. Look at how other endpoints (e.g., the triage-status handler) resolve bot users for organizations and follow the same pattern.
3. Ensure `getBotUserForOrganization` (or equivalent) is imported and available.

**Testing:**

- Trigger classification for an organization-owned ticket.
- Verify the auth token is generated for the correct bot user, not the organization entity.
- Verify the classification succeeds end-to-end for org-owned tickets.
- Test with a personal (non-org) ticket to ensure no regression.

**Risk assessment:**

High risk if done incorrectly. Using the wrong user ID for auth token generation could grant access to the wrong repositories or fail authentication entirely. Thoroughly test with both personal and organization-owned tickets.

---

## BUG-AT-005: Reopen webhook does not re-triage if ticket already exists

**Severity:** Medium

**File(s) affected:**

- [`src/lib/auto-triage/application/webhook/issue-webhook-processor.ts`](src/lib/auto-triage/application/webhook/issue-webhook-processor.ts)

**Current behavior:**

When a `reopened` webhook fires for an issue that already has a ticket, the processor finds the existing ticket and returns 200 without re-triaging. Issues closed and reopened with new information are not re-analyzed.

**Expected behavior:**

For `reopened` events, if the existing ticket is in a terminal state (`'actioned'`, `'failed'`, `'skipped'`), it should be reset to `'pending'` and re-dispatched for triage. If the ticket is still `'pending'` or `'analyzing'`, it should be left alone.

**Root cause:**

The webhook processor treats all existing tickets the same regardless of their current state, and does not distinguish between `reopened` and other actions when a ticket already exists.

**Fix instructions:**

1. In [`issue-webhook-processor.ts`](src/lib/auto-triage/application/webhook/issue-webhook-processor.ts), locate the handler for the `reopened` action where it checks for an existing ticket.
2. Add a condition to check the ticket's current status:

```ts
if (action === 'reopened' && existingTicket) {
  const terminalStates = ['actioned', 'failed', 'skipped'];
  if (terminalStates.includes(existingTicket.status)) {
    // Reset ticket to pending and re-dispatch
    await updateTicketStatus(existingTicket.id, 'pending');
    await dispatchTriage(existingTicket.id);
    return new Response(null, { status: 200 });
  }
  // If still pending/analyzing, leave it alone
  return new Response(null, { status: 200 });
}
```

3. Ensure the `updateTicketStatus` function clears any stale classification data when resetting to `'pending'`.

**Testing:**

- Create an issue, let it be triaged (ticket reaches `'actioned'`).
- Close and reopen the issue.
- Verify the ticket is reset to `'pending'` and re-dispatched.
- Verify that reopening an issue with a `'pending'` ticket does NOT create a duplicate dispatch.

**Risk assessment:**

Low-medium risk. The main concern is ensuring the re-dispatch doesn't create duplicate work if the original triage is still in progress. The terminal state check mitigates this. Also verify that resetting the ticket properly clears old classification results.

---

## BUG-AT-006: Retry inconsistency between shared factory and legacy router

**Severity:** Low

**File(s) affected:**

- [`src/lib/auto-triage/application/routers/shared-router-factory.ts`](src/lib/auto-triage/application/routers/shared-router-factory.ts) — `retryTicket` procedure
- [`src/routers/auto-triage/auto-triage-router.ts`](src/routers/auto-triage/auto-triage-router.ts) — `retryTicket` procedure

**Current behavior:**

The shared factory allows retrying both `'failed'` and `'actioned'` tickets, but the legacy router only allows `'failed'`. This creates inconsistent behavior depending on which router handles the request.

**Expected behavior:**

Both routers should have the same retry behavior. The shared factory behavior (allowing both `'failed'` and `'actioned'`) appears intentional for the re-classify feature.

**Root cause:**

The legacy router was not updated when the shared factory was created with expanded retry capabilities.

**Fix instructions:**

1. **Option A — Align the legacy router:** In [`src/routers/auto-triage/auto-triage-router.ts`](src/routers/auto-triage/auto-triage-router.ts), update the `retryTicket` procedure to also allow `'actioned'` tickets:

```ts
// Before
if (ticket.status !== 'failed') {
  throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only failed tickets can be retried' });
}

// After
if (ticket.status !== 'failed' && ticket.status !== 'actioned') {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Only failed or actioned tickets can be retried',
  });
}
```

2. **Option B — Deprecate the legacy router:** If the legacy router is no longer needed, remove it and ensure all clients use the shared factory router.

**Testing:**

- Attempt to retry an `'actioned'` ticket via the legacy router. Confirm it succeeds (Option A) or that the legacy router is no longer reachable (Option B).
- Attempt to retry a `'pending'` ticket via both routers. Confirm both reject it.

**Risk assessment:**

Low risk. The change is a simple condition expansion. Verify that retrying `'actioned'` tickets doesn't cause unexpected side effects (e.g., duplicate labels or comments).

---

## BUG-AT-007: GitHub labels service only fetches first 100 labels

**Severity:** Medium

**File(s) affected:**

- [`cloudflare-auto-triage-infra/src/services/github-labels-service.ts`](cloudflare-auto-triage-infra/src/services/github-labels-service.ts)

**Current behavior:**

`fetchRepoLabels()` only fetches the first page (100 labels) from the GitHub API. Repositories with more than 100 labels will have an incomplete label list, causing the classification parser to filter out valid labels.

**Expected behavior:**

All labels should be fetched, with pagination support. A reasonable upper limit (e.g., 500 labels) should prevent unbounded requests.

**Root cause:**

Pagination was not implemented — only the first page of results is fetched.

**Fix instructions:**

1. In [`github-labels-service.ts`](cloudflare-auto-triage-infra/src/services/github-labels-service.ts), implement pagination:

```ts
async fetchRepoLabels(owner: string, repo: string, token: string): Promise<string[]> {
  const allLabels: string[] = [];
  let page = 1;
  const perPage = 100;
  const maxLabels = 500;

  while (allLabels.length < maxLabels) {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/labels?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch labels: ${response.status}`);
    }

    const labels = await response.json() as Array<{ name: string }>;
    allLabels.push(...labels.map(l => l.name));

    if (labels.length < perPage) break; // No more pages
    page++;
  }

  return allLabels.slice(0, maxLabels);
}
```

2. Alternatively, parse the `Link` header from the response to determine if there are more pages.

**Testing:**

- Test with a repository that has fewer than 100 labels. Confirm all labels are returned.
- Test with a repository that has more than 100 labels (or mock the API to return paginated results). Confirm all labels are fetched across pages.
- Verify the 500-label cap is respected.

**Risk assessment:**

Low risk. The change adds pagination to an existing fetch call. The main concern is increased API calls for repos with many labels, but the 500-label cap mitigates this.

---

## BUG-AT-008: Classification parser could match wrong JSON object

**Severity:** Medium

**File(s) affected:**

- [`cloudflare-auto-triage-infra/src/parsers/classification-parser.ts`](cloudflare-auto-triage-infra/src/parsers/classification-parser.ts)

**Current behavior:**

The parser tries code blocks last-to-first, then raw JSON objects last-to-first. If the LLM response contains multiple JSON objects (e.g., examples in reasoning before the actual result), the parser could match the wrong one. The current code does validate with Zod, but only after selecting the first successful JSON parse — it does not try all candidates.

**Expected behavior:**

The parser should try all JSON candidates and select the first one that passes Zod schema validation, not just the first one that parses as valid JSON.

**Root cause:**

The parsing logic short-circuits on the first valid JSON parse rather than the first valid schema match.

**Fix instructions:**

1. In [`classification-parser.ts`](cloudflare-auto-triage-infra/src/parsers/classification-parser.ts), modify the parsing loop to continue trying candidates if Zod validation fails:

```ts
function parseClassification(text: string): Classification | null {
  const candidates = extractJsonCandidates(text); // code blocks + raw JSON, last-to-first

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const result = classificationSchema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
      // Zod validation failed — try next candidate
    } catch {
      // JSON parse failed — try next candidate
    }
  }

  return null;
}
```

2. Ensure `extractJsonCandidates()` returns candidates in priority order (last-to-first from code blocks, then last-to-first from raw JSON).

**Testing:**

- Provide an LLM response with two JSON objects: an example in the reasoning and the actual classification at the end. Verify the correct one is selected.
- Provide a response with only one valid JSON object. Verify it still works.
- Provide a response with no valid JSON. Verify it returns `null`.

**Risk assessment:**

Low risk. The change makes the parser more robust without changing the happy path. The only concern is performance if there are many JSON candidates, but this is unlikely in practice.

---

## BUG-AT-009: SSE error events are non-fatal, could lead to partial classification

**Severity:** High

**File(s) affected:**

- [`cloudflare-auto-triage-infra/src/services/sse-stream-processor.ts`](cloudflare-auto-triage-infra/src/services/sse-stream-processor.ts)

**Current behavior:**

When an `error` event is received in the SSE stream, it is logged as a warning but the stream continues processing. If the LLM encounters an error mid-response, the partial text is still used for classification, potentially producing garbage results.

**Expected behavior:**

Error events should be treated as significant. If an error event is received:

- If the accumulated text is empty or very short, throw an error and abort.
- If substantial text has been accumulated, mark the result as potentially unreliable.

**Root cause:**

Error handling was implemented as a warning log rather than a control flow decision.

**Fix instructions:**

1. In [`sse-stream-processor.ts`](cloudflare-auto-triage-infra/src/services/sse-stream-processor.ts), track error events:

```ts
let errorReceived = false;
let errorContent = '';

// In the event handler:
if (event.type === 'error') {
  errorReceived = true;
  errorContent = event.data;
  console.error('SSE error event received:', errorContent);
}
```

2. After the stream completes, check the error state:

```ts
if (errorReceived) {
  const minTextLength = 50; // Minimum chars for a usable response
  if (accumulatedText.length < minTextLength) {
    throw new Error(`SSE stream error with insufficient text: ${errorContent}`);
  }
  // If we have substantial text, log a warning but continue
  console.warn('SSE error received but continuing with accumulated text');
}
```

3. Optionally, if an error is received and the result is used, lower the confidence score in the classification result.

**Testing:**

- Simulate an SSE stream that sends an error event with no prior text. Verify an error is thrown.
- Simulate an SSE stream that sends text, then an error event. Verify the partial text is used with a warning.
- Simulate a normal SSE stream with no errors. Verify no change in behavior.

**Risk assessment:**

Medium risk. Being too aggressive with error handling could cause valid classifications to be rejected. The minimum text length threshold should be tuned based on observed LLM response patterns. Start conservative (throw on any error) and relax if needed.

---

## BUG-AT-010: Terminal state guard race condition

**Severity:** High

**File(s) affected:**

- [`src/app/api/internal/triage-status/[ticketId]/route.ts`](src/app/api/internal/triage-status/[ticketId]/route.ts:40) — line ~40

**Current behavior:**

The terminal state guard reads the current status, checks if it's terminal, and then performs the update in a separate step. This is a TOCTOU (Time-of-Check-to-Time-of-Use) race condition. If two requests arrive nearly simultaneously (e.g., `'actioned'` and `'failed'`), the second update could be silently dropped.

```ts
// line ~40
const ticket = await getTicket(ticketId);
if (['actioned', 'failed'].includes(ticket.status)) {
  return NextResponse.json({ message: 'Already in terminal state' });
}
await updateTicketStatus(ticketId, newStatus);
```

**Expected behavior:**

The status update should be atomic — the terminal state check and the update should happen in a single database operation.

**Root cause:**

The read-then-write pattern is inherently racy. The check and update are separate database operations with no locking.

**Fix instructions:**

1. In [`route.ts`](src/app/api/internal/triage-status/[ticketId]/route.ts:40), replace the read-then-write pattern with a conditional update:

```ts
// Before: read-then-write (racy)
const ticket = await getTicket(ticketId);
if (['actioned', 'failed'].includes(ticket.status)) {
  return NextResponse.json({ message: 'Already in terminal state' });
}
await updateTicketStatus(ticketId, newStatus);

// After: atomic conditional update
const result = await db
  .update(autoTriageTickets)
  .set({ status: newStatus, updatedAt: new Date() })
  .where(
    and(
      eq(autoTriageTickets.id, ticketId),
      notInArray(autoTriageTickets.status, ['actioned', 'failed'])
    )
  )
  .returning();

if (result.length === 0) {
  // Either ticket doesn't exist or is already in terminal state
  const ticket = await getTicket(ticketId);
  if (ticket) {
    return NextResponse.json({ message: 'Already in terminal state' }, { status: 409 });
  }
  return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
}
```

2. This ensures the check and update are a single atomic operation at the database level.

**Testing:**

- Send two concurrent status updates for the same ticket (e.g., `'actioned'` and `'failed'`). Verify only one succeeds.
- Verify that updating a ticket already in `'actioned'` state returns 409.
- Verify that updating a non-existent ticket returns 404.
- Verify normal status transitions still work (e.g., `'pending'` → `'analyzing'` → `'actioned'`).

**Risk assessment:**

Medium risk. The atomic update changes the response behavior (now returns 409 instead of 200 for already-terminal tickets). Verify that the Cloudflare worker handles 409 responses gracefully.

---

## BUG-AT-011: Bot user missing causes silent dispatch failure

**Severity:** High

**File(s) affected:**

- [`src/app/api/internal/triage-status/[ticketId]/route.ts`](src/app/api/internal/triage-status/[ticketId]/route.ts)

**Current behavior:**

For organization-owned tickets, if the bot user doesn't exist, the endpoint logs an error via Sentry `captureMessage` but returns a success response. The re-dispatch for pending tickets silently fails because owner resolution fails.

**Expected behavior:**

If the bot user is missing, the endpoint should either:

- Create the bot user on the fly (like `ensureBotUserForOrg()` does elsewhere), or
- Return an error status so the worker knows the callback failed.

**Root cause:**

Error handling treats a missing bot user as a non-fatal condition, logging it but continuing with a success response.

**Fix instructions:**

1. In [`route.ts`](src/app/api/internal/triage-status/[ticketId]/route.ts), locate the bot user resolution for org tickets.
2. Replace the silent failure with either auto-creation or an error response:

**Option A — Auto-create the bot user:**

```ts
let botUser = await getBotUserForOrganization(orgId);
if (!botUser) {
  botUser = await ensureBotUserForOrg(orgId);
}
```

**Option B — Return an error:**

```ts
const botUser = await getBotUserForOrganization(orgId);
if (!botUser) {
  captureMessage(`Bot user missing for org ${orgId}`, 'error');
  return NextResponse.json({ error: 'Bot user not found for organization' }, { status: 500 });
}
```

3. Option A is preferred as it self-heals. Ensure `ensureBotUserForOrg` is available and imported.

**Testing:**

- Trigger a triage status callback for an org ticket where the bot user doesn't exist.
- **Option A:** Verify the bot user is created and the dispatch succeeds.
- **Option B:** Verify a 500 error is returned and the worker retries.
- Verify normal flow (bot user exists) is unaffected.

**Risk assessment:**

Low risk for Option B (returning an error). Medium risk for Option A (auto-creating users) — ensure the auto-creation logic is idempotent and handles concurrent creation attempts.

---

## BUG-AT-012: Worker client singleton throws at import time

**Severity:** Critical

**File(s) affected:**

- [`src/lib/auto-triage/client/triage-worker-client.ts`](src/lib/auto-triage/client/triage-worker-client.ts:47) — line ~47

**Current behavior:**

The `TriageWorkerClient` constructor reads `AUTO_TRIAGE_URL` and `AUTO_TRIAGE_AUTH_TOKEN` from environment variables and throws if they're not set. Since it's a singleton created at module level, this crashes the entire Next.js server if these env vars are missing — even if auto-triage is never used.

```ts
// line ~47
const triageWorkerClient = new TriageWorkerClient(); // throws if env vars missing
export { triageWorkerClient };
```

**Expected behavior:**

The client should be lazily initialized — only created when first accessed, and only throwing when `dispatchTriage()` is actually called.

**Root cause:**

Module-level singleton instantiation with strict env var validation in the constructor.

**Fix instructions:**

1. In [`triage-worker-client.ts`](src/lib/auto-triage/client/triage-worker-client.ts:47), replace the eager singleton with lazy initialization:

```ts
// Before
const triageWorkerClient = new TriageWorkerClient();
export { triageWorkerClient };

// After
let _instance: TriageWorkerClient | null = null;

export function getTriageWorkerClient(): TriageWorkerClient {
  if (!_instance) {
    _instance = new TriageWorkerClient();
  }
  return _instance;
}
```

2. Update all import sites that reference `triageWorkerClient` to use `getTriageWorkerClient()` instead:

```ts
// Before
import { triageWorkerClient } from '@/lib/auto-triage/client/triage-worker-client';
triageWorkerClient.dispatchTriage(...);

// After
import { getTriageWorkerClient } from '@/lib/auto-triage/client/triage-worker-client';
getTriageWorkerClient().dispatchTriage(...);
```

3. Search for all usages with: `grep -r "triageWorkerClient" src/`

**Testing:**

- Start the Next.js server WITHOUT `AUTO_TRIAGE_URL` and `AUTO_TRIAGE_AUTH_TOKEN` set. Verify the server starts successfully.
- Access a non-auto-triage page. Verify it works.
- Trigger an auto-triage dispatch. Verify it throws a clear error about missing env vars.
- Start the server WITH the env vars set. Verify auto-triage works normally.

**Risk assessment:**

Low risk for the lazy initialization change itself. Medium risk for updating all import sites — ensure every reference is updated. Use a project-wide search to find all usages.

---

## BUG-AT-013: Commented-out UI fields still send hardcoded defaults

**Severity:** Low

**File(s) affected:**

- [`src/components/auto-triage/AutoTriageConfigForm.tsx`](src/components/auto-triage/AutoTriageConfigForm.tsx) — `handleSave()` function

**Current behavior:**

The form has commented-out fields for thresholds, timeout, and custom instructions, but `handleSave()` still sends hardcoded defaults:

```ts
// In handleSave():
duplicateThreshold: parseFloat('0.8'),
// ... other hardcoded values
```

Users cannot change these values through the UI, and the hardcoded values may not match backend expectations.

**Expected behavior:**

Either:

- **(a)** The UI fields should be uncommented so users can configure these values, or
- **(b)** The hardcoded values should be removed from `handleSave()` and the backend should use its own defaults.

**Root cause:**

UI fields were commented out (likely not ready for users) but the corresponding hardcoded values in the save handler were left in place.

**Fix instructions:**

**Option B (recommended — cleaner if fields aren't ready):**

1. In [`AutoTriageConfigForm.tsx`](src/components/auto-triage/AutoTriageConfigForm.tsx), remove the hardcoded threshold/timeout/instruction values from `handleSave()`.
2. Only send values that the user has actually configured through visible UI fields.
3. Ensure the backend handles missing optional fields by applying its own defaults.

**Option A (if fields should be user-configurable):**

1. Uncomment the UI fields for thresholds, timeout, and custom instructions.
2. Wire them up to form state.
3. Use the form state values in `handleSave()` instead of hardcoded defaults.

**Testing:**

- Save the auto-triage config form. Inspect the request payload.
- **Option B:** Verify the hardcoded fields are not present in the payload.
- **Option A:** Verify the user-entered values are present in the payload.
- Verify the backend handles the payload correctly in both cases.

**Risk assessment:**

Low risk. Option B is safer — removing hardcoded values is unlikely to break anything if the backend has its own defaults. Option A requires more testing of the new UI fields.

---

## BUG-AT-014: `edited` webhook action ignored — missing feature

**Severity:** Low

**File(s) affected:**

- [`src/lib/integrations/platforms/github/webhook-handlers/issue-handler.ts`](src/lib/integrations/platforms/github/webhook-handlers/issue-handler.ts:115) — line ~115

**Current behavior:**

The `edited` action is validated by the schema but explicitly ignored with a TODO comment. When an issue is edited after triage, the triage results may become stale.

**Expected behavior:**

When an `edited` event arrives for an issue with an existing ticket in `'actioned'` state, the system should consider re-triaging if the title or body changed significantly.

**Root cause:**

Feature was planned but not implemented — marked with a TODO.

**Fix instructions:**

1. In [`issue-handler.ts`](src/lib/integrations/platforms/github/webhook-handlers/issue-handler.ts:115), implement handling for the `edited` action:

```ts
case 'edited': {
  const existingTicket = await findTicketByIssue(owner, repo, issueNumber);
  if (!existingTicket || existingTicket.status !== 'actioned') {
    // No ticket or not yet actioned — nothing to do
    return new Response(null, { status: 200 });
  }

  // Check if title or body changed (changes object is in the webhook payload)
  const titleChanged = payload.changes?.title !== undefined;
  const bodyChanged = payload.changes?.body !== undefined;

  if (titleChanged || bodyChanged) {
    await updateTicketStatus(existingTicket.id, 'pending');
    await dispatchTriage(existingTicket.id);
  }

  return new Response(null, { status: 200 });
}
```

2. Alternatively, if re-triage on edit is not desired yet, document this as a known limitation and remove the TODO to avoid confusion.

**Testing:**

- Edit the title of a triaged issue. Verify re-triage is triggered.
- Edit a comment (not the issue body). Verify re-triage is NOT triggered.
- Edit an issue that hasn't been triaged yet. Verify no action is taken.

**Risk assessment:**

Medium risk. Re-triaging on every edit could be noisy for issues that are frequently updated. Consider adding a debounce mechanism or only re-triaging if the changes are substantial (e.g., more than N characters changed).

---

## BUG-AT-015: Milvus collection not auto-created

**Severity:** High

**File(s) affected:**

- [`src/app/api/internal/triage/check-duplicates/route.ts`](src/app/api/internal/triage/check-duplicates/route.ts)

**Current behavior:**

`ensureTriageCollectionExists()` exists as a function but is not called automatically. If the Milvus collection doesn't exist when the first duplicate check runs, the request will fail.

**Expected behavior:**

The Milvus collection should be automatically created before the first duplicate check, either lazily on first access or as part of a startup/migration script.

**Root cause:**

The collection creation function was written but never wired into the request flow.

**Fix instructions:**

1. In [`check-duplicates/route.ts`](src/app/api/internal/triage/check-duplicates/route.ts), call `ensureTriageCollectionExists()` at the start of the handler with a module-level cache to avoid calling it on every request:

```ts
let collectionEnsured = false;

async function ensureCollection() {
  if (collectionEnsured) return;
  await ensureTriageCollectionExists();
  collectionEnsured = true;
}

// In the handler:
export async function POST(request: Request) {
  await ensureCollection();
  // ... rest of handler
}
```

2. Note: In a serverless environment (Next.js API routes), the module-level cache will be reset on cold starts. This is acceptable — `ensureTriageCollectionExists()` should be idempotent (no-op if collection already exists).

**Testing:**

- Delete the Milvus collection (if it exists). Send a duplicate check request. Verify the collection is created automatically and the check succeeds.
- Send a second request. Verify `ensureTriageCollectionExists()` is not called again (check logs).
- Verify that the function is idempotent — calling it when the collection already exists does not error.

**Risk assessment:**

Low risk. The `ensureTriageCollectionExists()` function should already be idempotent. The main concern is added latency on the first request after a cold start, but this is a one-time cost.

---

## BUG-AT-016: `should_auto_fix` column never set

**Severity:** Medium

**File(s) affected:**

- [`src/db/schema.ts`](src/db/schema.ts) — `auto_triage_tickets` table definition
- [`cloudflare-auto-triage-infra/src/triage-orchestrator.ts`](cloudflare-auto-triage-infra/src/triage-orchestrator.ts) — Durable Object logic
- [`src/app/api/internal/triage-status/[ticketId]/route.ts`](src/app/api/internal/triage-status/[ticketId]/route.ts) — status update handler

**Current behavior:**

The `should_auto_fix` boolean column exists in the schema (defaults to `false`) but is never set to `true` by any code path. The Durable Object adds a `'kilo-auto-fix'` label when confidence exceeds `autoFixThreshold`, but never updates this database column.

**Expected behavior:**

When the Durable Object determines that auto-fix should be triggered (confidence ≥ `autoFixThreshold`), it should include `should_auto_fix: true` in the status update payload, and the triage-status handler should persist this value.

**Root cause:**

The database column was added but the code to set it was never implemented — the auto-fix signal is only communicated via the GitHub label, not persisted in the database.

**Fix instructions:**

1. In the Durable Object ([`triage-orchestrator.ts`](cloudflare-auto-triage-infra/src/triage-orchestrator.ts)), when the auto-fix threshold is met, include `should_auto_fix: true` in the status callback payload:

```ts
// When confidence >= autoFixThreshold:
await this.callStatusCallback({
  status: 'actioned',
  should_auto_fix: true,
  // ... other fields
});
```

2. In the triage-status handler ([`route.ts`](src/app/api/internal/triage-status/[ticketId]/route.ts)), read `should_auto_fix` from the request body and include it in the database update:

```ts
// In the update:
await db.update(autoTriageTickets).set({
  status: newStatus,
  shouldAutoFix: body.should_auto_fix ?? false,
  // ... other fields
});
```

3. Update the Zod schema for the status callback request body to include `should_auto_fix` as an optional boolean.

**Testing:**

- Trigger triage for an issue where confidence exceeds the auto-fix threshold. Verify `should_auto_fix` is `true` in the database.
- Trigger triage for an issue where confidence is below the threshold. Verify `should_auto_fix` remains `false`.
- Query the database to confirm the column is being set correctly.

**Risk assessment:**

Low risk. This adds a new field to an existing payload and persists it. No existing behavior is changed — this is purely additive.

---

## BUG-AT-017: Label color hardcoded for all auto-created labels

**Severity:** Low

**File(s) affected:**

- [`src/app/api/internal/triage/add-label/route.ts`](src/app/api/internal/triage/add-label/route.ts)

**Current behavior:**

When creating labels that don't exist on the repo, the color is hardcoded to `'faf74f'` (yellow) for all labels. Bug, feature, question, unclear, and duplicate labels all get the same yellow color, making them visually indistinguishable.

**Expected behavior:**

Labels should have distinct colors based on their type (e.g., red for bug, blue for feature, purple for question, gray for unclear, orange for duplicate).

**Root cause:**

A single default color was used as a placeholder and never replaced with a proper color mapping.

**Fix instructions:**

1. In [`add-label/route.ts`](src/app/api/internal/triage/add-label/route.ts), add a color map:

```ts
const labelColorMap: Record<string, string> = {
  bug: 'd73a4a', // red
  feature: '0075ca', // blue
  question: 'd876e3', // purple
  unclear: 'e4e669', // yellow
  duplicate: 'cfd3d7', // gray
  enhancement: 'a2eeef', // teal
};

const defaultColor = 'faf74f'; // yellow fallback
```

2. When creating a label, look up the color:

```ts
// Before
color: 'faf74f',

// After
color: labelColorMap[labelName.toLowerCase()] ?? defaultColor,
```

3. Consider making the color map configurable per-organization in the future.

**Testing:**

- Trigger label creation for a `bug` classification. Verify the label is created with red color (`d73a4a`).
- Trigger label creation for a `feature` classification. Verify blue color (`0075ca`).
- Trigger label creation for an unknown label type. Verify the default yellow color is used.
- Check the labels on GitHub to confirm they are visually distinct.

**Risk assessment:**

Very low risk. This only affects the color of newly created labels. Existing labels are not modified. The change is purely cosmetic.
