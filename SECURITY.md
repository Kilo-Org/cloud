# Security Review

## Findings

### Critical: Indirect prompt injection from GitHub context can drive privileged Cloud Agent actions

- **Affected files/functions:** `apps/web/src/lib/bot/conversation-context.ts` (`getGitHubConversationContext`, `formatGitHubItemBody`, `formatGitHubComment`, `formatGitHubReviewComment`), `apps/web/src/lib/bot/agent-runner.ts` (`buildSystemPrompt`, `runBotAgent`), `apps/web/src/lib/bot/tools/spawn-cloud-agent-session.ts` (`spawnCloudAgentSession`)
- **Issue:** The PR adds GitHub issue/PR descriptions, existing issue comments, review-thread comments, and diff hunks directly into the bot system prompt. The existing safety instruction only marks `<user_message>` and `<cloud_agent_result>` as untrusted, but the new content is wrapped in `<github_description>`, `<github_comment>`, `<github_review_comment>`, and `<github_diff_hunk>`.
- **Attack scenario:** An attacker who does not invoke the bot writes malicious instructions in a PR description, issue body, old issue comment, review comment, or code/diff hunk. A legitimate linked user later comments `@kilocode-bot fix this`. The bot fetches the attacker-controlled content as context and may follow instructions to spawn a Cloud Agent session, choose another repository, push changes, or reveal private context.
- **Impact:** This escalates attacker influence from writing discussion/code content to steering an authenticated linked user's bot run with installation-level repository credentials and Kilo org context.
- **Recommended fix:** Treat all GitHub-originated content as untrusted, including titles, bodies, comments, review comments, diff hunks, and filenames. Put untrusted GitHub context outside the system prompt when possible, and add a tool-call guard requiring repository/mode/task to be attributable to the triggering linked user's message or explicitly confirmed by that user. Add regression tests for malicious issue bodies, old comments, and diff hunks.

### High: GitHub invocation lacks repository-permission checks for the linked GitHub user

- **Affected files/functions:** `apps/web/src/lib/bot.ts` (`handleIncomingMessage`), `apps/web/src/lib/bot/platform-helpers.ts` (`getPlatformIdentity`, `getPlatformIntegration`), `apps/web/src/app/github/link/route.ts`, `apps/web/src/app/api/integrations/github/callback/route.ts`, `apps/web/src/lib/bot/tools/spawn-cloud-agent-session.ts`
- **Issue:** The linking flow verifies Kilo org/user ownership, but invocation only checks that the GitHub sender ID is linked to a Kilo user. It does not verify the sender's GitHub repository permission, collaborator status, org membership, or `author_association`.
- **Attack scenario:** A Kilo org member links a personal GitHub account with limited repo access. They comment where they are allowed to comment, but the bot uses broader Kilo GitHub installation privileges and can potentially spawn a Cloud Agent for repos the GitHub account cannot access.
- **Impact:** GitHub permission boundaries are not enforced. A commenter with a linked Kilo account may act using installation-level privileges instead of their actual GitHub permissions.
- **Recommended fix:** Before processing a GitHub mention, verify the sender's permission on the current repository using the installation token. Require appropriate permission by action type, re-check Kilo org membership at invocation time, and reject public-repo invocations that can act on private organization repos unless explicitly configured.

### High: Private repository inventory can be exposed in public GitHub replies

- **Affected files/functions:** `apps/web/src/lib/bot/agent-runner.ts` (`buildSystemPrompt`, `postSessionLinkEphemeral`), `apps/web/src/lib/slack-bot/github-repository-context.ts` (`formatGitHubRepositoriesForPrompt`), `apps/web/src/lib/bot/run.ts`, `apps/web/src/lib/bot/tools/spawn-cloud-agent-session.ts`
- **Issue:** The system prompt includes available repositories for the integration, including private repository names marked `(private)`. GitHub bot responses are posted back into GitHub threads, which may be public.
- **Attack scenario:** A linked user in a public repo asks what repos the bot can access, or prompt injection in issue/PR content instructs the model to list private repos. The model can reveal repository names from the prompt into a public GitHub comment.
- **Impact:** Private repository names and metadata can leak to public GitHub users. Repo names alone can expose confidential projects, customers, acquisitions, vulnerabilities, or internal architecture.
- **Recommended fix:** For GitHub invocations, scope repository context to the current repository unless the destination is known private and the sender is authorized. Do not include installation-wide private repo inventory in prompts that can produce public comments. Verify `@chat-adapter/github` behavior for `postEphemeral`; if it posts normal comments or cannot guarantee privacy, do not post sensitive session links through it.

### High: Suspended GitHub integrations can still reach the bot path

- **Affected files/functions:** `apps/web/src/app/api/webhooks/github/route.ts`, `apps/web/src/lib/integrations/platforms/github/webhook-handler.ts`, `apps/web/src/lib/bot.ts`, `apps/web/src/lib/bot/platform-helpers.ts` (`getPlatformIntegration`)
- **Issue:** The webhook route schedules `bot.webhooks.github(...)` independently of the legacy `handleGitHubWebhook` result. The legacy path checks whether an integration is suspended, but the bot path only looks up by installation ID and does not filter `suspended_at`.
- **Attack scenario:** A suspended integration receives a GitHub mention. The legacy path may skip, while the chat adapter still emits `onNewMention` and `handleIncomingMessage` processes it.
- **Impact:** Suspension may not stop GitHub bot runs or Cloud Agent sessions.
- **Recommended fix:** Gate the bot adapter path on the same active-integration and suspension checks as the legacy handler. Make `getPlatformIntegration` return only active integrations or explicitly reject suspended integrations in `handleIncomingMessage`.

### Medium: GitHub webhooks can trigger duplicate privileged actions through legacy and bot paths

- **Affected files/functions:** `apps/web/src/app/api/webhooks/github/route.ts`, `apps/web/src/lib/integrations/platforms/github/webhook-handler.ts`, `apps/web/src/lib/integrations/platforms/github/webhook-handlers/installation-handler.ts`, `apps/web/src/lib/bot.ts`
- **Issue:** Every GitHub webhook goes to both the existing GitHub integration handler and the new chat adapter. `pull_request_review_comment` events may trigger legacy auto-fix and the new mention handler. The legacy path has webhook dedupe; the new bot path does not appear to share that idempotency.
- **Attack scenario:** A review comment mentioning Kilo triggers both flows, or a GitHub retry repeats the bot path.
- **Impact:** Duplicate agent sessions can cause repeated writes, comments, billing, and amplified prompt-injection impact.
- **Recommended fix:** Decide a single owner for each event. Share webhook delivery dedupe keyed by `x-github-delivery`, filter the bot adapter to needed event types/actions, or migrate legacy auto-fix behind the new adapter.

### Medium: Public GitHub account-link token is not bound to the GitHub commenter or repository

- **Affected files/functions:** `apps/web/src/lib/bot/link-account.tsx`, `apps/web/src/lib/bot/github-link-token.ts`, `apps/web/src/app/github/link/route.ts`, `apps/web/src/app/api/integrations/github/callback/route.ts`
- **Issue:** The public link token binds only `platformIntegrationId` and `installationId`. It does not bind the original GitHub sender, repo, issue/PR, intended Kilo user, or intended GitHub login/id.
- **Attack scenario:** An unlinked user mentions the bot in a public issue. A different Kilo org member sees the public link and links their own GitHub account to that installation within the TTL.
- **Impact:** This likely does not let a completely unauthenticated external user run the bot, but it weakens identity binding and combines dangerously with missing repo-permission checks.
- **Recommended fix:** Include the original GitHub sender ID, repository, and issue/PR coordinates in the signed token and OAuth state. Require the OAuth-authenticated GitHub user ID to match the original sender. Prefer one-time server-side nonces for public GitHub comments.

### Medium: Linked GitHub users are not revalidated against Kilo organization membership at invocation time

- **Affected files/functions:** `apps/web/src/app/github/link/route.ts`, `apps/web/src/app/api/integrations/github/callback/route.ts`, `apps/web/src/lib/bot.ts`, `apps/web/src/lib/bot-identity.ts`
- **Issue:** Kilo org membership is checked during linking, then a persisted Redis mapping from GitHub user ID to Kilo user ID is trusted later. `handleIncomingMessage` only checks that the Kilo user exists.
- **Attack scenario:** A user links while they are an org member, is later removed, but keeps invoking the GitHub bot through the stale link.
- **Impact:** Former org members may retain bot access to organization GitHub integrations.
- **Recommended fix:** Re-check Kilo organization membership at every invocation. If no longer valid, delete the bot identity mapping and deny access or require relinking.

### Medium: GitHub context fetch trusts adapter thread coordinates without checking selected repos

- **Affected files/functions:** `apps/web/src/lib/bot/conversation-context.ts` (`parseGitHubThreadId`, `getGitHubConversationContext`)
- **Issue:** The bot parses owner/repo/issue coordinates from `thread.id` and uses the installation token to fetch context, but does not verify that the repository is selected/allowed for the resolved integration.
- **Attack scenario:** A malformed adapter event or unexpected thread ID points at a different repo accessible to the installation token. The bot fetches private issue/PR content and injects it into prompt context.
- **Impact:** Repository-to-repository context leakage inside an installation, and larger blast radius if combined with wrong integration lookup.
- **Recommended fix:** Verify parsed `owner/repo` against the integration's selected repositories before fetching context. Prefer immutable webhook metadata over parsing security-relevant coordinates from thread IDs.

## Human Verification Items

- Verify `@chat-adapter/github` independently validates `x-hub-signature-256` before emitting events.
- Verify exactly which GitHub events become `onNewMention` events, especially issue bodies, edited comments, PR descriptions, review comments, and non-comment events.
- Verify `Thread.postEphemeral` behavior for GitHub. If it posts public comments or exposes session URLs, treat session links as public.
- Verify whether Cloud Agent session URLs require authorization and whether URL possession reveals metadata.

## Positive Notes

- The GitHub callback requires signed OAuth `state` and checks the authenticated Kilo user matches the state user ID.
- The callback exchanges a GitHub OAuth code and links the returned GitHub user ID rather than trusting a query parameter.
- `/api/chat/link-account` rejects GitHub identities, avoiding reuse of Slack's serialized-message link flow.
- GitHub link token and OAuth state are HMAC-signed and short-lived.
