# Tests Review

## Overall Assessment

The PR adds substantial coverage for the GitHub bot adapter flow. Route-level tests cover many auth, access-control, and redirect cases, and conversation-context tests are likely to catch regressions in formatting and pagination.

The main gaps are security-critical token/state helpers, installation deletion cleanup, non-GitHub regressions after the context refactor, and end-to-end linking compatibility. Several tests are heavily mocked at module boundaries, which makes them useful for routing assertions but less effective at catching integration regressions.

## Findings

### High: Security token helpers have no direct tests

- **Affected files:** `apps/web/src/lib/bot/github-link-token.ts`, `apps/web/src/lib/bot/github-link-state.ts`, `apps/web/src/app/github/link/route.test.ts`, `apps/web/src/app/api/integrations/github/callback/route.test.ts`
- **Issue:** The signed GitHub link token and OAuth state helpers are security-critical, but route tests mock `verifyGitHubLinkToken`, `createGitHubBotLinkState`, and `verifyGitHubBotLinkState` instead of exercising the real HMAC, TTL, payload validation, and tamper detection.
- **Why it matters:** Regressions in signature generation, expiry handling, malformed payload rejection, missing-field validation, or future-dated token rejection would not be caught.
- **Recommended improvement:** Add direct unit tests for both helper files covering round-trip creation/verification, tampered payload, tampered signature, missing fields, expired tokens, future `iat`, malformed base64/JSON, empty IDs, and unsafe callback paths. Use fake timers for TTL behavior.

### High: Installation deletion identity cleanup is untested

- **Affected files:** `apps/web/src/lib/integrations/platforms/github/webhook-handlers/installation-handler.ts`, `apps/web/src/lib/integrations/platforms/github/webhook-handler.test.ts`
- **Issue:** The PR adds a side effect on GitHub installation deletion: initialize the bot and call `unlinkTeamKiloUsers`. The new webhook tests mock `handleInstallationDeleted`, so they cannot verify this behavior.
- **Why it matters:** If uninstall no longer removes linked GitHub identities, users could remain linked to an installation that no longer exists.
- **Recommended improvement:** Add focused tests for `handleInstallationDeleted` using the real handler with mocked DB, `bot.initialize`, `bot.getState`, `unlinkTeamKiloUsers`, and Sentry. Assert correct platform and installation ID, and assert unlink failures are captured without preventing existing deletion flow.

### Medium: Conversation-context refactor lacks non-GitHub regression coverage

- **Affected files:** `apps/web/src/lib/bot/conversation-context.test.ts`, `apps/web/src/lib/bot/conversation-context.ts`
- **Issue:** New tests cover GitHub context, but the refactor also replaced the old platform-agnostic context path with `getPlatformContext`. There are no tests for Slack or generic adapters in the new suite.
- **Why it matters:** Existing Slack behavior could regress without detection, including channel metadata, message ordering, trigger-message filtering, delimiter sanitization, DM/channel labeling, and fetch-failure behavior.
- **Recommended improvement:** Add Slack and generic-adapter tests using fake `Thread`/`Channel` objects. Assert expected metadata, trigger exclusion, chronological ordering, sanitization, and empty-string fallback.

### Medium: Webhook route tests codify broad bot dispatch but do not test failure isolation

- **Affected files:** `apps/web/src/app/api/webhooks/github/route.test.ts`
- **Issue:** Tests assert that installation and unrelated events are sent to the bot adapter, but they do not verify that adapter failures, thrown errors, or non-OK responses are isolated from the legacy webhook response.
- **Why it matters:** The route intentionally runs the bot adapter in `after()`. A regression that lets bot failures affect GitHub webhook acknowledgements could cause retries or interfere with existing integration handlers.
- **Recommended improvement:** Add tests where `bot.webhooks.github` rejects and where it returns a non-OK response. Assert `POST` still returns the legacy handler response and Sentry/logging is called.

### Medium: Route tests are heavily mocked and miss end-to-end link-flow validation

- **Affected files:** `apps/web/src/app/github/link/route.test.ts`, `apps/web/src/app/api/integrations/github/callback/route.test.ts`, `apps/web/src/lib/bot/link-account.test.ts`
- **Issue:** The GitHub account-link flow is tested through isolated route mocks, but there is no test that stitches together real token creation, `/github/link`, OAuth state creation, callback verification, and `linkKiloUser`.
- **Why it matters:** Tests can pass even if the token payload shape, OAuth state payload shape, or installation handoff between routes is incompatible.
- **Recommended improvement:** Add an integration-style happy-path test using real `createGitHubLinkToken` and `createGitHubBotLinkState`, mocking only external dependencies such as auth, DB lookup, GitHub OAuth exchange, and chat state.

### Medium: Callback access-control tests miss user-owned integration cases

- **Affected file:** `apps/web/src/app/api/integrations/github/callback/route.test.ts`
- **Issue:** Callback tests cover organization-owned integration success and membership rejection, but not user-owned integration success or rejection.
- **Why it matters:** The callback route has separate logic for `owned_by_user_id`. A regression could link a GitHub user to the wrong Kilo user or reject legitimate user-owned installs.
- **Recommended improvement:** Add tests where `owned_by_user_id === user.id` succeeds and `owned_by_user_id !== user.id` returns 403 without calling OAuth exchange or `linkKiloUser`.

### Low: GitHub webhook handler test name is misleading

- **Affected file:** `apps/web/src/lib/integrations/platforms/github/webhook-handler.test.ts`
- **Issue:** A test name says non-created `issue_comment` events are acknowledged without invoking the bot, but `handleGitHubWebhook` does not invoke the bot adapter; bot dispatch happens in the route layer.
- **Why it matters:** The name suggests coverage this file cannot provide.
- **Recommended improvement:** Rename the test to say it does not invoke legacy handlers, or add route-level coverage for bot adapter dispatch.

### Low: Documentation URL test locks in a placeholder for GitHub

- **Affected file:** `apps/web/src/lib/bot/platform-helpers.test.ts`
- **Issue:** The GitHub documentation URL expectation is the Slack URL.
- **Why it matters:** This may be intentional while GitHub docs are unavailable, but the test now codifies the placeholder.
- **Recommended improvement:** If intentional, make the test name/copy explicit. Otherwise, update implementation and test to expect a GitHub-specific docs URL.
