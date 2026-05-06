# Code Quality Review

## Findings

### High: GitHub bot support is wired only to the standard GitHub App despite lite handling elsewhere

- **Affected files/functions:** `apps/web/src/lib/bot.ts` (`githubAdapter` initialization), `apps/web/src/app/api/webhooks/github/route.ts`, `apps/web/src/app/api/webhooks/github-lite/route.ts`, `apps/web/src/app/github/link/route.ts`, `apps/web/src/app/api/integrations/github/callback/route.ts`
- **Issue:** The bot adapter is always created from `getGitHubAppCredentials('standard')`, and only `/api/webhooks/github` forwards requests to `bot.webhooks.github`. Account linking explicitly supports `integration.github_app_type ?? 'standard'`, including `lite`.
- **Risk:** Users can link through a lite integration, but lite webhooks never reach the chat adapter and the adapter has no lite credentials. Mention ingestion and linking have inconsistent app-type support.
- **Recommended fix:** Either make GitHub bot support standard-only and block/link-message lite integrations, or instantiate/route a separate GitHub adapter for lite credentials. Mirror standard bot routing in `apps/web/src/app/api/webhooks/github-lite/route.ts` or add an adapter-selection layer keyed by `github_app_type`.

### Medium: GitHub context API failures can fail the entire bot run

- **Affected files/functions:** `apps/web/src/lib/bot/conversation-context.ts` (`getGitHubConversationContext`), `apps/web/src/lib/bot/agent-runner.ts` (`buildSystemPrompt`)
- **Issue:** `getGitHubConversationContext` calls `issues.get`, `issues.listComments`, and `pulls.listReviewComments` inside a single `Promise.all` without local error handling.
- **Risk:** A GitHub outage, rate limit, deleted issue/PR, missing permission, or malformed thread ID can reject prompt construction and prevent any bot response, even though reduced context would be enough to answer.
- **Recommended fix:** Treat GitHub context as best-effort. Use `Promise.allSettled` or local catches, capture errors with repository/thread metadata, and return partial context or an empty string.

### Medium: Webhook handler imports initialize the full bot and adapters as a side effect

- **Affected files/functions:** `apps/web/src/lib/integrations/platforms/github/webhook-handlers/installation-handler.ts`, `apps/web/src/lib/integrations/platforms/github/webhook-handler.ts`, `apps/web/src/lib/bot.ts`
- **Issue:** `installation-handler.ts` imports `bot` to call `bot.initialize()` and access bot state for `unlinkTeamKiloUsers`. Importing the generic GitHub webhook handler now initializes the full bot, Slack adapter, GitHub adapter, and standard GitHub credentials.
- **Risk:** This couples integration cleanup to chat runtime initialization and can break webhook handling if bot configuration is missing. It also increases side effects and dependency-cycle risk.
- **Recommended fix:** Avoid importing `bot` from integration handlers. `unlinkTeamKiloUsers` only needs a state adapter; create or inject chat state from a small state module, or move cleanup into a bot-owned path.

### Medium: All standard GitHub webhooks are forwarded to the chat adapter

- **Affected files/functions:** `apps/web/src/app/api/webhooks/github/route.ts`
- **Issue:** The route schedules `bot.webhooks.github(...)` for every standard GitHub webhook before the legacy handler determines event type/action. Tests lock in forwarding `installation` and `pull_request` events, even though the bot needs mention-capable comment events.
- **Risk:** Unnecessary work, noisy logs, doubled signature/body parsing, and broader future behavior if the adapter starts handling more event types.
- **Recommended fix:** Filter before forwarding. At minimum gate on `x-github-event` for `issue_comment` and `pull_request_review_comment`, and ideally require `action === 'created'`.

### Medium: GitHub link routes duplicate unsafe HTML response construction

- **Affected files/functions:** `apps/web/src/app/github/link/route.ts` (`errorPage`), `apps/web/src/app/api/integrations/github/callback/route.ts` (`htmlPage`, `handleGitHubBotLinkCallback`)
- **Issue:** Two routes manually build full HTML pages with duplicated inline styles and string interpolation. The callback interpolates `githubUser.login` directly into HTML.
- **Risk:** GitHub logins are constrained today, but the helper is general-purpose and easy to reuse unsafely later. Duplicated page construction makes escaping and response behavior harder to keep consistent.
- **Recommended fix:** Centralize minimal HTML responses in a shared helper that escapes interpolated text by default and only allows explicitly trusted HTML fragments.

### Low: Token/state verification relies on `as` casts instead of schema validation

- **Affected files/functions:** `apps/web/src/lib/bot/github-link-token.ts` (`verifyGitHubLinkToken`), `apps/web/src/lib/bot/github-link-state.ts` (`verifyGitHubBotLinkState`)
- **Issue:** Both verifiers parse JSON as `Partial<...>` using `as`, then manually check fields. This conflicts with repo guidance to avoid casts when possible.
- **Risk:** Manual validation can drift from payload types as fields are added.
- **Recommended fix:** Define Zod schemas for both payloads and parse decoded JSON with `safeParse`, returning `null` on validation failure.

### Low: Slack-specific documentation URL is returned for GitHub

- **Affected files/functions:** `apps/web/src/lib/bot/platform-helpers.ts` (`getBotDocumentationUrl`), `apps/web/src/lib/bot/platform-helpers.test.ts`
- **Issue:** `getBotDocumentationUrl(PLATFORM.GITHUB)` returns the Slack documentation URL, and the test locks in that behavior.
- **Risk:** GitHub users asking for help receive Slack-specific docs.
- **Recommended fix:** Add a GitHub-specific docs URL or a platform-neutral bot docs URL. Update the test to assert the intended fallback.

### Low: GitHub platform identity extraction remains coupled to Slack-specific cast patterns

- **Affected files/functions:** `apps/web/src/lib/bot/platform-helpers.ts` (`getPlatformIdentity`)
- **Issue:** The Slack branch still casts `message as Message<SlackEvent>` to call `getSlackTeamId`. This helper is now the cross-platform identity boundary.
- **Risk:** As more adapters are added, it becomes easier to access raw payloads with the wrong shape.
- **Recommended fix:** Add type guards or delegate to adapter-specific identity extractors with typed inputs.

### Low: Manual GitHub thread ID parsing is tightly coupled to adapter internals

- **Affected files/functions:** `apps/web/src/lib/bot/conversation-context.ts` (`parseGitHubThreadId`, `getGitHubConversationContext`)
- **Issue:** GitHub context depends on hard-coded thread ID formats such as `github:owner/repo:issue:number` and `github:owner/repo:number:rc:id`.
- **Risk:** If `@chat-adapter/github` changes thread ID format, context silently disappears or fetches wrong coordinates.
- **Recommended fix:** Prefer adapter-provided metadata/raw payload fields. If manual parsing is unavoidable, isolate it in a compatibility module with explicit tests and documentation.
