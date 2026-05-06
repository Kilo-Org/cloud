# Cross-Platform State Leak Review

## Overall Conclusion

I did not find a confirmed direct Slack-to-GitHub identity leak in the normal happy path. The new code generally separates Slack and GitHub by platform:

- Bot identity Redis keys include `platform` via `identity:${platform}:${teamId}:${userId}`.
- Slack account linking still uses ephemeral `/api/chat/link-account` prompts.
- GitHub account linking uses a separate public `/github/link` OAuth flow.
- `getPlatformContext()` switches on `thread.adapter.name`, so Slack channel context is not intentionally included in GitHub prompts.
- Slack uninstall cleanup and GitHub installation delete cleanup both pass the platform into `unlinkTeamKiloUsers()`.

The main risks are places where GitHub state is selected or replayed using only shared identifiers such as installation ID or thread ID. These can cross boundaries if duplicate rows, corrupted bot request rows, stale tokens, or adapter bugs occur.

## Findings

### High: GitHub integration lookup is scoped only by installation ID, while duplicate installation rows may be possible

- **Affected files/functions:** `apps/web/src/lib/bot/platform-helpers.ts` (`getPlatformIntegration`), `apps/web/src/lib/integrations/db/platform-integrations.ts` (`findIntegrationByInstallationId`), `apps/web/src/app/github/link/route.ts`, `apps/web/src/app/api/integrations/github/callback/route.ts`, `packages/db/src/schema.ts` (`platform_integrations`)
- **Leak scenario:** Slack integrations have a global unique index on `(platform, platform_installation_id)`, but GitHub integrations appear to have owner-scoped unique indexes. `getPlatformIntegration(identity)` and `findIntegrationByInstallationId(PLATFORM.GITHUB, installationId)` query only by platform and installation ID, then use `.limit(1)`. The bot identity key is also only `identity:github:${installationId}:${githubUserId}`.
- **What would happen:** If the same GitHub installation ID exists for multiple Kilo owners, a GitHub mention can resolve to an arbitrary integration row. GitHub issue context comes from the real installation, but repository lists, profile config, org ID, billing/ownership, and Cloud Agent context can come from the wrong Kilo owner.
- **Impact:** Cross-tenant state leak across Kilo owners for GitHub bot requests, including possible wrong-owner Cloud Agent sessions.
- **Recommended fix:** Prefer a global unique constraint for active GitHub installation IDs if one GitHub App installation belongs to exactly one Kilo owner. If duplicates are valid, carry `platformIntegrationId` through the GitHub adapter/linking flow and key bot identity by `platformIntegrationId`, not only installation ID. Replace installation-only lookups with exact integration lookups.
- **Human verification:** Confirm whether duplicate active GitHub `platform_installation_id` rows are possible in production.

### Medium: Bot session callbacks reconstruct the posting adapter from `platform_thread_id` without validating it matches the stored integration platform

- **Affected files/functions:** `apps/web/src/app/api/internal/bot-session-callback/[botRequestId]/route.ts` (`POST`, `postBotThreadMessage`, `continueBotAgentAfterCallback`), `apps/web/src/lib/bot/run.ts`, `apps/web/src/lib/bot/request-logging.ts`
- **Leak scenario:** `processLinkedMessage()` stores `platform: thread.adapter.name` and `platform_thread_id: thread.id`. The callback later loads `platformIntegration` from `platform_integration_id`, then reconstructs the destination with `bot.thread(requestRow.platform_thread_id)`. There is no assertion that `requestRow.platform`, `platformIntegration.platform`, and the reconstructed thread adapter all match.
- **What would happen:** A corrupted or malformed bot request row could post a Slack-originated Cloud Agent result to a GitHub thread, or a GitHub-originated result through Slack context, while billing/logging/owner context comes from another platform.
- **Impact:** Cross-platform callback leakage is possible if persisted bot request state becomes inconsistent. This is probably not externally reachable in the normal path, but the callback endpoint trusts persisted state too much.
- **Recommended fix:** Before posting, assert `requestRow.platform === platformIntegration.platform`, `bot.thread(...).adapter.name === requestRow.platform`, and `bot.thread(...).adapter.name === platformIntegration.platform`. Fail closed and mark the bot request errored if values differ.

### Medium: GitHub context fetch trusts repo coordinates from `thread.id` and does not validate them against the resolved integration

- **Affected files/functions:** `apps/web/src/lib/bot/conversation-context.ts` (`parseGitHubThreadId`, `getGitHubConversationContext`)
- **Leak scenario:** The bot parses owner/repo/issue from `thread.id`, generates an installation token from the resolved integration, and fetches issue/PR content without verifying the repo belongs to that integration's selected repositories.
- **What would happen:** If a malformed thread ID is accepted, the bot can fetch context for any repository accessible to the installation token. The fetched content is injected into the prompt.
- **Impact:** Repository-to-repository context leakage inside the same GitHub installation, or cross-owner leakage if combined with wrong integration lookup.
- **Recommended fix:** Validate parsed `owner/repo` against `platformIntegration.repositories` before GitHub API calls. Prefer adapter-provided immutable webhook metadata over security-relevant parsing from `thread.id`.

### Medium: Public GitHub link token and OAuth state are not bound tightly enough to one integration row

- **Affected files/functions:** `apps/web/src/lib/bot/link-account.tsx` (`buildGitHubLinkUrl`), `apps/web/src/lib/bot/github-link-token.ts`, `apps/web/src/app/github/link/route.ts`, `apps/web/src/lib/bot/github-link-state.ts`, `apps/web/src/app/api/integrations/github/callback/route.ts`
- **Leak scenario:** The public token contains `platformIntegrationId` and `installationId`. `/github/link` checks access to `platformIntegrationId`, but does not verify `verifiedToken.installationId === integration.platform_installation_id`. The OAuth state carries only `userId` and `installationId`, and the callback resolves the integration again by installation ID only.
- **What would happen:** With stale/mismatched tokens or duplicate installation rows, the user can be authorized against one integration row and linked against another row selected by installation ID.
- **Impact:** Account-link state can drift away from the integration row that produced the link prompt.
- **Recommended fix:** In `/github/link`, reject tokens where `integration.platform !== 'github'` or installation IDs do not match. Include `platformIntegrationId` in OAuth state, load the same integration by ID in the callback, and use one-time link tokens for public comments.

### Low: Cloud Agent `createdOnPlatform` is derived from `thread.id` instead of adapter identity

- **Affected files/functions:** `apps/web/src/lib/bot/agent-runner.ts` (`runBotAgent`)
- **Leak scenario:** `const chatPlatform = params.thread.id.split(':')[0];` is used while other code correctly uses `thread.adapter.name`.
- **What would happen:** A malformed or unexpected thread ID could mislabel session metadata.
- **Impact:** Mostly analytics/session attribution leakage now, but could become more serious if downstream logic later gates behavior on `createdOnPlatform`.
- **Recommended fix:** Use `params.thread.adapter.name` and optionally assert known thread ID prefixes match the adapter.

## Safeguards Observed

- `apps/web/src/lib/redis-keys.ts` includes platform in bot identity keys, preventing direct Slack/GitHub key collisions.
- `apps/web/src/app/api/chat/link-account/route.ts` rejects GitHub identities so public GitHub links cannot use the Slack reprocess flow.
- `apps/web/src/lib/bot/conversation-context.ts` separates Slack and GitHub context builders by `thread.adapter.name`.
- `apps/web/src/lib/bot/link-account.tsx` uses ephemeral prompts for Slack and public OAuth prompts for GitHub.
- `apps/web/src/lib/integrations/platforms/github/webhook-handlers/installation-handler.ts` deletes GitHub bot identity links using `PLATFORM.GITHUB`, so it should not delete Slack links for a numerically identical team/installation ID.
