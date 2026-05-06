# Concurrency Review

## Overall Behavior

GitHub webhooks now take two paths from `apps/web/src/app/api/webhooks/github/route.ts`:

1. The request body is read once and cloned.
2. `bot.webhooks.github(...)` is scheduled in `after(...)` for the Chat SDK GitHub adapter.
3. The existing `handleGitHubWebhook(...)` path still runs and returns the HTTP response.
4. The Chat SDK adapter turns created GitHub issue comments, PR comments, or review comments into `Message`s and calls `chatBot.onNewMention(...)` in `apps/web/src/lib/bot.ts`.
5. The bot resolves installation/user/integration state, creates a `bot_requests` row, refetches live GitHub context, runs the AI agent, and posts a reply.

Shared state includes Chat SDK Redis/memory state, GitHub adapter installation cache, Kilo user links, `bot_requests`, live GitHub comments, and the legacy auto-fix state for PR review comments.

## Findings

### High: Rapid mentions in the same GitHub thread are silently dropped

- **Affected files/functions:** `apps/web/src/lib/bot.ts`, `apps/web/src/app/api/webhooks/github/route.ts`, `apps/web/src/lib/bot/run.ts`
- **Scenario:** Several users add `@kilocode-bot ...` comments quickly on the same issue, PR, or review thread. The Chat SDK `Chat` instance has no explicit concurrency option, so it appears to use the SDK default strategy: `drop`. The first message gets the per-thread lock; later messages on the same thread fail while the long AI run is active.
- **Impact:** Later GitHub mentions are not queued and may receive no visible reply. GitHub still gets a successful webhook response, so users see a delivered comment but the bot appears to ignore them.
- **Recommended fix:** Configure explicit queueing for GitHub bot work, with bounded queue size and TTL. Add tests simulating multiple comments on the same thread and assert later comments are queued, coalesced, or clearly acknowledged rather than silently dropped.

### High: Different review comment threads on the same PR can run concurrently against the same branch

- **Affected files/functions:** `apps/web/src/lib/bot.ts`, `apps/web/src/lib/bot/agent-runner.ts`, `apps/web/src/lib/bot/conversation-context.ts`, GitHub adapter thread IDs like `github:{owner}/{repo}:{prNumber}:rc:{commentId}`
- **Scenario:** A reviewer mentions the bot on multiple line comments in the same PR. Each root review comment becomes a different Chat SDK thread ID because the ID includes the review comment ID. The SDK lock is per thread, so all runs can proceed concurrently.
- **Impact:** Multiple Cloud Agent sessions may edit the same repository/PR branch at the same time, producing conflicting pushes, out-of-order replies, and confusing workflows.
- **Recommended fix:** Add an application-level mutex/queue keyed by GitHub PR coordinates, such as `github-pr:{owner}/{repo}:{prNumber}`. Serialize code-changing runs per PR while optionally allowing read-only answers to proceed independently.

### High: Chat SDK lock TTL can expire while a long AI run is still active

- **Affected files/functions:** `apps/web/src/lib/bot.ts`, `apps/web/src/lib/bot/run.ts`, `apps/web/src/lib/bot/agent-runner.ts`
- **Scenario:** The first GitHub mention starts a long AI/tool run. If the Chat SDK lock TTL expires before the handler finishes, a later mention can start a second run on the same thread.
- **Impact:** Replies may be out of order, and multiple Cloud Agent sessions can run for what users perceive as one conversation.
- **Recommended fix:** Add a long-lived application-level lock renewed until `processMessage(...)` finishes, or store an explicit active-run record that later comments queue behind or append to. Add a slow-handler test around the lock TTL boundary.

### Medium: Live context fetch can include comments created after the triggering mention

- **Affected files/functions:** `apps/web/src/lib/bot/conversation-context.ts`, `apps/web/src/lib/bot/agent-runner.ts`
- **Scenario:** Comment A mentions the bot. Before A's run builds context, comments B and C are added. `getGitHubConversationContext(...)` refetches current issue/review comments and only filters out the trigger message by ID.
- **Impact:** The run triggered by A can see B/C as prior context even though they happened later. If B/C were dropped by concurrency handling, they may still influence the prompt without being acknowledged.
- **Recommended fix:** Filter fetched comments to `created_at <= triggerMessage.metadata.dateSent`. If queueing is enabled, pass queued/skipped comments explicitly as messages received while the previous run was active.

### Medium: GitHub review-comment webhooks can be handled by two independent systems

- **Affected files/functions:** `apps/web/src/app/api/webhooks/github/route.ts`, `apps/web/src/lib/integrations/platforms/github/webhook-handler.ts`, `apps/web/src/lib/integrations/platforms/github/webhook-handlers/pr-review-comment-handler.ts`, `apps/web/src/lib/auto-fix/application/webhook/review-comment-webhook-processor.ts`
- **Scenario:** Every GitHub webhook is sent to the Chat SDK adapter in `after(...)`. Created `pull_request_review_comment` events are also routed to legacy auto-fix, which looks for `@kilo` plus fix/patch language.
- **Impact:** A single review comment can spawn both a Chat bot run and an auto-fix ticket if mention aliases overlap or users include both command styles.
- **Recommended fix:** Decide one owner for review-comment fix commands. Gate the Chat SDK path away from legacy auto-fix comments, or migrate legacy behavior behind the Chat adapter with shared idempotency.

### Medium: `bot_requests` logging is not idempotent for duplicate platform message processing

- **Affected files/functions:** `apps/web/src/lib/bot/request-logging.ts`, `packages/db/src/schema.ts`, `apps/web/src/lib/bot/run.ts`
- **Scenario:** GitHub retries, serverless duplication, lock expiry, or process restart causes the same GitHub comment to be processed more than once outside the SDK dedupe window. `createBotRequest(...)` inserts a new row every time.
- **Impact:** Duplicate bot runs and admin records can be created for one GitHub comment. If Redis is unavailable and memory state is used, dedupe is process-local and easier to bypass.
- **Recommended fix:** Add a unique idempotency key for inbound bot messages, likely `(platform, platform_thread_id, platform_message_id)`, and use `insert ... on conflict` behavior.

## Expected User Experience

- Multiple mentions in the same issue/PR conversation are likely to process only the first mention while later mentions are dropped.
- Multiple line-level review mentions on the same PR can run concurrently and race on the same branch.
- Replies can be out of order when long runs overlap lock expiry or independent review-comment threads.
- Context can include comments added after the trigger, so the bot may appear to respond to the wrong slice of the conversation.
- Users will not get a clear queued/already-working response unless the handler implements one.

The safest model is explicit idempotent queueing, with serialization at least per PR for code-changing work and clear treatment of skipped or coalesced comments.
