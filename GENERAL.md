# General Review

## Findings

### High: GitHub review-comment mentions can be processed twice

- **Affected files/functions:** `apps/web/src/app/api/webhooks/github/route.ts`, `apps/web/src/lib/integrations/platforms/github/webhook-handler.ts`
- **Scenario/impact:** The route forwards every standard GitHub webhook to the Chat SDK adapter in `after(...)`, then also calls the legacy GitHub webhook handler. For `pull_request_review_comment.created`, the legacy path still calls `handlePRReviewComment(...)`, while the Chat SDK adapter may also turn the same mention into `onNewMention`. A single review-comment mention can trigger both legacy auto-fix and the new bot flow, causing duplicate agent runs, duplicate comments, conflicting side effects, and doubled model/API usage.
- **Recommended fix:** Route each event to exactly one bot path. Either exclude `pull_request_review_comment` events from the Chat SDK adapter while legacy auto-fix remains active, or migrate that event fully to the Chat SDK adapter and disable the legacy mention path. Add a regression test that a review comment with a bot mention invokes only one processing path.

### High: Lite GitHub app webhooks are not connected to the new bot adapter

- **Affected files/functions:** `apps/web/src/app/api/webhooks/github-lite/route.ts`, `apps/web/src/lib/bot.ts`
- **Scenario/impact:** The new GitHub adapter is configured only with standard app credentials, and only `/api/webhooks/github` forwards deliveries to `bot.webhooks.github(...)`. Lite installations still post to `/api/webhooks/github-lite`, which only calls the legacy integration handler. Mentions from repos installed through `github_app_type: 'lite'` will not reach the new bot handler, even though account-linking and context code try to support lite integrations.
- **Recommended fix:** Add bot adapter handling for the lite webhook endpoint with lite credentials, or create a routing layer that can verify and process both standard and lite app deliveries. Add tests for `/api/webhooks/github-lite` proving an `issue_comment.created` mention reaches the bot adapter.

### High: GitHub Cloud Agent session links may be invisible to users

- **Affected files/functions:** `apps/web/src/lib/bot/agent-runner.ts`, `apps/web/src/lib/bot/run.ts`
- **Scenario/impact:** When the bot starts a Cloud Agent session, `processMessage` suppresses the normal public final reply, and `postSessionLinkEphemeral(...)` is the only place that posts the session URL. That helper always uses `thread.postEphemeral(...)`, which is Slack-oriented and may be unsupported or ineffective for GitHub. Failures are caught and only logged, so a GitHub user can ask Kilo to start work, get no visible response, and have no way to open the created session from GitHub.
- **Recommended fix:** Branch on `thread.adapter.name`: keep ephemeral cards for Slack, but post a normal GitHub reply with the session link or a safe handoff message for GitHub. If `postEphemeral` fails on platforms without ephemeral support, fall back to `thread.post(...)`. Add a GitHub-specific test for the session-start path.

### Medium: GitHub context tags are not covered by the prompt-injection warning

- **Affected files/functions:** `apps/web/src/lib/bot/conversation-context.ts`, `apps/web/src/lib/bot/agent-runner.ts`
- **Scenario/impact:** GitHub issue descriptions, comments, review comments, and diff hunks are user/repository-controlled content, but they are inserted into tags the system prompt does not explicitly identify as untrusted. Malicious issue comments or PR descriptions can contain prompt-injection text that the model may treat as instructions.
- **Recommended fix:** Update the system prompt to mark all GitHub context tags as untrusted, or wrap GitHub user-controlled content in the existing untrusted convention. Separate trusted metadata from untrusted bodies and add tests for the generated prompt warning.

### Medium: GitHub API context fetch failures abort the entire bot run

- **Affected files/functions:** `apps/web/src/lib/bot/conversation-context.ts`, `apps/web/src/lib/bot/agent-runner.ts`
- **Scenario/impact:** `getGitHubConversationContext(...)` fetches the issue, issue comments, and review comments with `Promise.all(...)` and no local error handling. A transient GitHub error, rate limit, missing permission, deleted issue/PR, or unsupported thread ID shape can reject prompt construction and make the bot fail instead of answering with reduced context.
- **Recommended fix:** Make GitHub context best-effort. Catch context-fetch errors, capture them with useful tags, and return minimal context containing the trigger message and thread coordinates. Prefer `Promise.allSettled(...)` so one failed auxiliary call does not discard all available context.

### Medium: Public GitHub account-link links are not bound to the triggering GitHub user

- **Affected files/functions:** `apps/web/src/lib/bot/link-account.tsx`, `apps/web/src/lib/bot/github-link-token.ts`, `apps/web/src/app/github/link/route.ts`
- **Scenario/impact:** The public link posted in an issue/PR contains only the platform integration and installation ID. Any Kilo user who is a member of the owning organization can click someone else's visible link and complete OAuth for their own GitHub account. This likely does not hijack the original commenter because the callback links the OAuth-authenticated GitHub user ID, but it is an unintended enrollment path and can make public prompts misleading.
- **Recommended fix:** Human-verify the intended policy. If the link should only be usable by the triggering GitHub user, include that GitHub user ID in the signed token/state and verify it against the OAuth-authenticated GitHub user. If any org member may self-link from any prompt, update copy and tests to make that explicit.
